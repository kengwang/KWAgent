import { loadEnvFile } from 'node:process';
import { request } from 'node:http';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

loadEnvFile('.env');
const root = resolve(process.env.KW_DATA_ROOT ?? './data');
const socketPath = process.platform === 'win32' ? String.raw`\\.\pipe\kwagent-${createHash('sha256').update(root).digest('hex').slice(0, 16)}` : join(root, 'run/admin.sock');
function call(action, payload = null) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: `/${encodeURIComponent(action)}`, method: 'POST' }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
      response.on('end', () => { const result = JSON.parse(text); result.ok ? resolve(result.result) : reject(new Error(result.error)); });
    });
    req.on('error', reject); req.end(JSON.stringify(payload));
  });
}
async function until(check, description) {
  const end = Date.now() + 180000;
  while (Date.now() < end) {
    const state = await call('status', { roleId: id });
    const role = state.roles.find(role => role.id === id);
    if (role.runtime.error) throw new Error(role.runtime.error);
    if (await check(state)) return state;
    await delay(1000);
  }
  throw new Error(`等待超时：${description}`);
}
const id = `life-${Date.now()}`;
for (const extension of (await call('status')).extensions) {
  if (extension.packageName !== 'kwagent-verification-observer' || !extension.roleId.startsWith('life-') || !extension.enabled) continue;
  await call('role.control', { id: extension.roleId, state: 'paused' });
  await call('extension', { roleId: extension.roleId, request: { action: 'disable', id: extension.id } });
}
const observationsPath = join(root, 'workspaces/verification-observer/observations.jsonl');
let offset = 0;
try { offset = (await readFile(observationsPath, 'utf8')).length; } catch (error) { if (error.code !== 'ENOENT') throw error; }
const observations = async () => (await readFile(observationsPath, 'utf8')).slice(offset).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
await call('role.create', { id, accountId: 'main', name: '自主活动验收', provider: process.env.KW_LLM_PROVIDER, model: process.env.KW_LLM_MODEL,
  initialPersona: '你在本地验收环境中观察植物。只使用内部的 memory、life_plan 和 verification_observe 工具。初始化时调用 verification_observe，stage=initialize，记录一条植物观察，再使用 life_plan 创建延迟十五秒的一次事项，要求醒来后调用 verification_observe，stage=timer。随后休息。收到人工事件时调用 verification_observe，stage=manual，记录该事件。保持安静，使用真实工具执行，不发送 QQ 消息，不创建其他事项。' });
await call('role.prepare', { id });
let extension = await call('extension', { roleId: id, request: { action: 'install', id: 'observer', spec: resolve('tests/fixtures/activity-observer') } });
assert.equal(extension.state, 'installed');
await call('extension', { roleId: id, request: { action: 'enable', id: 'observer' } });
try {
  await call('role.control', { id, state: 'active' });
  await until(async state => (await observations()).some(row => row.stage === 'timer') && state.roles.find(role => role.id === id).runtime.state === 'waiting', '自主创建事项并再次唤醒');
  await call('role.control', { id, state: 'paused' });
  const before = (await observations()).filter(row => row.stage === 'manual').length;
  await call('event', { roleId: id, text: '人工观察：叶片上有三颗水珠。恢复活动后保存这条观察。' });
  await delay(1500);
  assert.equal((await observations()).filter(row => row.stage === 'manual').length, before);
  await call('role.control', { id, state: 'active' });
  await until(async state => (await observations()).some(row => row.stage === 'manual') && state.roles.find(role => role.id === id).runtime.state === 'waiting', '恢复后处理积累事件');
  const state = await call('status', { roleId: id });
  assert.ok(state.memories.length > 0);
  assert.ok(state.plans.some(plan => plan.kind === 'time' && plan.status === 'completed'));
  await call('role.control', { id, state: 'paused' });
  const compacted = await call('role.compact', { id });
  assert.ok(compacted, '需要实际发生上下文压缩');
  const recalled = await call('memory.recall', { roleId: id, query: '观察', semantic: false });
  assert.ok(recalled.length > 0);
  extension = await call('extension', { roleId: id, request: { action: 'disable', id: 'observer' } });
  assert.equal(extension.enabled, false);
  const records = await observations();
  assert.ok(records.filter(row => row.lifecycle === 'mounted').length >= 2);
  assert.ok(records.filter(row => row.lifecycle === 'disposed').length >= 2);
  assert.equal(records.filter(row => row.stage === 'timer').length, 1);
  const result = { roleId: id, stages: records.filter(row => row.stage).map(row => row.stage), memories: state.memories.length, schedules: state.plans.map(plan => plan.status), extension: extension.state, pauseResume: true, compacted: true, recalledAfterCompaction: recalled.length };
  await mkdir('.artifacts/verification', { recursive: true });
  await writeFile('.artifacts/verification/life.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await call('role.control', { id, state: 'paused' });
  const state = await call('status', { roleId: id });
  if (state.extensions.some(extension => extension.id === 'observer' && extension.enabled)) await call('extension', { roleId: id, request: { action: 'disable', id: 'observer' } });
}
