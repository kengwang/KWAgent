import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Store, roleInputSchema } from '@kwagent/core';
import { DailyMemory } from '../packages/kw-life/src/daily-memory.ts';

function environment() {
  const path = join(process.cwd(), '.artifacts/tests', randomUUID(), 'state.sqlite');
  const store = new Store(path);
  const role = store.createRole(roleInputSchema.parse({ id: 'daily', accountId: 'main', name: '每日整理', initialPersona: '保存真实经历。', provider: 'configured', model: 'configured' }));
  const at = (clock: string, offset = 0) => new Date(`${new Date(Date.parse(role.createdAt) + (offset + 2) * 86400000).toISOString().slice(0, 10)}T${clock}+08:00`);
  return { path, store, role, at };
}

test('每日整理在上海02:00到期，同日一次，次日再次到期', () => {
  const { store, role, at } = environment();
  try {
    const schedule = new DailyMemory(store, 'Asia/Shanghai', at('01:59:00'));
    assert.equal(schedule.due(role, new Date(at('01:59:59').toISOString())), false);
    assert.equal(schedule.claim(role, new Date(at('02:00:00').toISOString())), true);
    assert.equal(schedule.claim(role, at('12:00:00')), false);
    assert.equal(schedule.claim(role, at('01:59:59', 1)), false);
    assert.equal(schedule.claim(role, at('02:00:00', 1)), true);
  } finally { store.close(); }
});

test('首次白天升级等待下一天02:00，不立即启动已有积压整理', () => {
  const { store, role, at } = environment();
  try {
    const schedule = new DailyMemory(store, 'Asia/Shanghai', at('12:00:00'));
    assert.equal(schedule.claim(role, at('12:00:00')), false);
    assert.equal(schedule.claim(role, at('23:59:59')), false);
    assert.equal(schedule.claim(role, at('02:00:00', 1)), true);
  } finally { store.close(); }
});

test('未领取的凌晨机会可顺延，领取后关闭数据库与重启不会重复', () => {
  const { path, store, role, at } = environment();
  const schedule = new DailyMemory(store, 'Asia/Shanghai', at('01:00:00'));
  assert.equal(schedule.due(role, at('02:00:00')), true);
  assert.equal(schedule.due(role, at('09:00:00')), true);
  assert.equal(schedule.claim(role, at('09:01:00')), true);
  store.close();
  const reopened = new Store(path);
  try {
    const recovered = new DailyMemory(reopened, 'Asia/Shanghai', at('10:00:00'));
    assert.equal(recovered.claim(role, at('10:00:00')), false);
    assert.equal(recovered.claim(role, at('02:00:00', 1)), true);
  } finally { reopened.close(); }
});

test('每日领取使用事务且角色独立，时钟回退不会重复领取', () => {
  const { store, role, at } = environment();
  try {
    const other = store.createRole(roleInputSchema.parse({ id: 'other', accountId: 'main', name: '独立角色', initialPersona: '独立经历。', provider: 'configured', model: 'configured' }));
    const schedule = new DailyMemory(store, 'Asia/Shanghai', at('01:00:00'));
    assert.throws(() => store.transaction(() => { assert.equal(schedule.claim(role, at('02:00:00')), true); throw new Error('事务中断'); }), /事务中断/);
    assert.equal(schedule.claim(role, at('02:00:00')), true);
    assert.equal(schedule.claim(other, at('02:00:00')), true);
    assert.equal(schedule.claim(role, at('23:00:00', -1)), false);
    assert.equal(store.role(role.id).revision, role.revision);
  } finally { store.close(); }
});
