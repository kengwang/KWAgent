import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { openSync, closeSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';

loadEnvFile('.env');
const root = resolve('.artifacts/role-reasoning', String(Date.now())), id = 'boundary-flow', name = '角色推理配置验收', port = 3105;
await mkdir(root, { recursive: true });
const env = { ...process.env, KW_DATA_ROOT: root, DSH_HOME: join(root, 'dsh'), KW_CONTAINER: 'false', KW_HOST_PORT: String(port), KW_PUBLIC_URL: `http://127.0.0.1:${port}/`, KW_BACKUP_ENABLED: 'false', KW_BOUNDARY_TEST: 'true', KW_REASONING_TEST: 'true', HTTP_PROXY: 'http://127.0.0.1:7897', HTTPS_PROXY: 'http://127.0.0.1:7897', NO_PROXY: 'localhost,127.0.0.1' };
const log = openSync(join(root, 'harness.log'), 'a', 0o600);
let host, ready = false, browser, page;
const errors = [];
const command = (action, payload = null) => spawnSync(process.execPath, ['scripts/admin.mjs', action, JSON.stringify(payload)], { env, encoding: 'utf8', timeout: 60000 });
function admin(action, payload = null) { const result = command(action, payload); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); }
const role = () => admin('role.read', { roleId: id });
const update = patch => admin('role.update', { id, expectedRevision: role().revision, patch });
async function until(check, label, timeout = 180000) {
  for (const end = Date.now() + timeout; Date.now() < end;) {
    assert.equal(host.exitCode, null); const result = await check(); if (result) return result; await delay(300);
  }
  throw new Error(`等待超时：${label}`);
}
async function start() {
  ready = false; host = spawn(process.execPath, ['scripts/start.mjs'], { env, stdio: ['ignore', log, log] });
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/kw-health`)).ok; } catch (error) { if (error.cause?.code === 'ECONNREFUSED') return false; throw error; } }, '本机 Host 启动', 60000); ready = true;
}
async function stop() {
  if (host?.exitCode === null) {
    const exited = new Promise(resolve => host.once('exit', resolve));
    if (ready) admin('shutdown'); else host.kill('SIGTERM');
    await Promise.race([exited, delay(20000, undefined, { ref: false })]);
    if (host.exitCode === null) { host.kill('SIGKILL'); throw new Error('验收 Host 未正常停止'); }
    ready = false;
  }
}
async function state() { const result = await (await fetch(`http://127.0.0.1:${port}/kw-boundary-test`)).json(); assert.ok(!result.runtime?.error, result.runtime?.error); return result; }
async function request(effort, before = 0) {
  admin('event', { roleId: id, text: '本机内部验收：请用一句普通文字回应当前输入，然后结束，不调用工具和任何社交发送。' });
  return until(async () => { const value = await state(); return value.captured.length > before && value.captured.at(-1).reasoningEffort === effort && value.agentStatus === 'idle' ? value : undefined; }, `实际模型使用 ${effort}`);
}
async function edit(effort) {
  await page.getByRole('button', { name: '编辑角色', exact: true }).click();
  await expect(page.getByLabel('对话推理等级', { exact: true })).toBeEnabled();
  await page.getByLabel('对话推理等级', { exact: true }).selectOption(effort);
  await page.getByRole('button', { name: '保存角色', exact: true }).click();
  await page.getByRole('button', { name: '编辑角色', exact: true }).waitFor();
}
try {
  await start();
  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chromium', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.addLocatorHandler(page.getByRole('dialog', { name: '预览版说明' }), async dialog => { await dialog.getByRole('button', { name: '继续', exact: true }).click(); });
  const link = /dsh web: (http[^\s]+)/.exec(await readFile(join(root, 'harness.log'), 'utf8'))?.[1]; assert.ok(link);
  await page.goto(link, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'KWAgent', exact: true }).click();
  await page.getByRole('button', { name: '创建角色', exact: true }).click();
  await page.getByLabel('标识', { exact: true }).fill(id);
  await page.getByLabel('名称', { exact: true }).fill(name);
  await page.getByLabel('人格', { exact: true }).fill('你是小雪。这是本机内部验收，没有真实社交任务。收到输入后只用一句普通assistant文字回应并结束，不调用任何工具，不创建计划，不向QQ或空间发送。');
  await page.getByLabel('模型提供者', { exact: true }).fill(env.KW_LLM_PROVIDER);
  await page.getByLabel('模型', { exact: true }).fill(env.KW_LLM_MODEL);
  await expect(page.getByLabel('对话推理等级', { exact: true })).toBeEnabled();
  await page.getByLabel('对话推理等级', { exact: true }).selectOption('high');
  await page.getByRole('button', { name: '保存角色', exact: true }).click();
  await page.getByRole('button', { name: `${name} 未启用`, exact: true }).click();
  await page.getByRole('button', { name: '角色', exact: true }).click();
  assert.equal(role().reasoningEffort, 'high');
  update({ state: 'paused', groups: [20001], adminQQs: [10001], worldMode: 'fictional', memoryTokens: 16384 });
  const prepared = admin('role.prepare', { id }); assert.equal(prepared.modelSelection.reasoningEffort, 'high');
  const sessionId = prepared.sessionId;
  admin('extension', { roleId: id, request: { action: 'install', id: 'reasoning-observer', spec: resolve('tests/fixtures/resilience-boundaries') } });
  admin('extension', { roleId: id, request: { action: 'enable', id: 'reasoning-observer' } });
  await browser.close(); browser = undefined; await stop(); await start();
  admin('role.control', { id, state: 'active' });
  const high = await until(async () => { const value = await state(); return value.captured.some(item => item.reasoningEffort === 'high') && value.agentStatus === 'idle' ? value : undefined; }, '初始化的真实 high 请求');
  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chromium', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.addLocatorHandler(page.getByRole('dialog', { name: '预览版说明' }), async dialog => { await dialog.getByRole('button', { name: '继续', exact: true }).click(); });
  const restoredLink = [...(await readFile(join(root, 'harness.log'), 'utf8')).matchAll(/dsh web: (http[^\s]+)/g)].at(-1)?.[1]; assert.ok(restoredLink);
  await page.goto(restoredLink, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'KWAgent', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(`^${name} `) }).click();
  await page.getByRole('button', { name: '角色', exact: true }).click();
  await edit('low');
  assert.equal(role().state, 'active'); assert.deepEqual(role().groups, [20001]); assert.deepEqual(role().adminQQs, [10001]); assert.equal(role().memoryTokens, 16384);
  const low = await request('low', high.captured.length);
  const revision = role().revision;
  const rejected = command('role.update', { id, expectedRevision: revision, patch: { reasoningEffort: 'unsupported-kw-effort' } });
  assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /不支持推理等级/); assert.equal(role().revision, revision);
  await edit('off'); const off = await request('off', low.captured.length);
  await edit(''); const defaults = admin('role.prepare', { id }); assert.equal(defaults.configuredReasoningEffort, null); assert.equal(defaults.modelSelection.reasoningEffort, undefined); assert.equal(defaults.effectiveReasoningEffort, 'medium');
  admin('role.control', { id, state: 'paused' });
  await page.getByRole('button', { name: '编辑角色', exact: true }).click();
  await expect(page.getByLabel('对话推理等级', { exact: true })).toBeEnabled();
  await page.getByLabel('对话推理等级', { exact: true }).selectOption('high');
  update({ selfState: '并发修改的实际状态' });
  await page.getByRole('button', { name: '保存角色', exact: true }).click();
  await page.getByText('内容已经更新，请读取当前版本后重新提交', { exact: true }).waitFor();
  await expect(page.getByLabel('对话推理等级', { exact: true })).toHaveValue('high');
  await page.getByRole('button', { name: '读取当前版本', exact: true }).click();
  await expect(page.getByLabel('对话推理等级', { exact: true })).toBeEnabled();
  await page.getByLabel('对话推理等级', { exact: true }).selectOption('high');
  await page.getByRole('button', { name: '保存角色', exact: true }).click();
  await page.getByRole('button', { name: '编辑角色', exact: true }).waitFor();
  await page.getByRole('button', { name: '编辑角色', exact: true }).click();
  await expect(page.getByLabel('对话推理等级', { exact: true })).toHaveValue('high');
  await mkdir('.artifacts/browser', { recursive: true });
  await page.getByLabel('对话推理等级', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.artifacts/browser/role-reasoning-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 420, height: 900 });
  await page.getByLabel('对话推理等级', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.artifacts/browser/role-reasoning-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await browser.close(); browser = undefined; await stop(); await start();
  const resumed = admin('role.prepare', { id }); assert.equal(resumed.sessionId, sessionId); assert.equal(resumed.modelSelection.reasoningEffort, 'high');
  admin('role.control', { id, state: 'active' }); const restored = await request('high'); admin('role.control', { id, state: 'paused' });
  assert.deepEqual(errors, []);
  const report = { actualHarness: true, actualModel: true, actualBrowser: true, chosen: ['high', 'low', 'off'], requests: off.captured.map(item => item.reasoningEffort), resumedRequests: restored.captured.map(item => item.reasoningEffort), defaultEffort: defaults.effectiveReasoningEffort, invalidRejected: true, stateAndBindingsPreserved: true, conflictRetained: true, sessionRestored: true, noSocialSends: true, root };
  await mkdir('.artifacts/verification', { recursive: true }); await writeFile('.artifacts/verification/role-reasoning.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  if (page && browser) { await mkdir('.artifacts/browser', { recursive: true }); await page.screenshot({ path: '.artifacts/browser/role-reasoning-failure.png', fullPage: true }); await writeFile('.artifacts/browser/role-reasoning-failure.txt', await page.locator('body').ariaSnapshot()); }
  throw new Error(error.message.replace(/token=[^\s&]+/g, 'token=[REDACTED]'));
} finally { await browser?.close(); await stop(); closeSync(log); }
