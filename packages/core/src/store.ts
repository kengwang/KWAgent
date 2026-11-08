import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { executionOrigin } from './execution.ts';
import {
  asJson, ConflictError, EvidenceError, PersistenceError, eventSchema, extensionSchema, memorySchema, now,
  operationSchema, planSchema, roleInputSchema, roleSchema, mediaSchema,
} from './types.ts';
import type { EventInput, Experience, Extension, Json, LifePlan, Media, Memory, MemoryInput, Operation, Recall, Revision, Role, RoleInput } from './types.ts';

export const SCHEMA_VERSION = 4;
type Row = Record<string, unknown>;
function decode<T>(row: Row | undefined, schema: z.ZodType<T>): T | undefined {
  if (!row) return undefined;
  try { return schema.parse(JSON.parse(z.string().parse(row.body))); }
  catch (cause) { if (cause instanceof z.ZodError || cause instanceof SyntaxError) throw new PersistenceError('持久记录格式损坏或不兼容', { cause }); throw cause; }
}

/** 同一数据库拥有原始经历、版本和记忆，变更通知只在提交后发送。 */
export class Store {
  readonly db: DatabaseSync;
  readonly changes = new EventEmitter();
  private depth = 0;
  private changed = false;
  private closed = false;
  private readonly invocations = new WeakMap<symbol, string>();

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000');
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
    if (version > SCHEMA_VERSION) throw new Error(`数据库版本 ${version} 超过当前支持的 ${SCHEMA_VERSION}`);
    if (version === 0) this.migrate();
    if (version === 1) this.db.prepare('VACUUM INTO ?').run(`${path}.schema1-${Date.now()}-${randomUUID()}.sqlite`);
    if (version < 2) this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE payloads(id TEXT NOT NULL,role_id TEXT NOT NULL,bytes INTEGER NOT NULL,mime TEXT NOT NULL,source TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(id,role_id,source));
      CREATE TABLE perception_frames(id TEXT PRIMARY KEY,role_id TEXT NOT NULL,message_id TEXT UNIQUE NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),created_at TEXT NOT NULL);
      CREATE TABLE activity_links(activity_id TEXT NOT NULL,kind TEXT NOT NULL,target_id TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),PRIMARY KEY(activity_id,kind,target_id));
      CREATE INDEX activity_targets ON activity_links(kind,target_id);
      CREATE TABLE consolidation_chunks(event_id TEXT NOT NULL REFERENCES events(id),part INTEGER NOT NULL,total INTEGER NOT NULL,digest TEXT NOT NULL,completed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(event_id,part));
      PRAGMA user_version=2;
      COMMIT;
    `);
    if (version === 2) this.db.prepare('VACUUM INTO ?').run(`${path}.schema2-${Date.now()}-${randomUUID()}.sqlite`);
    if (version < 3) this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS continuity_sources(record_id TEXT NOT NULL,source_id TEXT NOT NULL,PRIMARY KEY(record_id,source_id));
      CREATE INDEX IF NOT EXISTS continuity_source_lookup ON continuity_sources(source_id,record_id);
      CREATE INDEX IF NOT EXISTS continuity_kind ON documents(role_id,json_extract(body,'$.data.kind'),updated_at,id) WHERE kind='continuity';
      CREATE INDEX IF NOT EXISTS continuity_scene ON documents(role_id,json_extract(body,'$.data.context.scene'),json_extract(body,'$.data.context.peerId')) WHERE kind='continuity';
      PRAGMA user_version=3;
      COMMIT;
    `);
    if (version === 3) this.db.prepare('VACUUM INTO ?').run(`${path}.schema3-${Date.now()}-${randomUUID()}.sqlite`);
    if (version < 4) this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE INDEX IF NOT EXISTS live_roles ON documents(updated_at,id) WHERE kind='role' AND json_extract(body,'$.deletedAt') IS NULL;
      PRAGMA user_version=4;
      COMMIT;
    `);
  }

  private migrate(): void {
    this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE documents(kind TEXT NOT NULL,id TEXT NOT NULL,role_id TEXT,revision INTEGER NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),updated_at TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE INDEX documents_role ON documents(kind,role_id,updated_at);
      CREATE TABLE revisions(seq INTEGER PRIMARY KEY,entity TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,actor TEXT NOT NULL,reason TEXT NOT NULL,body TEXT NOT NULL,time TEXT NOT NULL,UNIQUE(entity,id,revision));
      CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,dedup TEXT UNIQUE,account_id TEXT NOT NULL,role_id TEXT,scene TEXT,peer_id INTEGER,sender_id INTEGER,message_seq INTEGER,self INTEGER NOT NULL,source TEXT NOT NULL,type TEXT NOT NULL,occurred_at TEXT NOT NULL,received_at TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),activity_id TEXT,consolidated INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX events_role ON events(role_id,seq);
      CREATE INDEX events_message ON events(account_id,scene,peer_id,message_seq);
      CREATE TABLE event_delivery(event_id TEXT PRIMARY KEY REFERENCES events(id),message_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('prepared','delivered','completed')),updated_at TEXT NOT NULL);
      CREATE TABLE memory_rows(rowid INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,role_id TEXT NOT NULL);
      CREATE VIRTUAL TABLE memory_fts USING fts5(title,content,aliases,tokenize='trigram');
      CREATE TABLE memory_sources(memory_id TEXT NOT NULL,source_id TEXT NOT NULL,PRIMARY KEY(memory_id,source_id));
      CREATE TABLE cursors(account_id TEXT NOT NULL,scene TEXT NOT NULL,peer_id INTEGER NOT NULL,live_seq INTEGER NOT NULL,confirmed_seq INTEGER NOT NULL,initialized INTEGER NOT NULL,PRIMARY KEY(account_id,scene,peer_id));
      CREATE TABLE usage(role_id TEXT NOT NULL,day TEXT NOT NULL,requests INTEGER NOT NULL,tokens INTEGER NOT NULL,PRIMARY KEY(role_id,day));
      CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT INTO meta VALUES('revision','0');
      PRAGMA user_version=1;
      COMMIT;
    `);
  }

  transaction<T>(action: () => T): T {
    if (this.depth) return action();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const result = action();
      this.db.exec('COMMIT');
      this.depth--;
      if (this.changed) { this.changed = false; this.changes.emit('change', this.revision()); }
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.depth--;
      this.changed = false;
      throw error;
    }
  }

  private touch(): void {
    this.db.prepare("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run();
    if (this.depth) this.changed = true;
    else this.changes.emit('change', this.revision());
  }
  revision(): number { return Number(this.db.prepare("SELECT value FROM meta WHERE key='revision'").get()?.value); }
  invocationId(token: symbol): string { let id = this.invocations.get(token); if (!id) { id = randomUUID(); this.invocations.set(token, id); } return id; }
  meta(key: string): string | undefined { const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key); return row ? z.string().parse(row.value) : undefined; }
  setMeta(key: string, value: string): void { this.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); this.touch(); }

  get<T>(kind: string, id: string, schema: z.ZodType<T>): T | undefined {
    return decode(this.db.prepare('SELECT body FROM documents WHERE kind=? AND id=?').get(kind, id), schema);
  }
  list<T>(kind: string, schema: z.ZodType<T>, roleId?: string, limit = 100, offset = 0): T[] {
    const live = kind === 'role' ? " AND json_extract(body,'$.deletedAt') IS NULL" : '';
    const rows = roleId === undefined
      ? this.db.prepare(`SELECT body FROM documents WHERE kind=?${live} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`).all(kind, limit, offset)
      : this.db.prepare(`SELECT body FROM documents WHERE kind=? AND role_id=?${live} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`).all(kind, roleId, limit, offset);
    return rows.map(row => decode(row, schema)!);
  }
  put(kind: string, id: string, roleId: string | null, value: Json, expectedRevision: number | null, actor: string, reason: string): void {
    this.transaction(() => {
      const current = this.db.prepare('SELECT body,revision FROM documents WHERE kind=? AND id=?').get(kind, id);
      if (expectedRevision === null ? Boolean(current) : Number(current?.revision) !== expectedRevision) {
        throw new ConflictError(current ? asJson(JSON.parse(z.string().parse(current.body))) : null);
      }
      const revision = expectedRevision === null ? 1 : expectedRevision + 1;
      const body = JSON.stringify(value);
      this.db.prepare('INSERT INTO documents VALUES(?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET role_id=excluded.role_id,revision=excluded.revision,body=excluded.body,updated_at=excluded.updated_at')
        .run(kind, id, roleId, revision, body, now());
      this.db.prepare('INSERT INTO revisions(entity,id,revision,actor,reason,body,time) VALUES(?,?,?,?,?,?,?)').run(kind, id, revision, actor, reason, body, now());
      const origin = executionOrigin.getStore();
      const activity = roleId && actor === roleId ? origin?.roleId === roleId ? origin.activityId : this.meta(`activity:${roleId}`) : undefined;
      if (activity && ['role', 'memory', 'plan', 'operation'].includes(kind)) this.link(activity, kind, `${id}:${revision}`, { id, revision });
      this.touch();
    });
  }
  history(entity: string, id: string, limit = 100, before?: number): Revision[] {
    return this.db.prepare('SELECT * FROM revisions WHERE entity=? AND id=? AND (? IS NULL OR revision<?) ORDER BY revision DESC LIMIT ?').all(entity, id, before ?? null, before ?? null, limit).map(row => ({
      entity, id, revision: Number(row.revision), actor: String(row.actor), reason: String(row.reason), value: asJson(JSON.parse(String(row.body))), time: String(row.time),
    }));
  }

  roles(): Role[] { return this.list('role', roleSchema, undefined, 10000); }
  role(id: string): Role { const role = this.get('role', id, roleSchema); if (!role || role.deletedAt) throw new Error(`角色不存在或已删除：${id}`); return role; }
  createRole(input: RoleInput): Role {
    const parsed = roleInputSchema.parse(input);
    const stamp = now();
    const role = roleSchema.parse({ ...parsed, persona: parsed.persona ?? parsed.initialPersona, selfState: parsed.selfState ?? '', sessionId: `kw-${parsed.id}-${randomUUID()}`, revision: 1, createdAt: stamp, updatedAt: stamp });
    this.validateBindings(role);
    this.transaction(() => { this.put('role', role.id, role.id, asJson(role), null, 'owner', '创建角色'); this.setMeta(`session-owner:${role.sessionId}`, role.id); this.setMeta('roles-generation', String(Number(this.meta('roles-generation') ?? 0) + 1)); });
    return role;
  }
  updateRole(id: string, patch: Partial<Role>, expectedRevision: number, actor: string, reason: string): Role {
    const current = this.role(id);
    const role = roleSchema.parse({ ...current, ...patch, id, accountId: current.accountId, sessionId: current.sessionId, deletedAt: current.deletedAt, initialPersona: current.initialPersona, revision: expectedRevision + 1, updatedAt: now() });
    this.validateBindings(role);
    this.put('role', id, id, asJson(role), expectedRevision, actor, reason);
    return role;
  }
  rotateRoleSession(id: string, sessionId: string, expectedRevision: number, accepted: string[], reason: string): Role {
    return this.transaction(() => {
      const role = this.role(id);
      const owner = this.meta(`session-owner:${sessionId}`);
      if (sessionId === role.sessionId || owner && owner !== id) throw new Error('新会话标识无效或已经属于其他角色');
      const changed = roleSchema.parse({ ...role, sessionId, revision: expectedRevision + 1, updatedAt: now() });
      this.put('role', id, id, asJson(changed), expectedRevision, 'owner', reason);
      this.db.prepare("UPDATE event_delivery SET state='completed',updated_at=? WHERE event_id IN (SELECT id FROM events WHERE role_id=?) AND state IN ('prepared','delivered') AND message_id IN (SELECT value FROM json_each(?))").run(now(), id, JSON.stringify(accepted));
      this.recoverDeliveries(id, []);
      // 新会话重新装配未接纳输入，旧感知正文继续保留审计。
      this.db.prepare("UPDATE event_delivery SET message_id=?||message_id,updated_at=? WHERE state='prepared' AND event_id IN (SELECT id FROM events WHERE role_id=?)").run(`reset:${sessionId}:`, now(), id);
      this.setMeta(`session-owner:${role.sessionId}`, id);
      this.setMeta(`session-owner:${sessionId}`, id);
      this.setMeta(`context-since:${id}`, String(this.db.prepare('SELECT coalesce(max(seq),0) seq FROM events WHERE role_id=?').get(id)!.seq));
      this.setMeta(`context-since-time:${id}`, now());
      this.setMeta(`wake:${id}`, '');
      this.setMeta(`activity:${id}`, '');
      this.appendEvent({ id: `reset:${sessionId}`, accountId: role.accountId, roleId: id, source: 'system', type: 'session-reset', occurredAt: now(), scene: null, peerId: null, senderId: null, messageSeq: null, self: false, payload: { previousSessionId: role.sessionId, sessionId, reason, instruction: '当前对话已切换至新会话。保留原有人格、长期记忆和角色安排；结合待处理事件决定接下来的活动。历史工具操作不自动重放。' } });
      return changed;
    });
  }
  deleteRole(id: string, expectedRevision: number): Role {
    return this.transaction(() => {
      const role = this.role(id);
      const deleted = roleSchema.parse({ ...role, state: 'stopped', groups: [], contacts: [], globalGroups: false, defaultPrivate: false, deletedAt: now(), revision: expectedRevision + 1, updatedAt: now() });
      this.put('role', id, id, asJson(deleted), expectedRevision, 'owner', '删除角色，保留历史归属');
      this.setMeta('roles-generation', String(Number(this.meta('roles-generation') ?? 0) + 1));
      this.setMeta(`wake:${id}`, '');
      return deleted;
    });
  }
  private validateBindings(role: Role): void {
    if (new Set(role.groups).size !== role.groups.length || new Set(role.contacts).size !== role.contacts.length) throw new Error('绑定列表中存在重复标识');
    for (const other of this.roles()) {
      if (other.id === role.id || other.accountId !== role.accountId) continue;
      if (role.globalGroups && other.globalGroups) throw new Error('账号已有全局群聊角色');
      if (role.defaultPrivate && other.defaultPrivate) throw new Error('账号已有默认私聊角色');
      if (role.groups.some(id => other.groups.includes(id)) || role.contacts.some(id => other.contacts.includes(id))) throw new Error(`会话已经绑定角色：${other.name}`);
    }
  }
  route(accountId: string, scene: string, peerId: number): string | null {
    const roles = this.roles().filter(role => role.accountId === accountId);
    const exact = roles.find(role => (scene === 'group' ? role.groups : role.contacts).includes(peerId));
    return exact?.id ?? roles.find(role => scene === 'group' ? role.globalGroups : role.defaultPrivate)?.id ?? null;
  }

  appendEvent(input: EventInput): { event: Experience; inserted: boolean } {
    return this.transaction(() => {
      const id = input.id ?? randomUUID();
      const dedup = input.source === 'milky' && input.messageSeq !== null
        ? `${input.accountId}:${input.scene}:${input.peerId}:${input.messageSeq}` : null;
      const inserted = this.db.prepare('INSERT OR IGNORE INTO events(id,dedup,account_id,role_id,scene,peer_id,sender_id,message_seq,self,source,type,occurred_at,received_at,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, dedup, input.accountId, input.roleId, input.scene, input.peerId, input.senderId, input.messageSeq, Number(input.self), input.source, input.type, input.occurredAt, now(), JSON.stringify(input.payload));
      const row = dedup ? this.db.prepare('SELECT * FROM events WHERE dedup=?').get(dedup) : this.db.prepare('SELECT * FROM events WHERE id=?').get(id);
      if (!row) throw new Error('事件提交后无法读取');
      if (inserted.changes) {
        if (input.messageSeq !== null && input.scene && input.peerId !== null) this.advanceLive(input.accountId, input.scene, input.peerId, input.messageSeq);
        this.touch();
      }
      return { event: this.eventFromRow(row), inserted: Boolean(inserted.changes) };
    });
  }
  private eventFromRow(row: Row): Experience {
    return eventSchema.parse({
      id: row.id, seq: row.seq, accountId: row.account_id, roleId: row.role_id,
      source: row.source, type: row.type, occurredAt: row.occurred_at, receivedAt: row.received_at,
      scene: row.scene, peerId: row.peer_id, senderId: row.sender_id, messageSeq: row.message_seq, self: Boolean(row.self),
      payload: JSON.parse(String(row.payload)), activityId: row.activity_id,
    });
  }
  events(roleId?: string, limit = 100, before?: number): Experience[] {
    return this.db.prepare('SELECT * FROM events WHERE (? IS NULL OR role_id=?) AND (? IS NULL OR seq<?) ORDER BY seq DESC LIMIT ?')
      .all(roleId ?? null, roleId ?? null, before ?? null, before ?? null, limit).map(row => this.eventFromRow(row));
  }
  peers(accountId: string, scene: string): number[] {
    return this.db.prepare("SELECT DISTINCT peer_id FROM events WHERE account_id=? AND scene=? AND source='milky' AND role_id IS NOT NULL AND peer_id IS NOT NULL").all(accountId, scene).map(row => Number(row.peer_id));
  }
  event(id: string): Experience { const row = this.db.prepare('SELECT * FROM events WHERE id=?').get(id); if (!row) throw new EvidenceError(`经历不存在：${id}`); return this.eventFromRow(row); }
  pending(roleId: string, limit = 50): Experience[] {
    return this.db.prepare("SELECT e.* FROM events e LEFT JOIN event_delivery d ON d.event_id=e.id WHERE e.role_id=? AND e.self=0 AND (d.state IS NULL OR d.state='prepared') ORDER BY e.seq LIMIT ?").all(roleId, limit).map(row => this.eventFromRow(row));
  }
  pendingBatch(roleId: string): { events: Experience[]; messageId?: string } {
    const pending = this.pending(roleId);
    if (!pending.length) return { events: [] };
    const delivery = (id: string) => this.db.prepare('SELECT message_id FROM event_delivery WHERE event_id=?').get(id)?.message_id;
    const messageId = delivery(pending[0]!.id);
    return { events: pending.filter(event => delivery(event.id) === messageId), ...(messageId ? { messageId: String(messageId) } : {}) };
  }
  delivery(ids: string[], messageId: string, state: 'prepared' | 'delivered' | 'completed'): void {
    this.transaction(() => { for (const id of ids) this.db.prepare("INSERT INTO event_delivery VALUES(?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET message_id=excluded.message_id,state=excluded.state,updated_at=excluded.updated_at WHERE event_delivery.state!='completed' AND NOT(event_delivery.state='delivered' AND excluded.state='prepared')").run(id, messageId, state, now()); this.touch(); });
  }
  hasDelivery(messageId: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM event_delivery WHERE message_id=? AND state!='prepared' LIMIT 1").get(messageId)); }
  deliveryStatus(id: string): { messageId: string | null; state: string } {
    const row = this.db.prepare('SELECT d.message_id,d.state,e.activity_id,e.self FROM events e LEFT JOIN event_delivery d ON d.event_id=e.id WHERE e.id=?').get(id);
    if (!row) throw new Error('经历不存在');
    return { messageId: row.message_id ? String(row.message_id) : null, state: row.state === 'completed' ? 'completed' : row.activity_id ? 'accepted' : row.state === 'delivered' ? 'queued' : row.state === 'prepared' ? 'prepared' : row.self ? 'observed' : 'pending' };
  }
  completeDelivered(roleId: string, accepted: string[]): void { if (this.db.prepare("UPDATE event_delivery SET state='completed',updated_at=? WHERE event_id IN (SELECT id FROM events WHERE role_id=?) AND state IN ('prepared','delivered') AND message_id IN (SELECT value FROM json_each(?))").run(now(), roleId, JSON.stringify(accepted)).changes) this.touch(); }
  recoverDeliveries(roleId: string, accepted: string[]): void {
    this.db.prepare("UPDATE event_delivery SET state='prepared',updated_at=? WHERE event_id IN (SELECT id FROM events WHERE role_id=?) AND state='delivered' AND message_id NOT LIKE 'filtered:%' AND message_id NOT IN (SELECT value FROM json_each(?))").run(now(), roleId, JSON.stringify(accepted));
    this.touch();
  }
  unprocessed(roleId: string, limit = 100): Experience[] { return this.db.prepare('SELECT * FROM events WHERE role_id=? AND consolidated=0 ORDER BY seq LIMIT ?').all(roleId, limit).map(row => this.eventFromRow(row)); }
  markConsolidated(ids: string[]): void { this.transaction(() => { for (const id of ids) this.db.prepare('UPDATE events SET consolidated=1 WHERE id=?').run(id); this.touch(); }); }
  migrateEvents(ids: string[], targetRoleId: string): void {
    this.role(targetRoleId);
    this.transaction(() => {
      for (const id of ids) {
        const event = this.event(id);
        if (event.activityId || this.db.prepare('SELECT 1 FROM event_delivery WHERE event_id=?').get(id) || this.db.prepare('SELECT 1 FROM memory_sources WHERE source_id=?').get(id) || this.db.prepare('SELECT 1 FROM continuity_sources WHERE source_id=?').get(id)) throw new Error('已经进入活动或认识依据的经历需要保留原始归属；可以向目标角色提供引用');
        this.db.prepare('UPDATE events SET role_id=? WHERE id=?').run(targetRoleId, id);
        this.appendEvent({ accountId: event.accountId, roleId: targetRoleId, source: 'system', type: 'experience-transfer', occurredAt: now(), scene: null, peerId: null, senderId: null, messageSeq: null, self: true, payload: asJson({ eventId: id, from: event.roleId, to: targetRoleId }) });
      }
      this.touch();
    });
  }

  cursor(accountId: string, scene: string, peerId: number) {
    const row = this.db.prepare('SELECT * FROM cursors WHERE account_id=? AND scene=? AND peer_id=?').get(accountId, scene, peerId);
    return row ? { live: Number(row.live_seq), confirmed: Number(row.confirmed_seq), initialized: Boolean(row.initialized) } : undefined;
  }
  private advanceLive(accountId: string, scene: string, peerId: number, seq: number): void {
    this.db.prepare('INSERT INTO cursors VALUES(?,?,?,?,0,0) ON CONFLICT(account_id,scene,peer_id) DO UPDATE SET live_seq=MAX(live_seq,excluded.live_seq)').run(accountId, scene, peerId, seq);
  }
  confirm(accountId: string, scene: string, peerId: number, seq: number): void {
    this.db.prepare('INSERT INTO cursors VALUES(?,?,?,?,?,1) ON CONFLICT(account_id,scene,peer_id) DO UPDATE SET confirmed_seq=MAX(confirmed_seq,excluded.confirmed_seq),initialized=1').run(accountId, scene, peerId, seq, seq);
    this.touch();
  }

  memory(id: string): Memory { const memory = this.get('memory', id, memorySchema); if (!memory) throw new EvidenceError(`记忆不存在：${id}`); return memory; }
  memories(roleId: string, limit = 100, offset = 0): Memory[] { return this.list('memory', memorySchema, roleId, limit, offset); }
  saveMemory(input: MemoryInput, expectedRevision: number | null, actor: string, reason: string): Memory {
    return this.transaction(() => {
      this.role(input.roleId);
      const id = input.id ?? randomUUID();
      const previous = this.get('memory', id, memorySchema);
      if (previous && previous.roleId !== input.roleId) throw new EvidenceError('记忆归属不能通过修订修改');
      if (input.people.some(identity => !/^[1-9][0-9]*$/.test(identity) && !previous?.people.includes(identity))) throw new EvidenceError('人物必须使用实际账号标识，昵称请保存到 aliases');
      this.validateSources(input.roleId, input.sources);
      const memory = memorySchema.parse({ ...input, id, revision: expectedRevision === null ? 1 : expectedRevision + 1, createdAt: previous?.createdAt ?? now(), updatedAt: now() });
      this.put('memory', id, input.roleId, asJson(memory), expectedRevision, actor, reason);
      this.db.prepare('INSERT OR IGNORE INTO memory_rows(id,role_id) VALUES(?,?)').run(id, input.roleId);
      const rowid = Number(this.db.prepare('SELECT rowid FROM memory_rows WHERE id=?').get(id)?.rowid);
      this.db.prepare('DELETE FROM memory_fts WHERE rowid=?').run(rowid);
      this.db.prepare('INSERT INTO memory_fts(rowid,title,content,aliases) VALUES(?,?,?,?)').run(rowid, memory.title, memory.content, [...memory.people, ...memory.aliases].join(' '));
      this.db.prepare('DELETE FROM memory_sources WHERE memory_id=?').run(id);
      for (const source of memory.sources) this.db.prepare('INSERT INTO memory_sources VALUES(?,?)').run(id, source);
      return memory;
    });
  }
  lexical(query: Recall): Memory[] {
    const conditions = ["d.kind='memory'", 'd.role_id=?', "json_extract(d.body,'$.archived')=?"];
    const values: (string | number)[] = [query.roleId, Number(query.archived)];
    if (query.kind) { conditions.push("json_extract(d.body,'$.kind')=?"); values.push(query.kind); }
    if (query.realm) { conditions.push("json_extract(d.body,'$.realm')=?"); values.push(query.realm); }
    if (query.since) { conditions.push('d.updated_at>=?'); values.push(query.since); }
    if (query.until) { conditions.push('d.updated_at<=?'); values.push(query.until); }
    if (query.person) { conditions.push("EXISTS(SELECT 1 FROM json_each(d.body,'$.people') WHERE value=?)"); values.push(query.person); }
    if (query.scene || query.peerId) {
      conditions.push("EXISTS(SELECT 1 FROM memory_sources ms JOIN events e ON e.id=ms.source_id WHERE ms.memory_id=d.id AND (?='' OR e.scene=?) AND (?=0 OR e.peer_id=?))");
      values.push(query.scene ?? '', query.scene ?? '', query.peerId ?? 0, query.peerId ?? 0);
    }
    let join = '';
    let order = 'd.updated_at DESC,d.id';
    if (query.query.length >= 3) {
      join = 'JOIN memory_rows r ON r.id=d.id JOIN memory_fts ON memory_fts.rowid=r.rowid';
      conditions.push('memory_fts MATCH ?'); values.push(`"${query.query.replaceAll('"', '""')}"`);
      order = 'bm25(memory_fts),d.id';
    } else if (query.query) {
      conditions.push("instr(json_extract(d.body,'$.title')||json_extract(d.body,'$.content')||json_extract(d.body,'$.aliases'),?)>0"); values.push(query.query);
    }
    return this.db.prepare(`SELECT d.body FROM documents d ${join} WHERE ${conditions.join(' AND ')} ORDER BY ${order} LIMIT ?`).all(...values, query.limit * 3)
      .map(row => memorySchema.parse(JSON.parse(String(row.body))));
  }
  rebuildSearch(): { count: number } {
    return this.transaction(() => {
      this.db.exec('DELETE FROM memory_fts');
      const records = this.db.prepare("SELECT d.body,r.rowid FROM documents d JOIN memory_rows r ON r.id=d.id WHERE d.kind='memory'").all();
      for (const row of records) {
        const memory = memorySchema.parse(JSON.parse(String(row.body)));
        this.db.prepare('INSERT INTO memory_fts(rowid,title,content,aliases) VALUES(?,?,?,?)').run(Number(row.rowid), memory.title, memory.content, [...memory.people, ...memory.aliases].join(' '));
      }
      this.touch();
      return { count: records.length };
    });
  }
  plans(roleId?: string): LifePlan[] { return this.list('plan', planSchema, roleId, 10000); }
  validateSources(roleId: string, sources: string[], allowPersona = true): void {
    if (!sources.length) throw new EvidenceError('必须提供真实来源');
    for (const source of sources) {
      if (allowPersona && source === `role:${roleId}`) continue;
      const event = this.db.prepare('SELECT role_id FROM events WHERE id=?').get(source);
      const operation = this.get('operation', source, operationSchema);
      if (event?.role_id !== roleId && operation?.roleId !== roleId) throw new EvidenceError(`来源不存在或不属于当前角色：${source}；请使用输入中真实存在且属于当前角色的来源标识`);
    }
  }
  frame(messageId: string): Json | undefined { const row = this.db.prepare('SELECT body FROM perception_frames WHERE message_id=?').get(messageId); return row ? asJson(JSON.parse(String(row.body))) : undefined; }
  saveFrame(id: string, roleId: string, messageId: string, body: Json): Json {
    return this.transaction(() => {
      const existing = this.frame(messageId); if (existing !== undefined) return existing;
      this.db.prepare('INSERT INTO perception_frames VALUES(?,?,?,?,?)').run(id, roleId, messageId, JSON.stringify(body), now()); this.touch(); return body;
    });
  }
  link(activityId: string, kind: string, targetId: string, body: Json = null): void { this.db.prepare('INSERT INTO activity_links VALUES(?,?,?,?) ON CONFLICT(activity_id,kind,target_id) DO UPDATE SET body=excluded.body').run(activityId, kind, targetId, JSON.stringify(body)); this.touch(); }
  links(activityId: string, limit = 50, offset = 0): Json[] { return this.db.prepare('SELECT kind,target_id,body FROM activity_links WHERE activity_id=? ORDER BY rowid LIMIT ? OFFSET ?').all(activityId, limit, offset).map(row => ({ kind: String(row.kind), id: String(row.target_id), detail: asJson(JSON.parse(String(row.body))) })); }
  chunk(eventId: string, part: number, total: number, digest: string): boolean {
    this.db.prepare('INSERT OR IGNORE INTO consolidation_chunks VALUES(?,?,?,?,0)').run(eventId, part, total, digest);
    const row = this.db.prepare('SELECT * FROM consolidation_chunks WHERE event_id=? AND part=?').get(eventId, part)!;
    if (row.digest !== digest || Number(row.total) !== total) throw new Error('整理分片与已经保存的内容不一致');
    return Boolean(row.completed);
  }
  completeChunk(eventId: string, part: number): void {
    this.transaction(() => {
      this.db.prepare('UPDATE consolidation_chunks SET completed=1 WHERE event_id=? AND part=?').run(eventId, part);
      const remaining = Number(this.db.prepare('SELECT MAX(total)-SUM(completed) AS remaining FROM consolidation_chunks WHERE event_id=?').get(eventId)?.remaining);
      if (remaining === 0) this.markConsolidated([eventId]); this.touch();
    });
  }
  plan(id: string): LifePlan { const plan = this.get('plan', id, planSchema); if (!plan) throw new EvidenceError('计划不存在'); return plan; }
  savePlan(plan: LifePlan, expected: number | null, actor: string): void { this.put('plan', plan.id, plan.roleId, asJson(planSchema.parse(plan)), expected, actor, '修改目标或安排'); }
  operations(roleId?: string, limit = 100): Operation[] { return this.list('operation', operationSchema, roleId, limit); }
  startOperation(accountId: string, roleId: string | null, tool: string, args: Json, correlation?: { callId?: string; rootCallId?: string; executionId?: string; context?: Operation['context'] }): Operation {
    const raw = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    const context = correlation?.context ?? (typeof raw.group_id === 'number' ? { scene: 'group' as const, peerId: raw.group_id } : typeof raw.user_id === 'number' ? { scene: 'private' as const, peerId: raw.user_id } : null);
    const operation: Operation = { id: randomUUID(), accountId, roleId, tool, arguments: args, state: 'started', result: null, startedAt: now(), endedAt: null, callId: correlation?.callId ?? null, rootCallId: correlation?.rootCallId ?? null, executionId: correlation?.executionId ?? null, context };
    this.put('operation', operation.id, roleId, asJson(operation), null, roleId ?? 'system', '开始工具调用');
    return operation;
  }
  finishOperation(id: string, state: Operation['state'], result: Json): void {
    const current = this.get('operation', id, operationSchema);
    if (!current) throw new Error('操作记录不存在');
    const row = this.db.prepare("SELECT revision FROM documents WHERE kind='operation' AND id=?").get(id);
    this.put('operation', id, current.roleId, asJson({ ...current, state, result, endedAt: now() }), Number(row?.revision), current.roleId ?? 'system', '记录工具结果');
  }
  recoverOperations(): void { for (const op of this.operations(undefined, 100000)) if (op.state === 'started') this.finishOperation(op.id, 'unknown', { reason: '进程在取得结果前终止，需要核实远程状态' }); }
  media(id: string): Media { const media = this.get('media', id, mediaSchema); if (!media) throw new Error('媒体不存在'); return media; }
  extensions(roleId?: string): Extension[] { return this.list('extension', extensionSchema, roleId, 10000); }
  addUsage(roleId: string, day: string, tokens: number, requests = 1): void { this.db.prepare('INSERT INTO usage VALUES(?,?,?,?) ON CONFLICT(role_id,day) DO UPDATE SET requests=requests+excluded.requests,tokens=tokens+excluded.tokens').run(roleId, day, requests, tokens); this.touch(); }
  usage(roleId: string, day: string): { requests: number; tokens: number } { const row = this.db.prepare('SELECT requests,tokens FROM usage WHERE role_id=? AND day=?').get(roleId, day); return { requests: Number(row?.requests ?? 0), tokens: Number(row?.tokens ?? 0) }; }
  async backup(destination: string): Promise<void> { mkdirSync(dirname(destination), { recursive: true }); await backup(this.db, destination); }
  integrity(): string { return String(this.db.prepare('PRAGMA integrity_check').get()?.integrity_check); }
  close(): void { if (this.closed) return; this.db.close(); this.closed = true; this.changes.removeAllListeners(); }
}
