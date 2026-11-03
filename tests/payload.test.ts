import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Store, Payloads, loadConfig, tokens, fitText, sourceChunks, readable, invocationId, finishInvocation } from '@kwagent/core';

test('真实负载对象支持 Unicode 分页、归属、取消与重启读取', async () => {
  const root = join(process.cwd(), '.artifacts/tests', randomUUID()); const store = new Store(join(root, 'state.sqlite'));
  for (const id of ['alice', 'bob']) store.createRole({ id, accountId: 'main', name: id, initialPersona: '阅读', provider: 'chat', model: 'test', state: 'disabled', groups: [], contacts: [], globalGroups: false, defaultPrivate: false, worldMode: 'real', dailyRequests: null, dailyTokens: null, activeHours: null });
  const payloads = new Payloads(store, join(root, 'artifacts')); const original = { text: '中文😀消息'.repeat(3000), bytes: 'base64://' + 'a'.repeat(10000) };
  try {
    const ref = await payloads.put('alice', 'source', original); const duplicate = await payloads.put('alice', 'another', original); assert.equal(ref.payloadId, duplicate.payloadId);
    const view = await payloads.view('alice', 'source', original, 512); assert.ok(tokens(JSON.stringify(view)) <= 512); assert.ok(!JSON.stringify(view).includes('a'.repeat(100)));
    let cursor = 0; let text = '';
    for (;;) { const page = await payloads.read('alice', { id: ref.payloadId, offset: cursor, limit: 127 }) as { text: string; nextCursor: number | null }; text += page.text; if (page.nextCursor === null) break; assert.ok(page.nextCursor > cursor); cursor = page.nextCursor; }
    assert.deepEqual(JSON.parse(text), original);
    await assert.rejects(payloads.read('bob', { id: ref.payloadId }), /属于其他角色/);
    await assert.rejects(payloads.read('alice', { id: ref.payloadId }, AbortSignal.abort()), /abort/i);
    store.close(); const restored = new Store(store.path); assert.ok(await new Payloads(restored, payloads.directory).read('alice', { id: ref.payloadId })); restored.close();
  } finally { store.close(); }
});

test('Schema 1 自动快照、分片完成检查和不可变感知内容', () => {
  const root = join(process.cwd(), '.artifacts/tests', randomUUID()); const path = join(root, 'state.sqlite');
  let store = new Store(path); store.db.exec('DROP TABLE payloads; DROP TABLE perception_frames; DROP TABLE activity_links; DROP TABLE consolidation_chunks; PRAGMA user_version=1'); store.close();
  store = new Store(path);
  try {
    assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version, 2);
    const snapshot = readdirSync(root).find(name => name.includes('.schema1-')); assert.ok(snapshot);
    const db = new DatabaseSync(join(root, snapshot)); assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 1); db.close();
    const event = store.appendEvent({ accountId: 'main', roleId: 'alice', source: 'manual', type: 'test', occurredAt: new Date().toISOString(), scene: null, peerId: null, senderId: null, messageSeq: null, self: false, payload: 'long' }).event;
    assert.equal(store.chunk(event.id, 0, 2, 'digest'), false); store.chunk(event.id, 1, 2, 'digest'); store.close();
    const child = spawnSync(process.execPath, ['tests/fixtures/consolidation-crash.mjs'], { env: { ...process.env, KW_TEST_DB: path, KW_TEST_EVENT: event.id } }); assert.notEqual(child.status, 0);
    store = new Store(path); assert.equal(store.chunk(event.id, 0, 2, 'digest'), true); assert.equal(store.chunk(event.id, 1, 2, 'digest'), false);
    assert.equal(store.unprocessed('alice').length, 1); store.completeChunk(event.id, 1); assert.equal(store.unprocessed('alice').length, 0);
    store.saveFrame('frame', 'alice', 'message', { text: '原始内容' }); assert.deepEqual(store.saveFrame('frame', 'alice', 'message', { text: '变化内容' }), { text: '原始内容' });
  } finally { store.close(); }
});

test('预算统计与稳定分片使用 Harness 估算且保留全部文字', () => {
  const text = '中文🙂引用和附件'.repeat(2000); const chunks = sourceChunks(text, 512);
  assert.equal(chunks.join(''), text); for (const part of chunks) assert.ok(tokens(part) <= 512);
  assert.ok(tokens(fitText(text, 256)) <= 256); assert.deepEqual(readable({ bytes: 'abc' }), { bytes: { encoding: 'binary', characters: 3, state: '未读取字节内容' } });
  assert.ok(!JSON.stringify(readable({ text: JSON.stringify({ image_data: 'A'.repeat(10000) }) })).includes('A'.repeat(100)));
  assert.equal(loadConfig({}).budgets.snapshotBytes, 524288);
});

test('调用身份按宿主执行 token 区分，跨角色或重复 callId 不会共用记录', () => {
  const first = Symbol('call_0'), second = Symbol('call_0');
  const id = invocationId(first); assert.equal(invocationId(first), id); assert.notEqual(invocationId(second), id);
  finishInvocation(first); finishInvocation(second);
});
