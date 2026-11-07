import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

loadEnvFile('.env');
const root = resolve('.artifacts/async-origin', String(Date.now())), port = 3108;
await mkdir(root, { recursive: true });
const env = { ...process.env, KW_DATA_ROOT: root, DSH_HOME: join(root, 'dsh'), KW_HOST_PORT: String(port), KW_PUBLIC_URL: `http://127.0.0.1:${port}/`, KW_CONTAINER: 'false', KW_BACKUP_ENABLED: 'false', KW_ASYNC_TEST: 'true' };
const log = openSync(join(root, 'harness.log'), 'a', 0o600); let host;
const admin = (action, payload = null) => { const result = spawnSync(process.execPath, ['scripts/admin.mjs', action, JSON.stringify(payload)], { env, encoding: 'utf8', timeout: 60000 }); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
async function until(check, label) { for (let i = 0; i < 300; i++) { const value = await check(); if (value) return value; await delay(300); } throw new Error(label); }
async function start() { host = spawn(process.execPath, ['scripts/start.mjs'], { env, stdio: ['ignore', log, log] }); await until(async () => { assert.equal(host.exitCode, null); try { return (await fetch(`http://127.0.0.1:${port}/kw-health`)).ok; } catch (error) { if (error.cause?.code === 'ECONNREFUSED') return false; throw error; } }, 'Host启动超时'); }
async function stop() { if (host?.exitCode === null) { const exit = new Promise(resolve => host.once('exit', resolve)); admin('shutdown'); await Promise.race([exit, delay(20000, undefined, { ref: false })]); assert.notEqual(host.exitCode, null); } }
try {
  await start();
  admin('role.create', { id: 'async-probe', name: '活动归属验收', accountId: 'main', initialPersona: '本机内部验收。收到后台结果后只用一句普通assistant文字确认，然后结束。不调用工具、不创建计划、不做任何社交发送。', provider: env.KW_LLM_PROVIDER, model: env.KW_LLM_MODEL, state: 'paused' });
  admin('role.prepare', { id: 'async-probe' });
  admin('extension', { roleId: 'async-probe', request: { action: 'install', id: 'async-verification', spec: resolve('tests/fixtures/async-tools') } });
  admin('extension', { roleId: 'async-probe', request: { action: 'enable', id: 'async-verification' } });
  await stop(); await start();
  const response = await fetch(`http://127.0.0.1:${port}/kw-async-test`, { method: 'POST', body: JSON.stringify({ action: 'execute', background: true, code: 'return await tools.verification_async_file({marker:"origin-proof",delay:500});' }) });
  assert.ok(response.ok); const submitted = await response.json(); assert.equal(submitted.result.results[0].result.isError, false);
  const current = await until(async () => { const value = await (await fetch(`http://127.0.0.1:${port}/kw-async-test`)).json(); assert.ok(!value.runtime?.error, value.runtime?.error); return value.requests.length && value.agentStatus === 'idle' ? value : undefined; }, '后台结果接纳超时');
  const report = { actualHarness: true, actualModel: true, taskOriginsInModelRequests: current.requests.map(request => request.origin), noSocialSends: true, root };
  await writeFile('.artifacts/verification/async-origin.json', JSON.stringify(report, null, 2));
  assert.ok(report.taskOriginsInModelRequests.every(origin => origin === null), JSON.stringify(report.taskOriginsInModelRequests));
  console.log(JSON.stringify(report));
} finally { if (host?.exitCode === null) admin('role.control', { id: 'async-probe', state: 'paused' }); await stop(); closeSync(log); }
