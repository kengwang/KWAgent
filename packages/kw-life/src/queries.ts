import { z } from 'zod';
import { continuityQuerySchema } from '@kwagent/core';
import { asJson, jsonSchema, operationSchema, planSchema, roleSchema, extensionSchema, pageSchemaFields, payloadReadSchema, summary, type Json } from '@kwagent/core';
import type { Life } from './index.ts';
import { activitySchema } from './activities.ts';
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session';

export const readActions = new Set(['status', 'doctor', 'history', 'revision.read', 'events', 'memory.list', 'source.read', 'payload.read', 'payload.links', 'role.read', 'persona.read', 'activity.list', 'activity.read', 'sources.list', 'people.list', 'people.memories', 'capability.read', 'memory.read', 'memory.detail', 'records.list', 'perception.read', 'record.read', 'record.detail', 'session.read', 'session.records']);

for (const action of ['continuity.list', 'continuity.read']) readActions.add(action);

/** 管理查询统一校验分页并只返回列表摘要，正文读取独立执行。 */
export async function query(life: Life, action: string, value: Json): Promise<Json | undefined> {
  const preview = <T>(rows: T[]) => rows.map(row => summary(row, life.config.budgets.panelBodyBytes));
  const detail = async (roleId: string, id: string, record: Json): Promise<Record<string, Json>> => {
    const ref = await life.context.kwMind.payloads.put(roleId, id, record);
    const body = record && typeof record === 'object' && !Array.isArray(record) ? record : {};
    const refs = life.context.kwMind.payloads.references(roleId, record);
    const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : {};
    return { roleId, id, ...ref, read: 'payload.read', summary: asJson(summary(record, life.config.budgets.panelBodyBytes)), sources: Array.isArray(body.sources) ? body.sources.slice(0, 50) : Array.isArray(body.personaSources) ? body.personaSources.slice(0, 50) : Array.isArray(data.sources) ? data.sources.slice(0, 50) : [], references: asJson(refs.slice(0, 50)), referencesNextCursor: refs.length > 50 ? 50 : null };
  };
  switch (action) {
    case 'continuity.list': {
      const input = continuityQuerySchema.extend({ roleId: z.string() }).strict().parse(value); const { roleId, ...request } = input;
      const page = life.context.kwMind.continuity.list(roleId, request); return asJson({ ...page, items: preview(page.items.map(record => ({ ...record, kind: record.data.kind, title: record.data.title, status: record.data.status, content: record.data.content, people: record.data.people, context: record.data.context, realm: record.data.realm, expiresAt: record.data.expiresAt, read: 'continuity.read' }))) });
    }
    case 'continuity.read': {
      const input = z.object({ roleId: z.string(), id: z.string(), raw: z.boolean().default(false) }).strict().parse(value);
      const record = life.context.kwMind.continuity.read(input.roleId, input.id);
      return input.raw ? asJson(record) : { ...await detail(input.roleId, input.id, asJson(record)), receipts: record.data.kind === 'thread' ? record.data.followups.slice(0, 50).map(item => { const operation = life.store.get('operation', item.operationId, operationSchema); return { ...item, state: operation?.state ?? 'unknown', association: !item.pending && operation && life.context.kwMind.payloads.operationContext(operation) ? 'confirmed-target' : '待核实或未记录会话关联' }; }) : [] };
    }
    case 'role.read': { const input = z.object({ roleId: z.string() }).strict().parse(value); return asJson(life.store.role(input.roleId)); }
    case 'persona.read': { const input = z.object({ roleId: z.string() }).strict().parse(value); return detail(input.roleId, `role:${input.roleId}`, asJson(life.store.role(input.roleId))); }
    case 'events': {
      const input = z.object({ roleId: z.string().optional(), limit: pageSchemaFields.limit, before: z.number().int().positive().optional() }).strict().parse(value ?? {});
      const rows = life.store.events(input.roleId, input.limit + 1, input.before);
      return asJson({ items: preview(rows.slice(0, input.limit).map(event => ({ ...event, delivery: life.store.deliveryStatus(event.id) }))), nextCursor: rows.length > input.limit ? rows[input.limit - 1]!.seq : null });
    }
    case 'history': {
      const input = z.object({ entity: z.enum(['role', 'memory', 'plan', 'extension', 'operation', 'continuity']), id: z.string(), limit: pageSchemaFields.limit, before: z.number().int().positive().optional() }).strict().parse(value);
      const rows = life.store.history(input.entity, input.id, input.limit + 1, input.before);
      return asJson({ items: preview(rows.slice(0, input.limit)), nextCursor: rows.length > input.limit ? rows[input.limit - 1]!.revision : null });
    }
    case 'revision.read': {
      const input = z.object({ roleId: z.string(), entity: z.enum(['role', 'memory', 'plan', 'extension', 'operation', 'continuity']), id: z.string(), revision: z.number().int().positive() }).strict().parse(value);
      const owner = life.store.db.prepare('SELECT role_id FROM documents WHERE kind=? AND id=?').get(input.entity, input.id);
      if (owner?.role_id !== input.roleId) throw new Error('修订不存在或属于其他角色');
      const record = life.store.history(input.entity, input.id, 1, input.revision + 1)[0]; if (record?.revision !== input.revision) throw new Error('修订不存在');
      const body = record.value && typeof record.value === 'object' && !Array.isArray(record.value) ? record.value : {};
      const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : {};
      const sources = body.sources ?? body.personaSources ?? data.sources;
      return { ...await detail(input.roleId, `revision:${input.entity}:${input.id}:${input.revision}`, asJson(record)), sources: Array.isArray(sources) ? sources.slice(0, 50) : [] };
    }
    case 'memory.list': {
      const input = z.object({ roleId: z.string(), offset: pageSchemaFields.cursor, limit: pageSchemaFields.limit }).strict().parse(value);
      const rows = life.store.memories(input.roleId, input.limit + 1, input.offset);
      return asJson({ items: preview(rows.slice(0, input.limit)), nextCursor: rows.length > input.limit ? input.offset + input.limit : null });
    }
    case 'memory.read': { const input = z.object({ roleId: z.string(), id: z.string() }).strict().parse(value); const memory = life.store.memory(input.id); if (memory.roleId !== input.roleId) throw new Error('记忆属于其他角色'); return asJson(memory); }
    case 'memory.detail': { const input = z.object({ roleId: z.string(), id: z.string() }).strict().parse(value); const memory = life.store.memory(input.id); if (memory.roleId !== input.roleId) throw new Error('记忆属于其他角色'); return detail(input.roleId, input.id, asJson(memory)); }
    case 'perception.read': { const input = z.object({ roleId: z.string(), messageId: z.string() }).strict().parse(value); const frame = life.store.frame(input.messageId); if (!frame || typeof frame !== 'object' || Array.isArray(frame) || frame.roleId !== input.roleId) throw new Error('感知批次不存在或属于其他角色'); return frame; }
    case 'record.read': {
      const input = z.object({ roleId: z.string(), kind: z.enum(['plan', 'extension', 'operation']), id: z.string() }).strict().parse(value);
      const schema: z.ZodType<unknown> = { plan: planSchema, extension: extensionSchema, operation: operationSchema }[input.kind];
      const record = life.store.get(input.kind, input.id, schema); if (!record || typeof record !== 'object' || !('roleId' in record) || record.roleId !== input.roleId) throw new Error('记录不存在或属于其他角色'); return asJson(record);
    }
    case 'record.detail': {
      const record = await query(life, 'record.read', value); if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.roleId !== 'string' || typeof record.id !== 'string') throw new Error('记录不存在');
      return detail(record.roleId, record.id, record);
    }
    case 'session.read': {
      const input = z.object({ roleId: z.string(), seq: z.number().int().nonnegative() }).strict().parse(value); const role = life.store.role(input.roleId);
      const result = await life.context.sessionQuery.readEvent({ sessionId: SessionId(role.sessionId), seq: SessionSeq(input.seq), before: 0, after: 0 });
      return detail(input.roleId, `session:${role.sessionId}:${input.seq}`, asJson(result.target));
    }
    case 'session.records': {
      const input = z.object({ roleId: z.string(), ...pageSchemaFields }).strict().parse(value); const role = life.store.role(input.roleId);
      const records = await life.context.sessionQuery.listEvents(SessionId(role.sessionId));
      const rows = records.filter(record => record.seq >= input.cursor);
      return asJson({ items: rows.slice(0, input.limit), nextCursor: rows.length > input.limit ? Number(rows[input.limit - 1]!.seq) + 1 : null });
    }
    case 'payload.read': { const input = payloadReadSchema.extend({ roleId: z.string() }).strict().parse(value); return life.context.kwMind.payloads.read(input.roleId, { id: input.id, offset: input.offset, limit: input.limit }); }
    case 'payload.links': {
      const input = z.object({ roleId: z.string(), id: payloadReadSchema.shape.id, ...pageSchemaFields }).strict().parse(value); const valueBody = await life.context.kwMind.payloads.value(input.roleId, input.id);
      const refs = life.context.kwMind.payloads.references(input.roleId, valueBody); return asJson({ items: refs.slice(input.cursor, input.cursor + input.limit), nextCursor: refs.length > input.cursor + input.limit ? input.cursor + input.limit : null });
    }
    case 'capability.read': { const input = z.object({ name: z.string().optional(), ...pageSchemaFields, detail: z.boolean().default(false) }).strict().parse(value ?? {}); return life.context.kwLagrange.client.capabilities.read(input.name, input.limit, input.cursor, input.detail); }
    case 'activity.list': {
      const input = z.object({ roleId: z.string().optional(), ...pageSchemaFields }).strict().parse(value ?? {}); const rows = life.store.list('activity', activitySchema, input.roleId, input.limit + 1, input.cursor);
      return asJson({ items: rows.slice(0, input.limit), nextCursor: rows.length > input.limit ? input.cursor + input.limit : null });
    }
    case 'activity.read': {
      const input = z.object({ roleId: z.string(), id: z.string(), ...pageSchemaFields }).strict().parse(value); const activity = life.store.get('activity', input.id, activitySchema);
      if (!activity || activity.roleId !== input.roleId) throw new Error('活动不存在或属于其他角色'); const rows = life.store.links(input.id, input.limit + 1, input.cursor);
      return { activity: asJson(activity), items: preview(rows.slice(0, input.limit)), nextCursor: rows.length > input.limit ? input.cursor + input.limit : null };
    }
    case 'records.list': {
      const input = z.object({ kind: z.enum(['role', 'plan', 'extension', 'operation']), roleId: z.string().optional(), ...pageSchemaFields }).strict().parse(value);
      const schema: z.ZodType<unknown> = { role: roleSchema, plan: planSchema, extension: extensionSchema, operation: operationSchema }[input.kind];
      const rows = life.store.list(input.kind, schema, input.roleId, input.limit + 1, input.cursor);
      return asJson({ items: preview(rows.slice(0, input.limit)), nextCursor: rows.length > input.limit ? input.cursor + input.limit : null });
    }
    case 'sources.list': {
      const input = z.object({ roleId: z.string(), memoryId: z.string().optional(), personId: z.string().optional(), continuityId: z.string().optional(), ...pageSchemaFields }).strict().refine(item => [item.memoryId, item.personId, item.continuityId].filter(Boolean).length === 1, '需要指定记忆、人物或连续性记录').parse(value);
      if (input.continuityId) { const record = life.context.kwMind.continuity.read(input.roleId, input.continuityId); return asJson({ items: record.data.sources.slice(input.cursor, input.cursor + input.limit).map(id => ({ id, roleId: input.roleId })), nextCursor: record.data.sources.length > input.cursor + input.limit ? input.cursor + input.limit : null }); }
      if (input.memoryId) {
        const memory = life.store.memory(input.memoryId); if (memory.roleId !== input.roleId) throw new Error('认识属于其他角色');
        return asJson({ items: memory.sources.slice(input.cursor, input.cursor + input.limit).map(id => ({ id, roleId: input.roleId })), nextCursor: memory.sources.length > input.cursor + input.limit ? input.cursor + input.limit : null });
      }
      const rows = life.store.db.prepare("WITH matching AS (SELECT ms.source_id FROM memory_sources ms JOIN documents d ON d.id=ms.memory_id AND d.kind='memory' WHERE d.role_id=? AND EXISTS(SELECT 1 FROM json_each(d.body,'$.people') WHERE value=?)), sources AS (SELECT e.id,e.seq,e.type,e.occurred_at,e.scene,e.peer_id FROM events e WHERE e.role_id=? AND (CAST(e.sender_id AS TEXT)=? OR e.id IN (SELECT source_id FROM matching)) UNION ALL SELECT d.id,NULL,'tool-operation',json_extract(d.body,'$.startedAt'),NULL,NULL FROM documents d WHERE d.kind='operation' AND d.role_id=? AND d.id IN (SELECT source_id FROM matching)) SELECT * FROM sources ORDER BY occurred_at DESC,id LIMIT ? OFFSET ?").all(input.roleId, input.personId!, input.roleId, input.personId!, input.roleId, input.limit + 1, input.cursor);
      return asJson({ items: rows.slice(0, input.limit).map(row => ({ id: row.id, seq: row.seq, type: row.type, occurredAt: row.occurred_at, scene: row.scene, peerId: row.peer_id })), nextCursor: rows.length > input.limit ? input.cursor + input.limit : null });
    }
    case 'people.list': {
      const input = z.object({ roleId: z.string(), query: z.string().default(''), ...pageSchemaFields }).strict().parse(value);
      const rows = life.store.db.prepare("WITH identities AS (SELECT CAST(sender_id AS TEXT) identity FROM events WHERE role_id=? AND sender_id IS NOT NULL UNION SELECT CAST(j.value AS TEXT) identity FROM documents d,json_each(d.body,'$.people') j WHERE d.kind='memory' AND d.role_id=?) SELECT identity FROM identities i WHERE instr(i.identity,?)>0 OR EXISTS(SELECT 1 FROM events e WHERE e.role_id=? AND CAST(e.sender_id AS TEXT)=i.identity AND instr(coalesce(json_extract(e.payload,'$.group_member.nickname'),'')||coalesce(json_extract(e.payload,'$.group_member.card'),'')||coalesce(json_extract(e.payload,'$.friend.nickname'),'')||coalesce(json_extract(e.payload,'$.sender.nickname'),'')||coalesce(json_extract(e.payload,'$.sender.name'),'')||coalesce(json_extract(e.payload,'$.sender_name'),''),?)>0) ORDER BY identity LIMIT ? OFFSET ?").all(input.roleId, input.roleId, input.query, input.roleId, input.query, input.limit + 1, input.cursor);
      const items = rows.slice(0, input.limit).filter(row => /^[1-9][0-9]*$/.test(String(row.identity))).map(row => {
        const identity = String(row.identity); const memories = life.store.lexical({ roleId: input.roleId, person: identity, query: '', semantic: false, archived: false, limit: 50 });
        const profiles = life.store.db.prepare("SELECT id,payload FROM events WHERE role_id=? AND CAST(sender_id AS TEXT)=? ORDER BY seq DESC LIMIT 20").all(input.roleId, identity).map(row => { const data = JSON.parse(String(row.payload)); const sender = data.sender ?? data.group_member ?? data.friend ?? {}; return { sourceId: String(row.id), aliases: [sender.nickname, sender.card, sender.name, data.sender_name].filter(value => typeof value === 'string' && value) }; });
        const aliases = [...new Set(profiles.flatMap(item => item.aliases))];
        return { identity, aliases, profiles: profiles.slice(0, 5), memories: preview(memories.slice(0, 5)), read: 'sources.list' };
      });
      return asJson({ items, nextCursor: rows.length > input.limit ? input.cursor + input.limit : null });
    }
    case 'people.memories': {
      const input = z.object({ roleId: z.string(), personId: z.string(), ...pageSchemaFields }).strict().parse(value);
      const rows = life.store.db.prepare("SELECT body FROM documents d WHERE kind='memory' AND role_id=? AND EXISTS(SELECT 1 FROM json_each(d.body,'$.people') WHERE CAST(value AS TEXT)=?) ORDER BY updated_at DESC,id LIMIT ? OFFSET ?").all(input.roleId, input.personId, input.limit + 1, input.cursor);
      return asJson({ items: preview(rows.slice(0, input.limit).map(row => JSON.parse(String(row.body)))), nextCursor: rows.length > input.limit ? input.cursor + input.limit : null });
    }
    case 'source.read': {
      const input = z.object({ roleId: z.string(), id: z.string() }).strict().parse(value); let source: Json;
      if (input.id === `role:${input.roleId}`) source = asJson(life.store.role(input.roleId));
      else {
        const operation = life.store.get('operation', input.id, operationSchema);
        if (operation) { if (operation.roleId !== input.roleId) throw new Error('来源属于其他角色'); source = asJson(operation); }
        else { const event = life.store.event(input.id); if (event.roleId !== input.roleId) throw new Error('来源属于其他角色'); source = asJson(event); }
      }
      return detail(input.roleId, input.id, source);
    }
  }
}
