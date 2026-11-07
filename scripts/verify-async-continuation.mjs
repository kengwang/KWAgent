import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

loadEnvFile('.env');
const root = resolve('.artifacts/async-continuation', String(Date.now())), port = 3109;
await mkdir(root, { recursive: true });
const env = { ...process.env, KW_DATA_ROOT: root, DSH_HOME: join(root, 'dsh'), KW_HOST_PORT: String(port), KW_PUBLIC_URL: `http://127.0.0.1:${port}/`, KW_CONTAINER: 'false', KW_BACKUP_ENABLED: 'false', KW_ASYNC_TEST: 'true', KW_ASYNC_RACE_TEST: 'true', KW_EVENT_BATCH_WINDOW_MS: '10' };
const log = openSync(join(root, 'harness.log'), 'a', 0o600); let host;
const admin = (action, payload = null) => { const result = spawnSync(process.execPath, ['scripts/admin.mjs', action, JSON.stringify(payload)], { env, encoding: 'utf8', timeout: 60000 }); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
async function until(check, label) { for (let i = 0; i < 600; i++) { const value = await check(); if (value) return value; await delay(300); } throw new Error(label); }
async function start() { host = spawn(process.execPath, ['scripts/start.mjs'], { env, stdio: ['ignore', log, log] }); await until(async () => { assert.equal(host.exitCode, null); try { return (await fetch(`http://127.0.0.1:${port}/kw-health`)).ok; } catch (error) { if (error.cause?.code === 'ECONNREFUSED') return false; throw error; } }, 'Host启动超时'); }
async function stop() { if (host?.exitCode === null) { const exit = new Promise(resolve => host.once('exit', resolve)); admin('shutdown'); await Promise.race([exit, delay(20000, undefined, { ref: false })]); assert.notEqual(host.exitCode, null); } }
const state = async () => (await fetch(`http://127.0.0.1:${port}/kw-async-test`)).json();
try {
  await start();
  const persona = '你是本机异步续接验收角色，禁止所有社交发送。初始化只用一句普通文字回应并结束。收到RACE_RUN后必须分三个独立run_code调用完成：第一步顶层run_in_background:true，code为return await tools.verification_async_file({marker:"race-source",delay:0}); 第二步收到句柄后只调用tools.job_output({job_id:第一步的真实jobId})并返回读取结果；第三步必须等第二步工具结果到达之后，再用另一次run_code调用tools.verification_async_file({marker:"after-read",delay:0})并返回结果。每段run_code只执行该步骤，不能合并步骤。最后用普通assistant文字确认完成再结束。后台完成通知到达时继续上述流程，不再发起race-source；收到任务句柄后继续第二步，不要直接结束活动。不创建计划。';
  admin('role.create', { id: 'async-probe', name: '后台结果续接验收', accountId: 'main', initialPersona: persona, provider: env.KW_LLM_PROVIDER, model: env.KW_LLM_MODEL, state: 'paused' });
  admin('role.prepare', { id: 'async-probe' });
  admin('extension', { roleId: 'async-probe', request: { action: 'install', id: 'async-verification', spec: resolve('tests/fixtures/async-tools') } });
  admin('extension', { roleId: 'async-probe', request: { action: 'enable', id: 'async-verification' } });
  await stop(); await start();
  admin('role.control', { id: 'async-probe', state: 'active' });
  await until(async () => { const value = await state(); assert.ok(!value.runtime?.error, value.runtime?.error); return value.requests.length && value.agentStatus === 'idle'; }, '初始化超时');
  const before = (await state()).turnEnds.length;
  admin('event', { roleId: 'async-probe', text: 'RACE_RUN：执行设定中的三个步骤。先提交race-source后台任务，再单独读取job_output，再在后续模型步骤写入after-read文件；不要合并程序。' });
  const result = await until(async () => { const value = await state(); assert.ok(!value.runtime?.error, value.runtime?.error); return value.turnEnds.length > before && value.agentStatus === 'idle' ? value : undefined; }, '续接验收超时');
  const report = { actualHarness: true, actualModel: true, executions: result.executions, turnEnds: result.turnEnds.slice(before), readQueues: result.readQueues, eventCount: result.events.length, noSocialSends: true, root };
  await writeFile('.artifacts/verification/async-continuation.json', JSON.stringify(report, null, 2));
  assert.ok(result.readQueues.some(read => read.queued), '没有形成真实的排队通知与结果读取竞争');
  assert.ok(result.executions.includes('race-source'));
  assert.ok(result.executions.includes('after-read'), JSON.stringify(report));
  assert.ok(!report.turnEnds.some(turn => turn.reason.kind === 'blocked'), JSON.stringify(report));
  console.log(JSON.stringify(report));
} finally { if (host?.exitCode === null) admin('role.control', { id: 'async-probe', state: 'paused' }); await stop(); closeSync(log); }
