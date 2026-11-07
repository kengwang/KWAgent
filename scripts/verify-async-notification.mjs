import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

loadEnvFile('.env');
const root = resolve('.artifacts/async-notification', String(Date.now())), port = 3110;
await mkdir(root, { recursive: true });
const env = { ...process.env, KW_DATA_ROOT: root, DSH_HOME: join(root, 'dsh'), KW_HOST_PORT: String(port), KW_PUBLIC_URL: `http://127.0.0.1:${port}/`, KW_CONTAINER: 'false', KW_BACKUP_ENABLED: 'false', KW_ASYNC_TEST: 'true', KW_EVENT_BATCH_WINDOW_MS: '10' };
const log = openSync(join(root, 'harness.log'), 'a', 0o600); let host;
const admin = (action, payload = null) => { const result = spawnSync(process.execPath, ['scripts/admin.mjs', action, JSON.stringify(payload)], { env, encoding: 'utf8', timeout: 60000 }); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
async function until(check, label) { for (let i = 0; i < 600; i++) { const value = await check(); if (value) return value; await delay(300); } throw new Error(label); }
async function start() { host = spawn(process.execPath, ['scripts/start.mjs'], { env, stdio: ['ignore', log, log] }); await until(async () => { assert.equal(host.exitCode, null); try { return (await fetch(`http://127.0.0.1:${port}/kw-health`)).ok; } catch (error) { if (error.cause?.code === 'ECONNREFUSED') return false; throw error; } }, 'Host启动超时'); }
async function stop() { if (host?.exitCode === null) { const exit = new Promise(resolve => host.once('exit', resolve)); admin('shutdown'); await Promise.race([exit, delay(20000, undefined, { ref: false })]); assert.notEqual(host.exitCode, null); } }
const state = async () => (await fetch(`http://127.0.0.1:${port}/kw-async-test`)).json();
try {
  await start();
  admin('role.create', { id: 'async-probe', name: '后台通知行为验收', accountId: 'main', initialPersona: '你是内部文件操作验收角色，所有操作只在隔离目录进行，禁止社交发送。初始化用一句普通文字回应。用户要求准备材料时，使用verification_async_file写入对应marker与delay，按实际工具结果说明进展。没有任务时保持等待，不创建计划。', provider: env.KW_LLM_PROVIDER, model: env.KW_LLM_MODEL, state: 'paused' });
  admin('role.prepare', { id: 'async-probe' });
  admin('extension', { roleId: 'async-probe', request: { action: 'install', id: 'async-verification', spec: resolve('tests/fixtures/async-tools') } });
  admin('extension', { roleId: 'async-probe', request: { action: 'enable', id: 'async-verification' } });
  await stop(); await start();
  admin('role.control', { id: 'async-probe', state: 'active' });
  await until(async () => { const value = await state(); assert.ok(!value.runtime?.error, value.runtime?.error); return value.requests.length && value.agentStatus === 'idle'; }, '初始化超时');
  admin('event', { roleId: 'async-probe', text: '请在后台准备材料，使用verification_async_file，marker为notification-source，delay为25000。需要结果时再告诉我实际完成情况。' });
  await until(async () => { const value = await state(); assert.ok(!value.runtime?.error, value.runtime?.error); return value.tasks.items.some(task => task.mode === 'background' && task.state === 'running'); }, '后台任务未启动');
  admin('event', { roleId: 'async-probe', text: '另外，请现在准备一份独立的便签，使用verification_async_file，marker为notification-independent，delay为0。' });
  const result = await until(async () => { const value = await state(); assert.ok(!value.runtime?.error, value.runtime?.error); return value.executions.includes('notification-source') && value.executions.includes('notification-independent') && value.agentStatus === 'idle' && value.events.every(event => event.delivery.state === 'completed') ? value : undefined; }, '材料、独立便签和完成通知未全部处理');
  const report = { actualHarness: true, actualModel: true, executions: result.executions, queries: result.readQueues, events: result.events.map(event => ({ id: event.id, delivery: event.delivery })), root, noSocialSends: true };
  await writeFile('.artifacts/verification/async-notification.json', JSON.stringify(report, null, 2));
  assert.equal(result.executions.filter(marker => marker === 'notification-source').length, 1, '后台操作重复执行');
  assert.ok(result.executions.indexOf('notification-independent') < result.executions.indexOf('notification-source'), '后台执行阻塞独立事项');
  assert.ok(result.readQueues.length <= 1, '反复查询后台结果');
  assert.equal(result.events.length, 1, '产生重复完成通知');
  console.log(JSON.stringify(report));
} finally { if (host?.exitCode === null) admin('role.control', { id: 'async-probe', state: 'paused' }); await stop(); closeSync(log); }
