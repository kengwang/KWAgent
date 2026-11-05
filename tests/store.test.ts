import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, ConflictError, now, type RoleInput } from '@kwagent/core';

const testRoot = join(process.cwd(), '.artifacts/tests');
mkdirSync(testRoot, { recursive: true });
function database(): Store { return new Store(join(testRoot, `${randomUUID()}.sqlite`)); }
function role(id: string, extra: Partial<RoleInput> = {}): RoleInput {
  return { id, name: id, accountId: 'main', initialPersona: '喜欢科学与音乐，尊重自己的判断。', worldMode: 'real', provider: 'kw-chat', model: 'cn:deepseek-v4.1-flash', state: 'disabled', groups: [], contacts: [], globalGroups: false, defaultPrivate: false, memoryTokens: 8192, dailyRequests: null, dailyTokens: null, activeHours: null, ...extra };
}

test('角色绑定、版本冲突和重新打开数据库保持真实持久状态', () => {
  const store = database();
  try {
    const a = store.createRole(role('alice', { groups: [123], defaultPrivate: true }));
    store.createRole(role('bob', { globalGroups: true }));
    assert.equal(store.route('main', 'group', 123), 'alice');
    assert.equal(store.route('main', 'group', 456), 'bob');
    assert.equal(store.route('main', 'private', 789), 'alice');
    assert.throws(() => store.createRole(role('other', { groups: [123] })), /绑定/);
    const changed = store.updateRole(a.id, { persona: '喜欢观察植物的生长。' }, 1, 'owner', '调整角色');
    assert.equal(changed.revision, 2);
    assert.throws(() => store.updateRole(a.id, { persona: '过期内容' }, 1, 'owner', '冲突'), ConflictError);
    assert.equal(store.history('role', a.id).length, 2);
    store.close();
    const reopened = new Store(store.path);
    assert.equal(reopened.role(a.id).persona, changed.persona);
    assert.equal(reopened.integrity(), 'ok');
    reopened.close();
  } finally { store.close(); }
});

test('消息去重、历史核对位置与事务撤销', () => {
  const store = database();
  try {
    store.createRole(role('alice'));
    const input = { accountId: 'main', roleId: 'alice', source: 'milky' as const, type: 'message_receive', occurredAt: now(), scene: 'group', peerId: 123, senderId: 456, messageSeq: 9, self: false, payload: { text: '周末一起去看展览' } };
    const event = store.appendEvent(input);
    assert.equal(store.appendEvent(input).inserted, false);
    assert.equal(store.events('alice').length, 1);
    assert.equal(store.cursor('main', 'group', 123)?.initialized, false);
    store.confirm('main', 'group', 123, 7);
    assert.deepEqual(store.cursor('main', 'group', 123), { live: 9, confirmed: 7, initialized: true });
    assert.throws(() => store.transaction(() => { store.setMeta('atomic', 'value'); throw new Error('终止事务'); }), /终止事务/);
    assert.equal(store.meta('atomic'), undefined);
    store.delivery([event.event.id], 'message', 'delivered');
    assert.equal(store.pending('alice').length, 0);
    const later = store.appendEvent({ ...input, messageSeq: 10 }).event;
    store.delivery([later.id], 'prepared-message', 'prepared');
    store.appendEvent({ ...input, messageSeq: 11 });
    assert.deepEqual(store.pendingBatch('alice').events.map(event => event.id), [later.id]);
    assert.equal(store.pendingBatch('alice').messageId, 'prepared-message');
    store.delivery([later.id], 'prepared-message', 'delivered');
    store.recoverDeliveries('alice', ['message']);
    assert.equal(store.pendingBatch('alice').messageId, 'prepared-message');
    store.completeDelivered('alice', ['message']);
    assert.ok(store.pending('alice').some(event => event.id === later.id));
    store.appendEvent({ ...input, source: 'manual', scene: 'private', peerId: 10001, messageSeq: null });
    assert.deepEqual(store.peers('main', 'private'), []);
    assert.deepEqual(store.peers('main', 'group'), [123]);
  } finally { store.close(); }
});

