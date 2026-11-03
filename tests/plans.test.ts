import test from 'node:test';
import assert from 'node:assert/strict';
import { timingSchema, scheduleNotices, normalizeTiming } from '../packages/kw-life/src/plans.ts';
import remote from '../packages/kw-panel/src/remote.ts';
import { isTypertRemoteMethod } from '@deepseek-ai/dsh-typert-protocol';

test('时间规则使用公开时间字段，拒绝无效频率', () => {
  assert.throws(() => timingSchema.parse({ kind: 'every', every_seconds: 10 }));
  assert.throws(() => timingSchema.parse({ kind: 'daily', daily: { time: '25:99' } }));
  assert.deepEqual(timingSchema.parse({ kind: 'daily', daily: { time: '09:00' } }), { kind: 'daily', daily: { time: '09:00', time_zone: 'Asia/Shanghai' } });
});

test('单次提醒保存原定时间，RRULE 保存稳定的起始时间', () => {
  const clock = Date.parse('2026-11-03T00:00:00Z');
  assert.deepEqual(normalizeTiming({ kind: 'after', after_seconds: 60 }, clock), { kind: 'at', at: '2026-11-03T00:01:00.000Z' });
  assert.match(JSON.stringify(normalizeTiming({ kind: 'rrule', rrule: 'FREQ=MINUTELY;INTERVAL=2' }, clock)), /DTSTART:20261103T000000Z/);
  assert.throws(() => normalizeTiming({ kind: 'rrule', rrule: 'invalid' }, clock));
});

test('读取实际 Harness 单次与批量提醒格式', () => {
  const prompt = 'KWAGENT_PLAN\n{"planId":"plan","revision":2,"instruction":"阅读"}';
  const single = `[SCHEDULE REMINDER]\noccurrence_at: 2026-11-03T09:00:00.000Z\nreminder_prompt_json: ${JSON.stringify(prompt)}`;
  assert.equal(scheduleNotices(single)[0]?.prompt, prompt);
  const batch = `[SCHEDULE REMINDER BATCH]\nreminders_json: ${JSON.stringify([{ occurrence_at: '2026-11-03T09:00:00.000Z', reminder_prompt: prompt }])}`;
  assert.equal(scheduleNotices(batch)[0]?.prompt, prompt);
});

test('Typert 的严格输入与状态流项目使用实际协议 codec', () => {
  const query = remote.descriptors.find(item => item.method === 'query');
  const follow = remote.descriptors.find(item => item.method === 'follow');
  assert.ok(query); assert.ok(follow);
  assert.ok(isTypertRemoteMethod(query));
  assert.equal(follow.result?.mode, 'strict');
  assert.deepEqual(query.input().create().parse({ action: 'status', payload: 'null' }), { action: 'status', payload: 'null' });
  assert.throws(() => query.input().create().parse({ action: 3, payload: null }));
  if (follow.result?.mode === 'strict') assert.deepEqual(follow.result.create().parse({ revision: 1, payload: '{}' }), { revision: 1, payload: '{}' });
});
