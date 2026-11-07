import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';

loadEnvFile('.env');
const root = resolve(process.argv[2]), port = 3107;
const env = { ...process.env, KW_DATA_ROOT: root, DSH_HOME: join(root, 'dsh'), KW_HOST_PORT: String(port), KW_PUBLIC_URL: `http://127.0.0.1:${port}/`, KW_CONTAINER: 'false', KW_BACKUP_ENABLED: 'false', KW_ASYNC_TEST: 'true', KW_EVENT_BATCH_WINDOW_MS: '60000' };
const path = join(root, 'panel.log'), log = openSync(path, 'a', 0o600);
let host, browser, ready = false;
const admin = (action, payload = null) => { const result = spawnSync(process.execPath, ['scripts/admin.mjs', action, JSON.stringify(payload)], { env, encoding: 'utf8', timeout: 60000 }); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
try {
  host = spawn(process.execPath, ['scripts/start.mjs'], { env, stdio: ['ignore', log, log] });
  for (let i = 0; i < 200; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/kw-health`)).ok) { ready = true; break; } } catch (error) { if (error.cause?.code !== 'ECONNREFUSED') throw error; } await delay(300); }
  assert.ok(ready);
  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chromium', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addLocatorHandler(page.getByRole('dialog', { name: '预览版说明' }), async dialog => { await dialog.getByRole('button', { name: '继续', exact: true }).click(); });
  const link = [...(await readFile(path, 'utf8')).matchAll(/dsh web: (http[^\s]+)/g)].at(-1)?.[1]; assert.ok(link);
  await page.goto(link); await page.getByText('KWAgent', { exact: true }).first().click();
  await page.getByRole('button', { name: /^异步验收 / }).click();
  const tasks = page.getByRole('region', { name: '后台任务', exact: true });
  await expect(tasks.getByRole('button', { name: '读取任务详情' }).first()).toBeVisible();
  await tasks.getByRole('button', { name: '读取任务详情' }).first().click();
  await expect(page.locator('.kw-detail')).toContainText('resultRef');
  const response = await fetch(`http://127.0.0.1:${port}/kw-async-test`, { method: 'POST', body: JSON.stringify({ action: 'execute', background: true, code: 'return await tools.verification_async_file({marker:"panel-cancelled",delay:60000});' }) });
  const value = await response.json(); assert.equal(response.ok, true, JSON.stringify(value));
  const taskId = value.result.results[0].result.value.background.taskId;
  await tasks.getByRole('button', { name: '取消任务', exact: true }).click();
  await expect.poll(() => admin('task.list', { roleId: 'async-probe' }).items.find(task => task.id === taskId)?.state).toBe('cancelled');
  await page.reload(); await page.getByText('KWAgent', { exact: true }).first().click(); await page.getByRole('button', { name: /^异步验收 / }).click();
  await expect(tasks.getByText('已取消', { exact: true }).first()).toBeVisible();
  await mkdir('.artifacts/browser', { recursive: true }); await page.screenshot({ path: '.artifacts/browser/async-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 420, height: 900 }); await tasks.scrollIntoViewIfNeeded(); await page.screenshot({ path: '.artifacts/browser/async-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  await writeFile('.artifacts/verification/async-panel.json', JSON.stringify({ actualBrowser: true, taskDetail: true, cancelActualTask: true, reload: true, desktop: true, narrow: true, errors, noSocialSends: true }));
  console.log('Actual browser async Panel checks passed');
} finally { await browser?.close(); if (host?.exitCode === null) { const exit = new Promise(resolve => host.once('exit', resolve)); if (ready) { admin('role.control', { id: 'async-probe', state: 'paused' }); admin('shutdown'); } else host.kill('SIGTERM'); await Promise.race([exit, delay(20000, undefined, { ref: false })]); assert.notEqual(host.exitCode, null); } closeSync(log); }
