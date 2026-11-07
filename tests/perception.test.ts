import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, Payloads, now, tokens, type Json } from '@kwagent/core';
import { normalizeExperience, conversationOrder } from '@kwagent/kw-lagrange';
import { preparePerception } from '../packages/kw-life/src/perception.ts';
import { Capabilities } from '../packages/kw-lagrange/src/capabilities.ts';
import { Activities } from '../packages/kw-life/src/activities.ts';
import { milkyToolSchema } from '../packages/kw-lagrange/src/client.ts';
import type { SessionEvent } from '@deepseek-ai/dsh-session';

test('模型步骤只确认新接纳输入，运行背景不生成重复唤醒经历', () => {
  const store = new Store(join(process.cwd(), '.artifacts/tests', `${randomUUID()}.sqlite`));
  try {
    store.createRole({ id: 'reader', accountId: 'main', name: '观察者', initialPersona: '自主观察', provider: 'chat', model: 'test', state: 'disabled', groups: [], contacts: [], defaultPrivate: false, globalGroups: false, worldMode: 'real', activeHours: null, dailyRequests: null, dailyTokens: null });
    const activities = new Activities(store);
    const first = store.appendEvent({ accountId: 'main', roleId: 'reader', source: 'manual', type: 'manual', occurredAt: now(), scene: null, peerId: null, senderId: null, messageSeq: null, self: false, payload: { text: '只处理一次' } }).event;
    store.delivery([first.id], 'batch-1', 'prepared');
    let seq = 0;
    const event = (type: string, data: object) => ({ type, data, seq: ++seq, time: Date.now() }) as SessionEvent;
    activities.event('reader', 'session', event('turn/start', { turn: 1 }));
    activities.event('reader', 'session', event('user/message', { id: 'batch-1', source: { kind: 'kw-event', roleId: 'reader', eventIds: [first.id] } }));
    activities.event('reader', 'session', event('user/message', { id: 'background-1', source: { kind: 'runtime-context' } }));
    activities.event('reader', 'session', event('assistant/message', { turn: 1, step: 1, interrupted: false }));
    activities.event('reader', 'session', event('step/end', { turn: 1, step: 1 }));
    assert.equal(store.deliveryStatus(first.id).state, 'completed');
    assert.equal(store.events('reader').filter(item => item.type === 'accepted-wake').length, 0);
    const revision = store.revision(); activities.complete('reader');
    assert.equal(store.revision(), revision);
    store.delivery([first.id], 'batch-1', 'delivered');
    assert.equal(store.deliveryStatus(first.id).state, 'completed');
    const second = store.appendEvent({ ...first, id: undefined, payload: { text: '等待完整回复' } }).event;
    store.delivery([second.id], 'batch-2', 'delivered');
    activities.event('reader', 'session', event('user/message', { id: 'batch-2', source: { kind: 'kw-event', roleId: 'reader', eventIds: [second.id] } }));
    activities.event('reader', 'session', event('assistant/message', { turn: 1, step: 2, interrupted: true }));
    activities.event('reader', 'session', event('step/end', { turn: 1, step: 2 }));
    activities.event('reader', 'session', event('turn/end', { turn: 1, reason: { kind: 'cancelled' } }));
    assert.equal(store.deliveryStatus(second.id).state, 'accepted');
    activities.event('reader', 'session', event('assistant/message', { turn: 2, step: 1, interrupted: false }));
    activities.event('reader', 'session', event('step/end', { turn: 2, step: 1 }));
    assert.equal(store.deliveryStatus(second.id).state, 'completed');
  } finally { store.close(); }
});

