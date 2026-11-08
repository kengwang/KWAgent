import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { loadConfig, roleInputSchema, tokens, continuityDataSchema, EvidenceError, asJson, Store, Payloads } from '@kwagent/core';
import { Mind } from '../packages/kw-mind/src/index.ts';
import { normalizeStepContext } from '../packages/kw-life/src/context-updates.ts';
import { ConsolidationBatches } from '../packages/kw-mind/src/consolidation-batches.ts';

function environment() {
  const root = join(process.cwd(), '.artifacts/tests', randomUUID());
  const mind = new Mind(new Context(), loadConfig({ KW_DATA_ROOT: root }));
  const role = mind.store.createRole(roleInputSchema.parse({ id: 'reader', name: '阅读者', accountId: 'main', initialPersona: '生活在纸城的修书人。', provider: 'configured', model: 'configured', memoryTokens: 131072, state: 'paused' }));
  mind.store.createRole(roleInputSchema.parse({ id: 'other', name: '另一角色', accountId: 'main', initialPersona: '独立角色', provider: 'configured', model: 'configured' }));
  const source = mind.store.appendEvent({ accountId: 'main', roleId: role.id, source: 'manual', type: 'manual', occurredAt: new Date().toISOString(), scene: 'private', peerId: 10001, senderId: 10001, messageSeq: null, self: false, payload: { text: '提供纸城研究生面试与修书资料。' } }).event;
  const memory = (index: number) => mind.store.saveMemory({ roleId: role.id, kind: 'self', title: `纸城研究生面试${index}`, content: '研究生面试时还想了解修书历史。'.repeat(50), realm: 'fictional', epistemic: 'fictional', sources: [source.id], people: [index % 2 ? '10001' : '10002'], aliases: ['修书人'], archived: false, attention: 1 }, null, role.id, '实际写入隔离检索资料');
  return { root, mind, role, source, memory };
}

test('400条与4000条真实记忆不增加自动背景，查询摘要和游标有界且版本隔离', async () => {
  const { mind, role, source, memory } = environment();
  try {
    mind.store.transaction(() => { for (let index = 0; index < 400; index++) memory(index); });
    const first = JSON.parse(mind.freeze(role.id, '{"memories":[]}')); delete first.at;
    mind.store.transaction(() => { for (let index = 400; index < 4000; index++) memory(index); });
    const second = JSON.parse(mind.freeze(role.id, '{"memories":[]}')); delete second.at;
    assert.deepEqual(second, first); assert.equal(first.memories.length, 0);
    assert.ok(!JSON.stringify(normalizeStepContext(asJson(second))).includes('还想了解修书历史'));
    const query = { roleId: role.id, query: '研究生面试', person: '10001', realm: 'fictional' };
    const page = await mind.search(query); assert.ok(page.items.length && page.items.length <= 10); assert.ok(page.nextCursor);
    assert.ok(tokens(JSON.stringify(page)) <= mind.config.budgets.tool);
    assert.ok(page.items.every(item => !('content' in item) && !('sources' in item) && tokens(item.snippet) <= 256 && item.people.includes('10001')));
    const next = await mind.search({ ...query, cursor: page.nextCursor });
    assert.ok(!next.items.some(item => page.items.some(previous => previous.id === item.id)));
    await assert.rejects(mind.search({ ...query, query: '其他', cursor: page.nextCursor }), EvidenceError);
    await assert.rejects(mind.search({ ...query, roleId: 'other', cursor: page.nextCursor }), EvidenceError);
    assert.equal((await mind.search({ ...query, roleId: 'other' })).items.length, 0);
    assert.ok((await mind.search({ roleId: role.id, query: '修书' })).items.length);
    assert.ok((await mind.search({ roleId: role.id, query: '修书人' })).items.length);
    assert.equal((await mind.search({ ...query, scene: 'group', peerId: 10001 })).items.length, 0);
    assert.ok((await mind.search({ ...query, scene: 'private', peerId: 10001 })).items.length);
    assert.equal((await mind.search({ roleId: role.id, query: '"* - : ()' })).items.length, 0);
    const selected = mind.store.memory(page.items[0]!.id); mind.store.saveMemory({ ...selected, content: '实际修订后的资料', sources: [source.id] }, selected.revision, role.id, '验证索引游标更新');
    await assert.rejects(mind.search({ ...query, cursor: page.nextCursor }), /游标已失效/);
    assert.equal(mind.store.operations(role.id).filter(item => item.tool === 'memory_query_expand').length, 0);
  } finally { await mind.close(); }
});

