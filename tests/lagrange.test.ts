import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Store, loadConfig } from '@kwagent/core';
import { MilkyClient, MilkyEvents, responseData, MilkyBusinessError, MediaModule, milkyId, toolConversation } from '@kwagent/kw-lagrange';
import { mcpToolName } from '../packages/kw-lagrange/src/index.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

test('Milky 业务错误和结果未知区分，合法 boolean Schema 保留', () => {
  assert.deepEqual(responseData({ content: [{ type: 'text', text: '{"status":"ok","retcode":0,"data":{"uin":123}}' }] }), { uin: 123 });
  assert.throws(() => responseData({ isError: false, content: [], structuredContent: { status: 'failed', retcode: 100, data: null } }), MilkyBusinessError);
  assert.throws(() => responseData({ isError: true, content: [{ type: 'text', text: 'error' }] }), MilkyBusinessError);
  const longName = 'x'.repeat(100);
  assert.equal(mcpToolName(longName).length, 64);
  assert.notEqual(mcpToolName(longName), mcpToolName(`${longName}y`));
});

test('远端十进制字符串与整数标识使用相同的会话和联系人归属', () => {
  for (const id of [20001, '20001']) assert.deepEqual(toolConversation({ group_id: id }), { scene: 'group', peerId: 20001 });
  for (const id of [10001, '10001']) {
    assert.equal(milkyId(id), 10001);
    assert.deepEqual(toolConversation({ user_id: id }), { scene: 'private', peerId: 10001 });
  }
  assert.deepEqual(toolConversation({ group_id: '20001', user_id: '10001' }), { scene: 'group', peerId: 20001 });
  assert.deepEqual(toolConversation({ group_id: '20001', user_id: '10001' }, 'send_temp_message'), { scene: 'private', peerId: 10001 });
  assert.equal(toolConversation({ group_id: '20001' }, 'send_temp_message'), null);
  assert.equal(toolConversation({}), null);
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '', ' 123', '1e3', '1.2', '9007199254740992', null, true]) assert.throws(() => milkyId(value));
});

test('真实事件接收 Module 去重、保留作者并避免自身消息触发', () => {
  const store = new Store(join(process.cwd(), '.artifacts/tests', `${randomUUID()}.sqlite`));
  try {
    store.createRole({ id: 'listener', name: '观察者', accountId: 'main', initialPersona: '观察真实事件', provider: 'kw-chat', model: 'cn:deepseek-v4.1-flash', groups: [123], contacts: [], globalGroups: false, defaultPrivate: false, worldMode: 'real', state: 'disabled', memoryTokens: 8192, dailyRequests: null, dailyTokens: null, activeHours: null });
    const client = new MilkyClient(loadConfig().milky, store);
    client.selfId = 456;
    const observed: string[] = [];
    const receiver = new MilkyEvents(client, store, event => { observed.push(event.id); });
    const packet = { event_type: 'message_receive', time: 1000, self_id: 456, data: { message_scene: 'group', peer_id: 123, message_seq: 7, sender_id: 789, time: 1000, segments: [{ type: 'text', data: { text: '一起读书' } }] } };
    receiver.accept(packet); receiver.accept(packet);
    assert.equal(observed.length, 1);
    assert.equal(store.events('listener')[0]?.senderId, 789);
    receiver.accept({ ...packet, data: { ...packet.data, message_seq: 8, sender_id: 456 } });
    assert.equal(store.pending('listener').length, 1);
    assert.throws(() => receiver.accept({ ...packet, self_id: 999 }), /账号/);
  } finally { store.close(); }
});

test('Markdown 在远程调用和操作记录之前拒绝，包括嵌套转发', async () => {
  const store = new Store(join(process.cwd(), '.artifacts/tests', `${randomUUID()}.sqlite`));
  const client = new MilkyClient(loadConfig().milky, store);
  const markdown = { type: 'markdown', data: { content: '# 标题' } };
  try {
    for (const name of ['send_group_message', 'send_private_message', 'send_temp_message']) {
      await assert.rejects(client.execute(name, { message: [markdown] }, null), /不支持 Markdown/);
      await assert.rejects(client.execute(name, { message: [{ type: 'forward', data: { messages: [{ segments: [{ type: 'forward', data: { messages: [{ segments: [markdown] }] } }] }] } }] }, null), /不支持 Markdown/);
      await assert.rejects(client.execute(name, { message: [{ type: 'text', data: { text: '# 普通文字里的 Markdown 符号' } }] }, null), /工具不存在/);
    }
    assert.equal(store.operations().length, 0);
  } finally { await client.close(); store.close(); }
});

test('媒体真实保存、签名授权、Range 与角色归属', async () => {
  const root = join(process.cwd(), '.artifacts/tests', randomUUID());
  const store = new Store(join(root, 'kwagent', 'state.sqlite'));
  try {
    store.createRole({ id: 'reader', name: '读者', accountId: 'main', initialPersona: '阅读资料', provider: 'kw-chat', model: 'cn:deepseek-v4.1-flash', groups: [], contacts: [], globalGroups: false, defaultPrivate: false, worldMode: 'real', state: 'disabled', memoryTokens: 8192, dailyRequests: null, dailyTokens: null, activeHours: null });
    const directory = join(root, 'workspaces', 'reader');
    await mkdir(directory, { recursive: true });
    const source = join(directory, 'notes.txt');
    await writeFile(source, 'abcdefghijklmnopqrstuvwxyz');
    const config = loadConfig({ KW_DATA_ROOT: root, KW_PUBLIC_URL: 'https://kw.example/' });
    const mediaModule = new MediaModule(store, config, new MilkyClient(config.milky, store));
    const media = await mediaModule.import('reader', pathToFileURL(source).href);
    const prepared = await mediaModule.prepare('reader', media.id);
    const response = await mediaModule.serve(new Request(prepared.uri, { headers: { Range: 'bytes=2-5' } }));
    assert.equal(response.status, 206);
    assert.equal(await response.text(), 'cdef');
    const invalid = new URL(prepared.uri); invalid.searchParams.set('signature', '0'.repeat(64));
    assert.equal((await mediaModule.serve(new Request(invalid))).status, 403);
    assert.deepEqual(await mediaModule.inspect('reader', media.id), { text: 'abcdefghijklmnopqrstuvwxyz' });
  } finally { store.close(); }
});
