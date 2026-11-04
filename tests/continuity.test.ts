import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { Store, Payloads, loadConfig, roleInputSchema, continuityDataSchema, continuityActive, ConflictError, tokens, type ContinuityScene, type ContinuityRequest } from '@kwagent/core';
import { Continuity } from '../packages/kw-mind/src/continuity.ts';

function environment() {
  const root = join(process.cwd(), '.artifacts/tests', randomUUID()); const store = new Store(join(root, 'state.sqlite'));
  for (const id of ['alice', 'bob']) store.createRole(roleInputSchema.parse({ id, name: id, accountId: 'main', initialPersona: '阅读实际资料，独立判断。', provider: 'kw-chat', model: 'configured-model' }));
  const module = new Continuity(store, new Payloads(store, join(root, 'artifacts')), loadConfig({}));
  const event = store.appendEvent({ accountId: 'main', roleId: 'alice', source: 'manual', type: 'test-input', occurredAt: '2026-11-04T00:00:00Z', scene: 'private', peerId: 10001, senderId: 10001, messageSeq: null, self: false, payload: { text: '周三面试，想暂时自己准备。' } }).event;
  const request = (data: unknown, expectedRevision: number | null = null, id?: string): ContinuityRequest => ({ data: continuityDataSchema.parse(data), expectedRevision, id, reason: '验证真实持久化规则' });
  const base = { title: '面试后续', content: '等待合适时机了解后续。', sources: [event.id], people: ['10001'], context: { scene: 'private', peerId: 10001 } };
  return { root, store, module, event, request, base };
}
test('连续性修订保留来源、严格角色归属和CAS，结束话头后需要新依据重新开启', () => {
  const { store, module, base, request } = environment();
  try {
    const record = module.revise('alice', request({ ...base, kind: 'thread' }));
    assert.equal(module.list('alice', { person: '10001' }).items.length, 1);
    assert.throws(() => module.read('bob', record.id), /其他角色/);
    assert.throws(() => module.revise('alice', request(record.data, 99, record.id)), ConflictError);
    const ended = module.revise('alice', request({ ...record.data, status: 'declined' }, record.revision, record.id));
    assert.equal(continuityActive(ended, '2026-11-04T01:00:00Z'), false);
    assert.throws(() => module.revise('alice', request({ ...ended.data, status: 'active' }, ended.revision, ended.id)), /新的来源/);
    assert.equal(store.history('continuity', record.id).length, 2);
    assert.ok(store.db.prepare('SELECT * FROM continuity_sources WHERE record_id=?').all(record.id).length > 0);
    assert.throws(() => store.migrateEvents([base.sources[0]!], 'bob'), /保留原始归属/);
  } finally { store.close(); }
});
test('现实活动完成需要实际执行，内部声明与未知操作不能升级为亲历事实', () => {
  const { store, module, base, request } = environment();
  try {
    const operation = store.startOperation('main', 'alice', 'read_file', {}); store.finishOperation(operation.id, 'unknown', { reason: '进程终止' });
    const activity = { title: '阅读', state: 'completed', progress: '已阅读', sources: [operation.id] };
    assert.throws(() => module.revise('alice', request({ ...base, kind: 'life', activity })), /执行依据/);
    const journal = module.revise('alice', request({ ...base, kind: 'journal' })); const declaration = journal.data.sources.at(-1)!;
    assert.throws(() => module.assertMemory({ roleId: 'alice', kind: 'episode', title: '外部事实', content: '发生了', realm: 'real', epistemic: 'observed', people: [], aliases: [], sources: [declaration], archived: false, attention: 0.5 }), /亲历事实/);
    const path = join(process.cwd(), 'package.json'); const observed = store.startOperation('main', 'alice', 'read_file', { path });
    const text = readFileSync(path, 'utf8'); store.finishOperation(observed.id, 'succeeded', { path, bytes: Buffer.byteLength(text) });
    const life = module.revise('alice', request({ ...base, kind: 'life', activity: { ...activity, sources: [observed.id] }, emotions: [{ text: '好奇', reason: '读取了文件', formedAt: '2026-11-04T00:00:00Z' }] }));
    assert.equal(life.id, 'life:alice'); assert.equal(life.data.kind, 'life'); if (life.data.kind === 'life') assert.equal(life.data.emotions[0]!.expiresAt, '2026-11-05T00:00:00.000Z');
  } finally { store.close(); }
});
test('情境选择保留情绪期限、反思期限、表达上限和私聊资料隔离', () => {
  const { store, module, base, request } = environment();
  try {
    module.revise('alice', request({ ...base, kind: 'relationship' }));
    const reflection = module.revise('alice', request({ ...base, kind: 'reflection' }), 'alice', '2026-11-04T00:00:00.000Z'); assert.equal(reflection.data.expiresAt, '2026-11-11T00:00:00.000Z');
    for (let i = 0; i < 4; i++) module.revise('alice', request({ ...base, kind: 'expression', status: 'adopted', examples: [`表达${i}`] }));
    const closing = module.revise('alice', request({ ...base, kind: 'conversation', status: 'closed' }));
    const scene: ContinuityScene = { eventIds: [], people: ['10001'], contexts: [{ scene: 'private', peerId: 10001 }], planIds: [], recordIds: [], query: '' };
    const selected = module.select('alice', scene, 3072, '2026-11-04T00:00:00.000Z') as { records: { data: { kind: string }; id: string }[] };
    assert.equal(selected.records.filter(record => record.data.kind === 'expression').length, 2); assert.ok(tokens(JSON.stringify(selected)) <= 3072);
    assert.ok(selected.records.some(record => record.id === closing.id)); assert.equal(continuityActive(closing, '2026-11-04T00:00:00Z'), false);
    const group = module.select('alice', { ...scene, contexts: [{ scene: 'group', peerId: 20001 }] }, 3072, '2026-11-04T00:00:00.000Z') as { records: unknown[] }; assert.equal(group.records.length, 0);
    const expired = module.select('alice', scene, 3072, '2026-11-12T00:00:00.000Z') as { records: { id: string }[] }; assert.ok(!expired.records.some(record => record.id === reflection.id));
    assert.equal(module.read('alice', reflection.id).revision, 1);
  } finally { store.close(); }
});
test('Schema 2迁移保存一致快照，连续性重新打开后保持版本与完整来源', () => {
  const { store, module, base, request, root } = environment();
  const path = store.path; const record = module.revise('alice', request({ ...base, kind: 'thread' }));
  store.db.exec('DROP TABLE continuity_sources; DROP INDEX continuity_kind; DROP INDEX continuity_scene; PRAGMA user_version=2'); store.close();
  const migrated = new Store(path);
  try { assert.equal(migrated.db.prepare('PRAGMA user_version').get()?.user_version, 3); const snapshot = readdirSync(root).find(name => name.includes('.schema2-')); assert.ok(snapshot); const db = new DatabaseSync(join(root, snapshot)); assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 2); db.close(); assert.equal(new Continuity(migrated, new Payloads(migrated, join(root, 'artifacts')), loadConfig({})).read('alice', record.id).revision, 1); } finally { migrated.close(); }
});
test('失败媒体与PTC父结果保留未确认语义，时间比较接受不同时区', () => {
  const { store, module, base, request } = environment();
  try {
    for (const [source, type, payload] of [['media', 'media-analysis-failed', { reason: '无可用内容' }], ['tool', 'tool-result', { name: 'run_code', result: { isError: false, value: '内部文字' } }]] as const) {
      const event = store.appendEvent({ accountId: 'main', roleId: 'alice', source, type, occurredAt: '2026-11-04T00:00:00Z', scene: null, peerId: null, senderId: null, messageSeq: null, self: true, payload }).event;
      assert.equal(module.sourceMeaning('alice', event.id), 'unconfirmed');
    }
    const record = module.revise('alice', request({ ...base, kind: 'reflection', expiresAt: '2026-11-04T08:30:00+08:00' }));
    assert.equal(continuityActive(record, '2026-11-04T01:00:00Z'), false);
    assert.equal(continuityActive(record, '2026-11-04T00:00:00Z'), true);
  } finally { store.close(); }
});
test('PTC仅沿真实执行身份传播外部子调用，同callId重启后不会复用旧依据', () => {
  const { store, module } = environment();
  try {
    const oldParent = store.invocationId(Symbol('call_0')); const nextParent = store.invocationId(Symbol('call_0'));
    const text = readFileSync(join(process.cwd(), 'package.json'), 'utf8');
    const append = (payload: Record<string, string | null | { isError: boolean; value: number }>) => store.appendEvent({ accountId: 'main', roleId: 'alice', source: 'tool', type: 'tool-result', occurredAt: new Date().toISOString(), scene: null, peerId: null, senderId: null, messageSeq: null, self: true, payload }).event;
    append({ name: 'read_file', executionId: store.invocationId(Symbol('child')), parentExecutionId: oldParent, callId: 'read_0', rootCallId: 'call_0', result: { isError: false, value: Buffer.byteLength(text) } });
    const next = append({ name: 'run_code', executionId: nextParent, parentExecutionId: null, callId: 'call_0', rootCallId: 'call_0', result: { isError: false, value: 0 } });
    assert.equal(module.sourceMeaning('alice', next.id), 'unconfirmed');
    const original = append({ name: 'run_code', executionId: oldParent, parentExecutionId: null, callId: 'call_0', rootCallId: 'call_0', result: { isError: false, value: Buffer.byteLength(text) } });
    assert.equal(module.sourceMeaning('alice', original.id), 'observed');
  } finally { store.close(); }
});
