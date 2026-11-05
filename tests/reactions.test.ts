import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, loadConfig, now, roleInputSchema } from '@kwagent/core';
import { MilkyClient } from '@kwagent/kw-lagrange';
import { MessageReactions, reactionProgressSchema } from '../packages/kw-life/src/reactions.ts';

test('表情操作失败不会阻止经历完成，重复输入和重启不重复调用', async () => {
  const store = new Store(join(process.cwd(), '.artifacts/tests', randomUUID(), 'state.sqlite'));
  const client = new MilkyClient(loadConfig().milky, store); const requests: { reaction: string; is_add: boolean }[] = [];
  const reactions = new MessageReactions(store, async (roleId, args) => {
    requests.push(args);
    try { await client.execute('send_group_message_reaction', args, roleId); return { isError: false }; }
    catch (error) { return { isError: true, error: String(error) }; }
  });
  try {
    store.createRole(roleInputSchema.parse({ id: 'reader', accountId: 'main', name: '观察者', initialPersona: '依据实际回执行动', provider: 'chat', model: 'configured' }));
    const message = store.appendEvent({ accountId: 'main', roleId: 'reader', source: 'milky', type: 'message_receive', occurredAt: now(), scene: 'group', peerId: 20001, senderId: 10002, messageSeq: 17, self: false, payload: { text: '实际保存的测试输入' } }).event;
    await reactions.begin('reader', 'activity', [message.id]);
    assert.deepEqual(requests.map(item => [item.reaction, item.is_add]), [['424', true]]);
    const feedback = store.appendEvent({ accountId: 'main', roleId: 'reader', source: 'milky', type: 'group_message_reaction', occurredAt: now(), scene: 'group', peerId: 20001, senderId: null, messageSeq: null, self: true, payload: { message_seq: message.messageSeq, face_id: '424' } }).event;
    reactions.observe(feedback); assert.ok(!store.unprocessed('reader').some(event => event.id === feedback.id)); assert.equal(store.event(feedback.id).self, true);
    await reactions.begin('reader', 'activity', [message.id]); await reactions.recover('reader');
    assert.equal(requests.length, 1);
    await reactions.finish('reader', 'activity', false); assert.equal(requests.length, 1);
    await reactions.finish('reader', 'activity', true);
    assert.deepEqual(requests.map(item => [item.reaction, item.is_add]), [['424', true], ['424', false]]);
    const saved = store.get('message-reaction', `reaction:${message.id}`, reactionProgressSchema)!;
    assert.equal(saved.actions.clear, 'failed'); assert.equal(saved.actions.complete, undefined);
    store.delivery([message.id], 'batch', 'completed');
    await reactions.begin('reader', 'activity', [message.id]); await reactions.finish('reader', 'activity', true); await reactions.recover('reader');
    assert.equal(requests.length, 2); assert.equal(store.deliveryStatus(message.id).state, 'completed');
    assert.equal(client.status.state, 'disconnected');
  } finally { await reactions.drain(); await client.close(); store.close(); }
});

test('表情操作未取得回执时保留未知，服务恢复不会重放', async () => {
  const store = new Store(join(process.cwd(), '.artifacts/tests', randomUUID(), 'state.sqlite'));
  const client = new MilkyClient(loadConfig().milky, store); let calls = 0;
  const execute = async () => { calls++; await client.call('get_login_info', {}); return { isError: false }; };
  const first = new MessageReactions(store, execute);
  try {
    store.createRole(roleInputSchema.parse({ id: 'reader', accountId: 'main', name: '观察者', initialPersona: '依据真实回执', provider: 'chat', model: 'configured' }));
    const event = store.appendEvent({ accountId: 'main', roleId: 'reader', source: 'milky', type: 'message_receive', occurredAt: now(), scene: 'group', peerId: 20001, senderId: 10002, messageSeq: 19, self: false, payload: {} }).event;
    await assert.rejects(first.begin('reader', 'activity', [event.id]), /connect|transport/i);
    assert.equal(store.get('message-reaction', `reaction:${event.id}`, reactionProgressSchema)?.actions.processing, 'started');
    const recovered = new MessageReactions(store, execute); await recovered.recover('reader');
    assert.equal(store.get('message-reaction', `reaction:${event.id}`, reactionProgressSchema)?.actions.processing, 'unknown');
    assert.equal(calls, 1); await recovered.drain();
  } finally { await client.close(); store.close(); }
});
