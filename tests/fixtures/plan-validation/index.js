import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const name = 'kwagent-plan-validation';
export const inject = ['kwLife', 'schedule'];
export async function apply(ctx) {
  const life = ctx.kwLife;
  const extension = life.store.extensions().find(extension => extension.enabled && extension.packageName === 'kwagent-plan-validation');
  assert.ok(extension);
  const roleId = extension.roleId;
  ctx.on('agent/pre-step', async () => ({ kind: 'reject' }));
  const valid = await life.plans.mutate(roleId, { action: 'create', kind: 'time', title: '有效事项', instruction: '验证提醒过滤。', timing: { kind: 'after', after_seconds: 3600 } });
  const cancelled = await life.plans.mutate(roleId, { action: 'create', kind: 'time', title: '取消事项', instruction: '这条事项取消后应被过滤。', timing: { kind: 'after', after_seconds: 3600 } });
  const tasks = await ctx.schedule.list({ sessionId: life.store.role(roleId).sessionId });
  const validTask = tasks.find(task => task.id === valid.scheduleId);
  const cancelledTask = tasks.find(task => task.id === cancelled.scheduleId);
  assert.ok(validTask); assert.ok(cancelledTask);
  await life.plans.mutate(roleId, { action: 'cancel', id: cancelled.id, expectedRevision: cancelled.revision });
  const notices = [{ prompt: validTask.prompt, occurrence: valid.timing.at }, { prompt: cancelledTask.prompt, occurrence: cancelled.timing.at }];
  const selected = await life.plans.filterNotices(roleId, notices, `${roleId}:batch`);
  assert.deepEqual(selected, [notices[0]]);
  assert.deepEqual(await life.plans.filterNotices(roleId, notices, `${roleId}:batch`), selected);
  assert.deepEqual(await life.plans.filterNotices(roleId, notices, `${roleId}:duplicate`), []);
  const directory = join(process.env.KW_DATA_ROOT, 'workspaces', roleId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'plan-validation.json'), JSON.stringify({ selected: selected.length, invalidFiltered: true, duplicateFiltered: true, stableReplay: true }));
}
