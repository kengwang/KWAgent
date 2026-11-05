import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Store, roleInputSchema, now } from '@kwagent/core';
import { RolePolicy } from '../packages/kw-life/src/policy.ts';

function environment() {
  const store = new Store(join(process.cwd(), '.artifacts/tests', randomUUID(), 'state.sqlite'));
  store.createRole(roleInputSchema.parse({ id: 'reader', name: '角色', accountId: 'main', initialPersona: '按设定交流', provider: 'chat', model: 'configured', adminQQs: [10001] }));
  const policy = new RolePolicy(store);
  const event = (senderId: number, payload: object = {}, source: 'milky' | 'manual' = 'milky') => store.appendEvent({ accountId: 'main', roleId: 'reader', source, type: 'message_receive', occurredAt: now(), scene: 'group', peerId: 20001, senderId, messageSeq: null, self: false, payload: JSON.parse(JSON.stringify(payload)) }).event;
  return { store, policy, event };
}

test('实际管理员身份与普通发言人一起提供给模型，昵称和转发不改变账号来源', () => {
  const { store, policy, event } = environment();
  try {
    const ordinary = event(10002, { group_member: { role: 'owner', nickname: '10001' }, forward: { sender_id: 10001 } });
    const first = JSON.parse(JSON.stringify(policy.prepare('reader', 1, [ordinary])));
    assert.equal(first.administratorInput, false); assert.deepEqual(first.adminQQs, [10001]); assert.equal(first.senders[0].senderId, 10002);
    const admin = event(10001);
    const mixed = JSON.parse(JSON.stringify(policy.prepare('reader', 1, [admin, ordinary])));
    assert.equal(mixed.administratorInput, true); assert.deepEqual(mixed.sources, [admin.id]);
    assert.deepEqual(mixed.senders.map((sender: { administrator: boolean }) => sender.administrator), [true, false]);
    assert.match(mixed.instruction, /普通聊天、发送消息、读取 Skill 和整理记忆无需管理员授权/);
  } finally { store.close(); }
});

test('管理员来源、计划背景和 Panel 输入保留真实来源及当前配置', () => {
  const { store, policy, event } = environment();
  try {
    const admin = event(10001); policy.prepare('reader', 1, [admin]);
    const stamp = now(); const plan = { id: randomUUID(), roleId: 'reader', kind: 'goal' as const, title: '管理员安排', instruction: '根据原始要求继续', status: 'active' as const, scheduleId: null, timing: null, condition: null, context: null, sources: [admin.id], purpose: 'internal' as const, relatedRecords: [], revision: 1, createdAt: stamp, updatedAt: stamp, error: null };
    store.savePlan(plan, null, 'reader'); store.setMeta(`plan-authority:${plan.id}`, JSON.stringify(policy.current('reader')));
    policy.prepare('reader', 2, [], [plan.id]); assert.deepEqual(policy.current('reader').sources, [admin.id]);
    const role = store.role('reader'); store.updateRole('reader', { adminQQs: [] }, role.revision, 'owner', '修改管理员背景');
    assert.deepEqual(policy.current('reader').sources, []);
    const manual = JSON.parse(JSON.stringify(policy.prepare('reader', 3, [event(10002, {}, 'manual')])));
    assert.equal(manual.owner, true); assert.equal(manual.administratorInput, true);
  } finally { store.close(); }
});