test('当前生活过滤到期情绪，人物资料仅在直接关联时提供且步骤冻结', async () => {
  const { mind, role, source } = environment();
  try {
    const life = mind.continuity.revise(role.id, { expectedRevision: null, reason: '保存实际输入状态', data: continuityDataSchema.parse({ kind: 'life', title: '修书进度', content: '正在了解纸城旧书', sources: [source.id], emotions: [{ text: '已到期感受', reason: '过去的想法', formedAt: new Date(Date.now() - 200000).toISOString(), expiresAt: new Date(Date.now() - 100000).toISOString() }, { text: '当前感受', reason: '刚读到新资料', formedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 100000).toISOString() }] }) });
    const relation = mind.continuity.revise(role.id, { expectedRevision: null, reason: '保存有来源的主观认识', data: continuityDataSchema.parse({ kind: 'relationship', title: '同名人物的相处认识', content: '只在私聊了解的偏好', people: ['10001'], context: { scene: 'private', peerId: 10001 }, sources: [source.id] }) });
    const first = JSON.parse(mind.freeze(role.id, '{"memories":[]}'));
    const visible = JSON.stringify(normalizeStepContext(asJson(first)));
    assert.ok(visible.includes('当前感受')); assert.ok(!visible.includes('已到期感受')); assert.ok(!visible.includes(relation.id));
    const frozen = mind.steps.get(role.id);
    mind.continuity.revise(role.id, { id: life.id, expectedRevision: life.revision, reason: '更新当前生活', data: { ...life.data, content: '下一步读取修书资料' } });
    assert.equal(mind.steps.get(role.id), frozen);
    const linked = JSON.parse(mind.freeze(role.id, '{"memories":[]}', { eventIds: [source.id], people: ['10001'], contexts: [{ scene: 'private', peerId: 10001 }], planIds: [], recordIds: [relation.id], query: '' }));
    assert.ok(JSON.stringify(normalizeStepContext(asJson(linked))).includes(relation.id));
    const list = mind.continuitySearch(role.id, { person: '10001' });
    assert.ok(tokens(JSON.stringify(list)) <= mind.config.budgets.tool); assert.ok(!JSON.stringify(list).includes('"sources"'));
  } finally { await mind.close(); }
});

test('整理批次跨真实数据库关闭恢复固定来源、草稿和请求进度，完成与分片原子提交', async () => {
  const { root, mind, role, source } = environment();
  const input = { role, validationFeedback: '', memories: [], continuity: [], sources: [{ id: source.id, part: 0, total: 1, payloadId: 'recorded-source', text: '固定的真实输入', sourceMeaning: 'reported' }] };
  const batch = await new ConsolidationBatches(mind.store, mind.payloads).create(role.id, input);
  batch.attempts = 1; batch.feedback = '模型字段格式需要修正'; batch.draft = { memories: [], reason: '无需重复记忆' };
  new ConsolidationBatches(mind.store, mind.payloads).save(role.id, batch);
  await mind.close();
  const store = new Store(join(root, 'kwagent/state.sqlite')), batches = new ConsolidationBatches(store, new Payloads(store, join(root, 'artifacts')));
  try {
    const recovered = batches.current(role.id)!;
    assert.equal(recovered.id, batch.id); assert.equal(recovered.attempts, 1); assert.deepEqual(recovered.draft, batch.draft);
    assert.deepEqual(await batches.input(role.id, recovered), input);
    store.chunk(source.id, 0, 1, 'fixed-digest');
    assert.throws(() => store.transaction(() => { store.completeChunk(source.id, 0); batches.complete(role.id, recovered); throw new Error('实际事务中断'); }), /实际事务中断/);
    assert.equal(store.chunk(source.id, 0, 1, 'fixed-digest'), false); assert.ok(batches.current(role.id));
    store.transaction(() => { store.completeChunk(source.id, 0); batches.complete(role.id, recovered); });
    assert.equal(store.chunk(source.id, 0, 1, 'fixed-digest'), true); assert.equal(batches.current(role.id), undefined);
  } finally { store.close(); }
});
