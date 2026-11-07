import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import jsonPatch from 'fast-json-patch';
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { Store, Payloads, roleInputSchema, asJson, type Json } from '@kwagent/core';
import { normalizeStepContext, prepareContextUpdate } from '../packages/kw-life/src/context-updates.ts';

test('背景正文只提供一次，后续更新保持模型前缀、引用与实际完整快照', async () => {
  const root = join(process.cwd(), '.artifacts/tests', randomUUID());
  const store = new Store(join(root, 'state.sqlite')), payloads = new Payloads(store, join(root, 'artifacts'));
  try {
    const role = store.createRole(roleInputSchema.parse({ id: 'context', name: '持续背景', initialPersona: '保持角色身份。', accountId: 'main', provider: 'configured', model: 'configured', state: 'paused' }));
    const session = Session.create(SessionId(role.sessionId));
    const memory = { id: 'real-memory', revision: 1, content: '这是需要持续提供的背景资料。'.repeat(2000), sources: ['original-source'] };
    const frame = (at: string, memories = [memory]) => asJson({ role, identity: { userId: 12345 }, preinjectSkills: [], memories, plans: [], continuity: { selectedAt: at, records: [], omitted: [], omittedCount: 0 }, scene: { contexts: [] } });
    const prepare = async (snapshot: Json) => prepareContextUpdate(session, payloads, role.id, snapshot, await payloads.put(role.id, 'test-context', snapshot));
    const first = await prepare(frame('2026-11-08T00:00:00Z'));
    assert.equal(first.mode, 'baseline'); assert.equal(first.recordsAdded, 1); assert.ok(first.message);
    const baseline = session.append('user/message', first.message, { surfaceOp: 'append' });
    const prefix = session.deriveMessages();
    const second = await prepare(frame('2026-11-08T00:00:01Z'));
    assert.equal(second.mode, 'patch'); assert.equal(second.recordsAdded, 0); assert.ok(second.message);
    assert.ok(JSON.stringify(second.message.content).length < JSON.stringify(first.message.content).length / 20);
    const body = JSON.parse((second.message.content[0] as { text: string }).text);
    const rebuilt = jsonPatch.applyPatch(normalizeStepContext(frame('2026-11-08T00:00:00Z')).state, body.patch, true, false).newDocument;
    assert.deepEqual(rebuilt, normalizeStepContext(frame('2026-11-08T00:00:01Z')).state);
    session.append('user/message', second.message, { surfaceOp: 'append' });
    assert.deepEqual(session.deriveMessages().slice(0, prefix.length), prefix);
    assert.deepEqual(session.eventAt(baseline.seq), baseline);
    assert.equal((await prepare(frame('2026-11-08T00:00:01Z'))).mode, 'unchanged');
    const notDelivered = await prepare(frame('2026-11-08T00:00:02Z')); assert.ok(notDelivered.message);
    const retry = await prepare(frame('2026-11-08T00:00:02Z'));
    assert.deepEqual(retry.message?.content, notDelivered.message.content);
    const expandedFrame = frame('2026-11-08T00:00:02Z', [memory, { id: 'another-memory', revision: 1, content: '新来源提供的资料', sources: ['second-source'] }]);
    const expanded = await prepare(expandedFrame);
    assert.equal(expanded.mode, 'patch'); assert.equal(expanded.recordsAdded, 1);
    assert.ok(!JSON.stringify(expanded.message?.content).includes('这是需要持续提供的背景资料。'));
    const restored = Session.create(session.id, session.snapshotEvents() as SessionEvent[]);
    const nextFrame = frame('2026-11-08T00:00:03Z');
    const restoredUpdate = await prepareContextUpdate(restored, payloads, role.id, nextFrame, await payloads.put(role.id, 'restored', nextFrame));
    assert.equal(restoredUpdate.mode, 'patch'); assert.equal(restoredUpdate.recordsAdded, 0);
    const removed = await prepare(frame('2026-11-08T00:00:04Z', [])); session.append('user/message', removed.message!, { surfaceOp: 'append' });
    const reselected = await prepare(frame('2026-11-08T00:00:05Z'));
    assert.equal(reselected.recordsAdded, 0, '再次选择已提供版本不应重发正文');
    session.append('user/message', reselected.message!, { surfaceOp: 'append' });
    const latest = session.surface.nodes.at(-1)!;
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Host 收拢后的可见历史。' }], source: { kind: 'user' } }), { surfaceOp: { op: 'replace', startSeq: baseline.seq, endSeq: latest }, sourceEventSeqs: session.surface.nodes.filter(seq => seq >= baseline.seq && seq <= latest) });
    const rebased = await prepare(frame('2026-11-08T00:00:06Z'));
    assert.equal(rebased.mode, 'baseline'); assert.equal(rebased.recordsAdded, 1);
    const saved = await payloads.value(role.id, first.message.source.kind === 'kw-step-context' ? first.message.source.snapshotId : '');
    assert.ok(saved && typeof saved === 'object' && !Array.isArray(saved) && saved.role);
  } finally { store.close(); }
});

test('人物与计划按稳定标识复用，经过时间和顺序变化仅更新选择', () => {
  const item = { id: 'relationship/person', revision: 1, data: { content: '有依据的相处认识' }, elapsedSeconds: 1 };
  const first = normalizeStepContext(asJson({ role: { id: 'role' }, memories: [{ id: 'b', content: 'B' }, { id: 'a', content: 'A' }], plans: [{ id: 'plan', title: '实际安排' }], continuity: { selectedAt: 'first', records: [item] }, preinjectSkills: [{ name: 'style', content: '已作为系统提示提供的正文' }] }));
  const second = normalizeStepContext(asJson({ role: { id: 'role' }, memories: [{ id: 'a', content: 'A' }, { id: 'b', content: 'B' }], plans: [{ id: 'plan', title: '实际安排' }], continuity: { selectedAt: 'second', records: [{ ...item, elapsedSeconds: 2 }] }, preinjectSkills: [{ name: 'style', content: '已作为系统提示提供的正文' }] }));
  assert.deepEqual(Object.keys(first.records).sort(), Object.keys(second.records).sort());
  assert.notDeepEqual((first.state as Record<string, Json>).selectionOrder, (second.state as Record<string, Json>).selectionOrder);
  assert.ok(!JSON.stringify(first.state).includes('已作为系统提示提供的正文'));
  assert.ok(JSON.stringify(second.state).includes('relationship/person'));
});
