import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Store, Payloads, loadConfig, roleInputSchema, recallSchema, continuityDataSchema, executionOrigin, EvidenceError, planSchema } from '@kwagent/core';
import { Continuity } from '../packages/kw-mind/src/continuity.ts';
import { consolidationSchema } from '../packages/kw-mind/src/index.ts';
import { consolidationMessages, relatedConsolidationRecords, consolidationCorrectionInput, type ConsolidationInput } from '../packages/kw-mind/src/consolidation-input.ts';
import { parseConsolidationOutput } from '../packages/kw-mind/src/consolidation-output.ts';
import { localRecall } from '../packages/kw-mind/src/local-recall.ts';

function environment() {
  const root = join(process.cwd(), '.artifacts/tests', randomUUID());
  const store = new Store(join(root, 'state.sqlite'));
  for (const id of ['reader', 'other']) store.createRole(roleInputSchema.parse({ id, accountId: 'main', name: id, initialPersona: '喜欢阅读，保留真实来源。', provider: 'configured', model: 'configured' }));
  const event = store.appendEvent({ accountId: 'main', roleId: 'reader', source: 'manual', type: 'manual', occurredAt: new Date().toISOString(), scene: 'private', peerId: 10001, senderId: 10001, messageSeq: null, self: false, payload: { text: '我最近正在阅读红楼梦，想下次继续讨论。' } }).event;
  const input: ConsolidationInput = { role: store.role('reader'), memories: [], continuity: [], sources: [{ id: event.id, part: 0, total: 1, payloadId: 'full-source', sourceMeaning: 'reported', text: JSON.stringify(event) }], validationFeedback: '' };
  const memory = (title: string, content = '想下次继续讨论人物命运。') => store.saveMemory({ roleId: 'reader', kind: 'episode', title, content, realm: 'real', epistemic: 'reported', sources: [event.id], people: ['10001'], aliases: [], archived: false, attention: 0.5 }, null, 'reader', '真实测试输入');
  return { store, event, input, memory, continuity: new Continuity(store, new Payloads(store, join(root, 'artifacts')), loadConfig({})) };
}

test('自然语句通过真实FTS与中文分词检索，角色过滤和新增资料实时生效', () => {
  const { store, memory } = environment();
  try {
    const first = memory('红楼梦的阅读进展');
    const query = recallSchema.parse({ roleId: 'reader', query: '上次我们一起讨论的红楼梦阅读怎么样了', semantic: false });
    assert.ok(localRecall(store, query).some(item => item.id === first.id));
    const next = memory('继续阅读红楼梦');
    assert.ok(localRecall(store, query).some(item => item.id === next.id));
    assert.equal(localRecall(store, { ...query, roleId: 'other' }).length, 0);
  } finally { store.close(); }
});

test('整理修复反馈保留原始输入前缀', () => {
  const { store, input } = environment();
  try {
    const first = consolidationMessages(input);
    const repair = consolidationMessages({ ...input, validationFeedback: '仅修正无效字段，保留其余内容。' });
    assert.deepEqual(repair.slice(0, first.length), first);
  } finally { store.close(); }
});

test('整理只携带相关认识，格式补全不接受未知修订或改变来源语义', () => {
  const { store, input, memory, continuity } = environment();
  try {
    const saved = memory('红楼梦阅读');
    input.memories.push(saved);
    const parsed = parseConsolidationOutput(consolidationSchema, JSON.stringify({ memories: [{ id: saved.id, content: '新的阅读认识' }], continuity: null }), input);
    assert.equal(parsed.value.memories[0]!.expectedRevision, saved.revision);
    assert.deepEqual(parsed.value.continuity, []);
    assert.throws(() => parseConsolidationOutput(consolidationSchema, JSON.stringify({ memories: [{ id: 'unknown', content: '无目标' }] }), input), EvidenceError);
    assert.throws(() => parseConsolidationOutput(consolidationSchema, JSON.stringify({ memories: [{ id: saved.id, kind: 'made-up' }] }), input), EvidenceError);
    const invalid = parseConsolidationOutput(consolidationSchema, JSON.stringify({ memories: [{ id: saved.id, sources: ['nonexistent'] }] }), input).value.memories[0]!;
    assert.throws(() => continuity.assertMemory({ ...invalid, roleId: 'reader' }), EvidenceError);
    const unrelated = { ...saved, id: 'unrelated', title: '火星气象', content: '沙尘颗粒与大气压', people: [], sources: [] };
    const selected = relatedConsolidationRecords(input, [saved, unrelated], []);
    assert.deepEqual(selected.memories.map(item => item.id), [saved.id]);
    const correction = consolidationCorrectionInput({ ...input, memories: [saved, unrelated] }, { memories: [{ id: saved.id }] });
    assert.deepEqual(correction.memories.map(item => item.id), [saved.id]);
    assert.deepEqual(correction.sources, input.sources);
  } finally { store.close(); }
});

test('后台连续性修订与后续计划同步不会关联到随后开始的活动', async () => {
  const { store, input, continuity, event } = environment();
  try {
    store.put('activity', 'later-activity', 'reader', { id: 'later-activity', roleId: 'reader', sessionId: input.role.sessionId, turn: 1, startSeq: 0, startedAt: new Date().toISOString(), endedAt: null, state: 'running', revision: 1, accepted: 0, steps: 0, sends: { succeeded: 0, failed: 0, unknown: 0 } }, null, 'system', '实际活动记录');
    store.setMeta('activity:reader', 'later-activity');
    const record = await executionOrigin.run({ roleId: 'reader', activityId: null, taskId: 'background-consolidation' }, async () => {
      const record = continuity.revise('reader', { expectedRevision: null, reason: '阅读后的真实想法', data: continuityDataSchema.parse({ kind: 'reflection', title: '阅读节奏', content: '先回应对方正在阅读的内容。', sources: [event.id] }) }, 'consolidator');
      await readFile(join(process.cwd(), 'package.json'), 'utf8');
      store.savePlan(planSchema.parse({ id: 'background-review', roleId: 'reader', kind: 'goal', title: '阅读后续', instruction: '继续了解阅读进展', condition: null, timing: null, context: null, sources: [event.id], relatedRecords: [record.id], scheduleId: null, status: 'pending', revision: 1, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }), null, 'reader');
      return record;
    });
    assert.equal(record.activityId, null);
    assert.deepEqual(store.links('later-activity'), []);
    assert.equal(store.events(input.role.id, 10).length, 1);
  } finally { store.close(); }
});

test('整理提取和修正共用业务对象，修改合并旧来源并拒绝其他协议', () => {
  const { store, memory, input } = environment();
  try {
    const saved = memory('原始认识'); input.memories.push(saved);
    const result = parseConsolidationOutput(consolidationSchema, JSON.stringify({ memories: [{ id: saved.id, epistemic: 'inferred' }] }), input).value;
    assert.equal(result.memories[0]!.content, saved.content);
    assert.deepEqual(result.memories[0]!.sources, saved.sources);
    assert.equal(result.memories[0]!.epistemic, 'inferred');
    assert.throws(() => parseConsolidationOutput(consolidationSchema, '[{"op":"replace","path":"/memories/0/epistemic","value":"inferred"}]', input), EvidenceError);
    assert.throws(() => parseConsolidationOutput(consolidationSchema, '{"__proto__":{"polluted":true}}', input), EvidenceError);
    assert.equal(Reflect.get({}, 'polluted'), undefined);
  } finally { store.close(); }
});
