import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Store, roleInputSchema } from '@kwagent/core';
import { consolidationMessages, hasConsolidationContent, type ConsolidationInput } from '../packages/kw-mind/src/consolidation-input.ts';

test('整理稳定资料放在新来源前，来源和管理修订变化不破坏共享前缀', () => {
  const store = new Store(join(process.cwd(), '.artifacts/tests', randomUUID(), 'state.sqlite'));
  try {
    const role = store.createRole(roleInputSchema.parse({ id: 'cache', accountId: 'main', name: '整理角色', initialPersona: '独立角色。', provider: 'configured', model: 'configured' }));
    const input: ConsolidationInput = { role, memories: [], continuity: [], validationFeedback: '', sources: [{ id: 'actual-1', part: 0, total: 1, payloadId: 'reference', text: '先前的实际来源', sourceMeaning: 'reported' }] };
    const first = consolidationMessages(input);
    const second = consolidationMessages({ ...input, role: { ...role, revision: role.revision + 1, updatedAt: new Date(Date.now() + 1000).toISOString() }, sources: [{ ...input.sources[0]!, id: 'actual-2', text: '后续新的来源' }] });
    assert.deepEqual(first[0], second[0]); assert.notDeepEqual(first[1], second[1]);
    const event = (type: string, payload: any) => store.appendEvent({ id: randomUUID(), accountId: 'main', roleId: role.id, source: 'system', type, occurredAt: new Date().toISOString(), scene: null, peerId: null, senderId: null, messageSeq: null, self: true, payload }).event;
    assert.equal(hasConsolidationContent(event('tool-result', { name: 'job_output', result: { status: 'running' } })), false);
    assert.equal(hasConsolidationContent(event('internal-activity', { message: { content: [{ type: 'tool-call', name: 'run_code' }] } })), false);
    assert.equal(hasConsolidationContent(event('internal-activity', { message: { content: [{ type: 'text', text: '我形成了一个新的想法。' }] } })), true);
    assert.equal(hasConsolidationContent(event('tool-result', { name: 'media_inspect', result: { description: '实际理解结果' } })), true);
    assert.equal(store.events(role.id, 10).length, 4, '跳过整理不会删除原始记录');
  } finally { store.close(); }
});
