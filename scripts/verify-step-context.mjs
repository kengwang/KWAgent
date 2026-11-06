import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { openSync, closeSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

loadEnvFile('.env');
const root = resolve('.artifacts/step-context', String(Date.now()));
await mkdir(root, { recursive: true });
const port = 3102, id = 'boundary-flow';
const env = { ...process.env, KW_DATA_ROOT: root, DSH_HOME: join(root, 'dsh'), KW_HOST_PORT: String(port), KW_PUBLIC_URL: `http://127.0.0.1:${port}/`, KW_BACKUP_ENABLED: 'false', KW_BOUNDARY_TEST: 'true', HTTP_PROXY: 'http://127.0.0.1:7897', HTTPS_PROXY: 'http://127.0.0.1:7897', NO_PROXY: 'localhost,127.0.0.1' };
const log = openSync(join(root, 'harness.log'), 'a', 0o600);
let host, ready = false;
function admin(action, payload = null) {
  const result = spawnSync(process.execPath, ['scripts/admin.mjs', action, JSON.stringify(payload)], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
async function until(check, label, timeout = 180000) {
  for (const end = Date.now() + timeout; Date.now() < end;) {
    assert.equal(host.exitCode, null);
    const result = await check(); if (result) return result;
    await delay(300);
  }
  throw new Error(`等待超时：${label}`);
}
async function start() {
  ready = false;
  host = spawn(process.execPath, ['scripts/start.mjs'], { env, stdio: ['ignore', log, log] });
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/kw-health`)).ok; } catch (error) { if (error.cause?.code === 'ECONNREFUSED') return false; throw error; } }, '隔离Host启动', 60000);
  ready = true;
}
async function stop() {
  if (host?.exitCode === null) {
    const exited = new Promise(resolve => host.once('exit', resolve));
    if (ready) admin('shutdown'); else host.kill('SIGTERM');
    await Promise.race([exited, delay(20000)]);
    if (host.exitCode === null) { host.kill('SIGKILL'); throw new Error('验收Host未正常停止'); }
    ready = false;
  }
}
async function fixture(action, extra = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/kw-boundary-test`, action ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...extra }) } : {});
  const value = await response.json(); assert.ok(response.ok, value.error); return value;
}
async function idle(ids = []) {
  const state = await fixture();
  assert.ok(!state.runtime?.error, state.runtime?.error);
  return state.captured.length && state.agentStatus === 'idle' && ids.every(id => state.deliveries.some(event => event.id === id && event.state === 'completed')) ? state : undefined;
}
try {
  await start();
  admin('role.create', { id, accountId: 'main', provider: env.KW_LLM_PROVIDER, model: env.KW_LLM_MODEL, state: 'paused', name: '小雪', groups: [20001], adminQQs: [10001], initialPersona: '你叫小雪，保持角色身份。这是本机内部验收，每次用一句普通assistant文字回应新输入，保留BOUNDARY标识。不要调用工具，不发送QQ，不创建安排。' });
  admin('role.prepare', { id });
  admin('extension', { roleId: id, request: { action: 'install', id: 'context-inspector', spec: resolve('tests/fixtures/resilience-boundaries') } });
  admin('extension', { roleId: id, request: { action: 'enable', id: 'context-inspector' } });
  await stop(); await start();
  admin('role.control', { id, state: 'active' });
  await until(() => idle(), '初始化步骤');
  for (let index = 0; index < 3; index++) {
    const batch = await fixture('deliver', { items: [{ admin: false, marker: `BOUNDARY-CONTEXT-${index}`, text: '这是新的交流内容，请简短回应。' }] });
    await until(() => idle(batch.ids), '后续步骤背景不累积');
  }
  const before = await fixture();
  admin('role.control', { id, state: 'paused' });
  const session = admin('role.read', { roleId: id }).sessionId;
  await stop(); await start();
  admin('role.control', { id, state: 'active' });
  const batch = await fixture('deliver', { items: [{ marker: 'BOUNDARY-CONTEXT-RESTORED', text: '重启后的新输入，请简短回应。' }] });
  const restored = await until(() => idle(batch.ids), '恢复后单份步骤背景');
  admin('role.control', { id, state: 'paused' });
  assert.equal(admin('role.read', { roleId: id }).sessionId, session);
  assert.ok([...before.captured, ...restored.captured].every(record => record.backgrounds === 1));
  const report = { actualHarness: true, actualModel: true, noSocialSends: true, sameSessionAfterRestart: true, before: before.captured, restored: restored.captured, root };
  await mkdir('.artifacts/verification', { recursive: true });
  await writeFile('.artifacts/verification/step-context.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await stop(); closeSync(log); }