test('感知整理保留稳定账号、引用、嵌套节点及未理解媒体，批次重启保持不变', async () => {
  const root = join(process.cwd(), '.artifacts/tests', randomUUID()); let store = new Store(join(root, 'state.sqlite'));
  store.createRole({ id: 'reader', accountId: 'main', name: '观察者', initialPersona: '自主观察', provider: 'chat', model: 'test', state: 'disabled', groups: [], contacts: [], defaultPrivate: false, globalGroups: false, worldMode: 'real', activeHours: null, dailyRequests: null, dailyTokens: null });
  const message = (seq: number, sender: number, segments: Json[], scene = 'group', peer = 123) => store.appendEvent({ accountId: 'main', roleId: 'reader', source: 'milky', type: 'message_receive', occurredAt: new Date(1000 * seq).toISOString(), scene, peerId: peer, senderId: sender, messageSeq: seq, self: false, payload: { group_member: { nickname: '同名', card: '群名片' }, segments } }).event;
  try {
    const first = message(1, 456, [{ type: 'text', data: { text: '原始消息' } }]);
    const second = message(2, 789, [{ type: 'mention', data: { user_id: 456 } }, { type: 'reply', data: { message_seq: 1 } }, { type: 'image', data: { resource_id: 'image-resource' } }, { type: 'forward', data: { messages: [{ sender_id: 456, sender_name: '节点声明', segments: [{ type: 'forward', data: { forward_id: 'remote-forward' } }] }] } }]);
    const missing = message(3, 789, [{ type: 'reply', data: { message_seq: 999 } }, { type: 'record', data: { resource_id: 'voice' } }]);
    const privateEvent = message(4, 456, [{ type: 'text', data: { text: '私聊内容' } }], 'private', 456);
    const pending = message(5, 456, [{ type: 'text', data: { text: '尚未接纳，等待独立投递' } }]);
    const completed = message(6, 456, [{ type: 'text', data: { text: '已经推送过的历史消息' } }]);
    store.delivery([completed.id], 'old-batch', 'completed');
    const normalized = JSON.parse(JSON.stringify(normalizeExperience(store, second)));
    assert.equal(normalized.sender.id, 789); assert.equal(normalized.sender.aliases[0], '同名');
    assert.equal(normalized.parts[1].sourceId, first.id); assert.equal(normalized.parts[2].state, '未理解附件或消息片段'); assert.equal(normalized.parts[3].nodes[0].parts[0].state, '未读取转发内容');
    assert.deepEqual(normalized.parts[2].prepare, { tool: 'media_prepare', arguments: { resourceId: 'image-resource', eventId: second.id } });
    assert.equal(JSON.parse(JSON.stringify(normalizeExperience(store, missing))).parts[0].state, '原文尚未接收');
    assert.deepEqual(conversationOrder([missing, first, second]).map(event => event.id), [first.id, second.id, missing.id]);
    const payloads = new Payloads(store, join(root, 'artifacts'));
    const frame = await preparePerception(store, payloads, 'reader', [second, missing], 'stable-message', 8192);
    assert.ok(tokens(JSON.stringify(frame)) <= 8192); assert.ok(!JSON.stringify(frame).includes(privateEvent.id));
    assert.deepEqual((frame.content as Json[]).filter(item => item && typeof item === 'object' && !Array.isArray(item) && item.phase === 'recent'), []);
    assert.ok(!JSON.stringify(await payloads.value('reader', frame.contentRef.payloadId)).includes(pending.id));
    assert.equal(Object.isFrozen(frame), true); assert.equal(Object.isFrozen(frame.content), true);
    await assert.rejects(preparePerception(store, payloads, 'other', [second], 'stable-message', 8192), /其他角色/);
    store.close(); store = new Store(store.path);
    assert.deepEqual(await preparePerception(store, new Payloads(store, payloads.directory), 'reader', [first], 'stable-message', 1024), frame);
  } finally { store.close(); }
});

test('相同工具没有进展只提醒一次；能力失败保持支持声明并保留真实失败证据', () => {
  const store = new Store(join(process.cwd(), '.artifacts/tests', `${randomUUID()}.sqlite`));
  try {
    const activities = new Activities(store);
    assert.deepEqual([0, 1, 2, 3, 4].map(() => activities.noProgress('reader', 'query', { id: 1 }, { count: 0 })), [false, false, true, false, false]);
    assert.equal(activities.noProgress('reader', 'query', { id: 1 }, { count: 1 }), false);
    const capabilities = new Capabilities(store, 'main');
    store.setMeta('milky:main:tools', JSON.stringify([{ name: 'send_group_message', inputSchema: { type: 'object' } }]));
    assert.throws(() => milkyToolSchema.parse({ name: 'send_group_message', inputSchema: false }), error => { capabilities.record('send_group_message', 'failed', { error: (error as Error).message, stage: 'local-schema-validation' }); return true; });
    const first = JSON.parse(JSON.stringify(capabilities.read('send_group_message'))).items[0];
    assert.equal(first.latest.state, 'failed'); assert.ok(first.latest.at); assert.match(first.adapterSupport, /已接入/);
    assert.equal(JSON.parse(JSON.stringify(capabilities.read('message.markdown'))).items[0].adapterSupport, 'unsupported');
  } finally { store.close(); }
});

test('首次感知使用真实账号识别提及和引用，不使用昵称猜测身份', () => {
  const store = new Store(join(process.cwd(), '.artifacts/tests', `${randomUUID()}.sqlite`));
  try {
    store.setMeta('milky:main:self', '10001');
    const message = (seq: number, sender: number, segments: Json[]) => store.appendEvent({ accountId: 'main', roleId: 'reader', source: 'milky', type: 'message_receive', occurredAt: new Date().toISOString(), scene: 'group', peerId: 20001, senderId: sender, messageSeq: seq, self: sender === 10001, payload: { group_member: { nickname: '同名角色' }, segments } }).event;
    message(1, 10001, [{ type: 'text', data: { text: '自己的消息' } }]);
    const incoming = message(2, 10002, [{ type: 'mention', data: { user_id: '10001' } }, { type: 'reply', data: { message_seq: 1 } }]);
    const view = JSON.parse(JSON.stringify(normalizeExperience(store, incoming)));
    assert.equal(view.attention.mentionedSelf, true); assert.equal(view.attention.repliedToSelf, true); assert.equal(view.sender.id, 10002);
    const other = message(3, 10003, [{ type: 'mention', data: { user_id: 10002 } }, { type: 'reply', data: { message_seq: 999 } }]);
    const otherView = JSON.parse(JSON.stringify(normalizeExperience(store, other)));
    assert.equal(otherView.attention.mentionedSelf, false); assert.equal(otherView.parts[1].toSelf, null);
  } finally { store.close(); }
});
