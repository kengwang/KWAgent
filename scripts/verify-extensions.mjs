import { spawnSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

loadEnvFile('.env');
function admin(action, payload = null) {
  const result = spawnSync(process.execPath, ['scripts/admin.mjs', action, JSON.stringify(payload)], { encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
  return JSON.parse(result.stdout);
}
const recordPath = '.artifacts/verification/client-extension.json';
let roleId;
let extension;
if (process.argv[2] === 'resume') {
  ({ roleId } = JSON.parse(await readFile(recordPath, 'utf8')));
  extension = admin('status', { roleId }).extensions.find(extension => extension.id === 'client');
  assert.equal(extension.state, 'enabled');
} else {
  roleId = `client-${Date.now()}`;
  admin('role.create', { id: roleId, accountId: 'main', name: '浏览器扩展验收', initialPersona: '检查本地浏览器扩展。', provider: process.env.KW_LLM_PROVIDER, model: process.env.KW_LLM_MODEL });
  admin('extension', { roleId, request: { action: 'install', id: 'client', spec: resolve('tests/fixtures/client-extension') } });
  extension = admin('extension', { roleId, request: { action: 'enable', id: 'client' } });
}
await mkdir('.artifacts/verification', { recursive: true });
if (extension.state === 'pending-restart') {
  assert.equal(admin('doctor').database, 'ok');
  await writeFile(recordPath, JSON.stringify({ roleId, state: extension.state, managerResponsive: true }, null, 2));
  console.log(JSON.stringify({ roleId, state: extension.state, managerResponsive: true }));
} else {
  const log = await readFile('.artifacts/harness.log', 'utf8');
  const url = /dsh web: (http[^\s]+)/.exec(log)?.[1];
  assert.ok(url);
  const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chromium', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.documentElement.dataset.kwVerificationClient === 'enabled');
    const disabled = admin('extension', { roleId, request: { action: 'disable', id: 'client' } });
    assert.equal(disabled.state, 'disabled');
    await page.waitForFunction(() => document.documentElement.dataset.kwVerificationClient === undefined);
    assert.equal(admin('doctor').database, 'ok');
    await writeFile(recordPath, JSON.stringify({ roleId, loaded: true, unloaded: true, managerResponsive: true }, null, 2));
    console.log(JSON.stringify({ roleId, loaded: true, unloaded: true, managerResponsive: true }));
  } catch (error) { throw new Error(error.message.replace(/token=[^\s&]+/g, 'token=[REDACTED]')); }
  finally { await browser.close(); }
}