test('已处理投递不能被迟到写入降级，重复收信和重启不会重新排队', () => {
  const store = database();
  try {
    store.createRole(role('alice'));
    const input = { accountId: 'main', roleId: 'alice', source: 'milky' as const, type: 'message_receive', occurredAt: now(), scene: 'group', peerId: 123, senderId: 456, messageSeq: 99, self: false, payload: { text: '只处理一次' } };
    const first = store.appendEvent(input).event;
    store.delivery([first.id], 'stable-input', 'prepared'); store.completeDelivered('alice', ['stable-input']);
    store.delivery([first.id], 'late-preparation', 'prepared'); store.delivery([first.id], 'late-delivery', 'delivered');
    assert.deepEqual(store.deliveryStatus(first.id), { messageId: 'stable-input', state: 'completed' });
    assert.equal(store.appendEvent(input).inserted, false); store.recoverDeliveries('alice', []);
    assert.equal(store.pending('alice').length, 0); const path = store.path; store.close();
    const reopened = new Store(path); assert.equal(reopened.deliveryStatus(first.id).state, 'completed'); assert.equal(reopened.pending('alice').length, 0); reopened.close();
  } finally { store.close(); }
});

test('中文全文检索、来源版本和备份在真实数据库提交', async () => {
  const store = database();
  try {
    store.createRole(role('alice'));
    store.createRole(role('bob'));
    const a = store.saveMemory({ id: null, roleId: 'alice', kind: 'person', title: '共同兴趣', content: '我们喜欢观察植物和研究科学。', realm: 'real', epistemic: 'observed', people: ['456'], aliases: ['园艺'], sources: ['role:alice'], archived: false, attention: 0.7 }, null, 'owner', '记录兴趣');
    store.saveMemory({ roleId: 'bob', kind: 'world', title: '另一个角色', content: '植物观察', realm: 'real', epistemic: 'reported', people: [], aliases: [], sources: ['role:bob'], archived: false, attention: 0.5 }, null, 'owner', '记录');
    assert.equal(store.lexical({ roleId: 'alice', query: '观察植物', limit: 20, semantic: false, archived: false })[0]?.id, a.id);
    assert.equal(store.rebuildSearch().count, 2);
    assert.throws(() => store.saveMemory({ ...a, content: '没有来源的内容', sources: ['missing'] }, 1, 'alice', '修订'), /来源/);
    assert.equal(store.memory(a.id).revision, 1);
    assert.throws(() => store.saveMemory({ ...a, id: null, people: ['同名昵称'] }, null, 'alice', '检查稳定账号身份'), /账号标识/);
    const source = store.appendEvent({ accountId: 'main', roleId: 'alice', source: 'milky', type: 'message_receive', occurredAt: now(), scene: 'group', peerId: 123, senderId: 456, messageSeq: 100, self: false, payload: { text: '一起观察向日葵。' } }).event;
    const sourced = store.saveMemory({ ...a, id: null, title: '群内观察', sources: [source.id] }, null, 'alice', '保存来源');
    assert.deepEqual(store.lexical({ roleId: 'alice', query: '', scene: 'group', peerId: 123, limit: 20, semantic: false, archived: false }).map(memory => memory.id), [sourced.id]);
    assert.equal(store.lexical({ roleId: 'alice', query: '', scene: 'private', peerId: 123, limit: 20, semantic: false, archived: false }).length, 0);
    const destination = join(testRoot, `${randomUUID()}-backup.sqlite`);
    await store.backup(destination);
    const restored = new Store(destination);
    assert.equal(restored.memory(a.id).content, a.content);
    assert.equal(restored.integrity(), 'ok');
    restored.close();
  } finally { store.close(); }
});
