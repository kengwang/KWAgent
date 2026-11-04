import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Store, Payloads, roleInputSchema, roleSchema, ConflictError, now } from '@kwagent/core';
import { preparePerception } from '../packages/kw-life/src/perception.ts';

function environment() {
  const store = new Store(join(process.cwd(), '.artifacts/tests', randomUUID(), 'state.sqlite'));
  const role = store.createRole(roleInputSchema.parse({ id: 'lifecycle', accountId: 'main', name: '会话管理', initialPersona: '保留既有认识。', provider: 'kw-chat', model: 'configured-model', groups: [20001], contacts: [10001], globalGroups: true, defaultPrivate: true }));
  const event = (text: string) => store.appendEvent({ accountId: 'main', roleId: role.id, source: 'manual', type: 'manual', occurredAt: now(), scene: 'group', peerId: 20001, senderId: 10001, messageSeq: null, self: false, payload: { text } }).event;
  return { store, role, event };
}

test('重置会话保留角色与长期记忆，只重新投递尚未接纳的消息', () => {
  const { store, role, event } = environment();
  try {
    const completed = event('已经完成的经历'); const accepted = event('已经接纳的输入'); const queued = event('尚未接纳的输入');
    store.delivery([completed.id], 'completed-input', 'completed'); store.delivery([accepted.id], 'accepted-input', 'delivered'); store.delivery([queued.id], 'queued-input', 'delivered');
    const memory = store.saveMemory({ roleId: role.id, kind: 'episode', title: '本地经历', content: '保留已保存的经历。', realm: 'real', epistemic: 'reported', people: [], aliases: [], sources: [completed.id], archived: false, attention: 0.5 }, null, 'owner', '真实数据库验收');
    assert.throws(() => store.rotateRoleSession(role.id, 'new-session', 99, ['accepted-input'], '冲突'), ConflictError);
    const reset = store.rotateRoleSession(role.id, 'new-session', role.revision, ['accepted-input'], '重置对话');
    for (const key of ['id', 'accountId', 'initialPersona', 'persona', 'selfState', 'groups', 'contacts', 'globalGroups', 'defaultPrivate'] as const) assert.deepEqual(reset[key], role[key]);
    assert.equal(store.memory(memory.id).revision, memory.revision);
    assert.equal(store.deliveryStatus(completed.id).state, 'completed'); assert.equal(store.deliveryStatus(accepted.id).state, 'completed'); assert.equal(store.deliveryStatus(queued.id).state, 'prepared');
    assert.equal(store.deliveryStatus(queued.id).messageId, 'reset:new-session:queued-input');
    store.recoverDeliveries(role.id, []);
    assert.equal(store.deliveryStatus(completed.id).state, 'completed'); assert.equal(store.deliveryStatus(accepted.id).state, 'completed');
    assert.equal(store.pending(role.id).some(item => item.id === queued.id), true);
    assert.equal(store.meta(`session-owner:${role.sessionId}`), role.id); assert.equal(store.meta('session-owner:new-session'), role.id);
    assert.ok(Number(store.meta(`context-since:${role.id}`)) >= queued.seq);
    const other = store.createRole(roleInputSchema.parse({ id: 'other', accountId: 'main', name: '另一个角色', initialPersona: '独立。', provider: 'kw-chat', model: 'configured-model' }));
    assert.throws(() => store.rotateRoleSession(role.id, other.sessionId, reset.revision, [], '跨角色'), /其他角色/);
    assert.equal(store.history('role', role.id).length, 2);
  } finally { store.close(); }
});

test('重置识别已接纳但仍处于prepared的输入，重新打开后保持完成', () => {
  const { store, role, event } = environment();
  const accepted = event('Session 已接纳，投递确认尚未更新');
  const pending = event('尚未被 Session 接纳');
  store.delivery([accepted.id], 'persisted-input', 'prepared');
  store.delivery([pending.id], 'unaccepted-input', 'prepared');
  store.close();
  const recovered = new Store(store.path);
  try {
    recovered.rotateRoleSession(role.id, 'after-delivery-interruption', role.revision, ['persisted-input'], '核对已接纳输入');
    assert.deepEqual(recovered.deliveryStatus(accepted.id), { messageId: 'persisted-input', state: 'completed' });
    assert.equal(recovered.deliveryStatus(pending.id).state, 'prepared');
    assert.equal(recovered.deliveryStatus(pending.id).messageId, 'reset:after-delivery-interruption:unaccepted-input');
  } finally { recovered.close(); }
  const reopened = new Store(store.path);
  try {
    reopened.recoverDeliveries(role.id, []);
    assert.equal(reopened.deliveryStatus(accepted.id).state, 'completed');
    assert.equal(reopened.pending(role.id).some(item => item.id === accepted.id), false);
    assert.equal(reopened.pending(role.id).some(item => item.id === pending.id), true);
  } finally { reopened.close(); }
});

