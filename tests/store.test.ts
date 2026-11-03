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
  } finally { store.close(); }
});

test('中文全文检索、真实 vec0 查询和来源版本在同一数据库提交', async () => {
  const store = database();
  try {
    store.createRole(role('alice'));
    store.createRole(role('bob'));
    store.ensureVectorIndex('mathematical-test-space', 3);
    const a = store.saveMemory({ roleId: 'alice', kind: 'person', title: '共同兴趣', content: '我们喜欢观察植物和研究科学。', realm: 'real', epistemic: 'observed', people: ['456'], aliases: ['园艺'], sources: ['role:alice'], archived: false, attention: 0.7 }, null, 'owner', '记录兴趣', [1, 0, 0]);
    store.saveMemory({ roleId: 'bob', kind: 'world', title: '另一个角色', content: '植物观察', realm: 'real', epistemic: 'reported', people: [], aliases: [], sources: ['role:bob'], archived: false, attention: 0.5 }, null, 'owner', '记录', [1, 0, 0]);
    assert.equal(store.lexical({ roleId: 'alice', query: '观察植物', limit: 20, semantic: false, archived: false })[0]?.id, a.id);
    assert.deepEqual(store.vectorSearch('alice', [1, 0, 0], 5).map(value => value.id), [a.id]);
    assert.throws(() => store.saveMemory({ ...a, content: '没有来源的内容', sources: ['missing'] }, 1, 'alice', '修订'), /来源/);
    assert.equal(store.memory(a.id).revision, 1);
    const destination = join(testRoot, `${randomUUID()}-backup.sqlite`);
    await store.backup(destination);
    const restored = new Store(destination);
    assert.equal(restored.memory(a.id).content, a.content);
    assert.equal(restored.integrity(), 'ok');
    restored.close();
  } finally { store.close(); }
});