test('新对话重新整理待处理感知，删除后仍可创建历史正文读取引用', async () => {
  const { store, role, event } = environment();
  const payloads = new Payloads(store, join(store.path, '..', 'artifacts'));
  try {
    const before = event('旧上下文内容'); store.delivery([before.id], 'completed', 'completed');
    const queued = event('尚未接纳的新输入'); store.delivery([queued.id], 'queued', 'prepared');
    const old = await preparePerception(store, payloads, role.id, [queued], 'queued', 8192);
    assert.ok(JSON.stringify(old).includes(before.id));
    const changed = store.rotateRoleSession(role.id, 'next', role.revision, [], '重置');
    const frame = await preparePerception(store, payloads, role.id, [queued], store.deliveryStatus(queued.id).messageId!, 8192);
    assert.notEqual(old.id, frame.id); assert.ok(!JSON.stringify(frame).includes(before.id));
    assert.deepEqual(store.frame('queued'), old); assert.ok(frame.eventIds.includes(queued.id));
    store.deleteRole(role.id, changed.revision);
    const detail = await payloads.put(role.id, 'deleted-history', { eventId: before.id });
    assert.deepEqual(await payloads.value(role.id, detail.payloadId), { eventId: before.id });
    await assert.rejects(payloads.put('missing', 'history', {}), /不存在/);
  } finally { store.close(); }
});

test('删除角色释放归属、隐藏活动列表并保留原始经历和修订', () => {
  const { store, role, event } = environment();
  try {
    const source = event('保留原始资料');
    const revision = Number(store.meta('roles-generation'));
    assert.throws(() => store.deleteRole(role.id, 99), ConflictError);
    const deleted = store.deleteRole(role.id, role.revision);
    assert.ok(deleted.deletedAt); assert.equal(deleted.state, 'stopped'); assert.deepEqual(deleted.groups, []); assert.deepEqual(deleted.contacts, []);
    assert.equal(store.roles().length, 0); assert.equal(store.list('role', roleSchema).length, 0); assert.throws(() => store.role(role.id), /已删除/);
    assert.equal(store.event(source.id).roleId, role.id); assert.equal(store.history('role', role.id).length, 2);
    assert.equal(store.route('main', 'group', 20001), null); assert.equal(store.route('main', 'private', 10001), null);
    assert.equal(Number(store.meta('roles-generation')), revision + 1);
    assert.throws(() => store.createRole(roleInputSchema.parse({ ...role, sessionId: undefined })), ConflictError);
    store.createRole(roleInputSchema.parse({ id: 'replacement', accountId: 'main', name: role.name, initialPersona: role.initialPersona, provider: role.provider, model: role.model, groups: [20001], contacts: [10001], globalGroups: true, defaultPrivate: true }));
    assert.equal(store.route('main', 'group', 20001), 'replacement');
  } finally { store.close(); }
});

test('重置中真实数据库拒绝写入时，角色、投递和边界信息一起撤销', () => {
  const { store, role, event } = environment();
  try {
    const source = event('尚未完成'); store.delivery([source.id], 'input', 'delivered');
    store.db.exec("CREATE TEMP TRIGGER reject_reset BEFORE INSERT ON events WHEN NEW.type='session-reset' BEGIN SELECT RAISE(ABORT,'禁止本次写入'); END");
    assert.throws(() => store.rotateRoleSession(role.id, 'new-session', role.revision, ['input'], '失败验收'), /禁止本次写入/);
    assert.equal(store.role(role.id).sessionId, role.sessionId); assert.equal(store.role(role.id).revision, role.revision);
    assert.equal(store.deliveryStatus(source.id).state, 'queued'); assert.equal(store.meta(`context-since:${role.id}`), undefined);
    assert.equal(store.history('role', role.id).length, 1);
  } finally { store.close(); }
});

test('Schema 3升级保存一致快照，已删除角色在重新打开后保持删除', () => {
  const { store, role } = environment(); const path = store.path;
  store.db.exec('DROP INDEX live_roles; PRAGMA user_version=3'); store.close();
  const migrated = new Store(path);
  try {
    assert.equal(migrated.db.prepare('PRAGMA user_version').get()?.user_version, 4);
    const snapshot = readdirSync(join(path, '..')).find(name => name.includes('.schema3-')); assert.ok(snapshot);
    const before = new DatabaseSync(join(path, '..', snapshot)); assert.equal(before.prepare('PRAGMA user_version').get()?.user_version, 3); before.close();
    migrated.deleteRole(role.id, role.revision); migrated.close();
    const reopened = new Store(path); assert.equal(reopened.roles().length, 0); assert.ok(reopened.get('role', role.id, roleSchema)?.deletedAt); reopened.close();
  } finally { migrated.close(); }
});
