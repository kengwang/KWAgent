import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { openSync, closeSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';

loadEnvFile('.env');
const root = resolve('.artifacts/memory-panel', String(Date.now())), port = 3118, id = 'memory-demand';
await mkdir(root, { recursive: true }); await mkdir('output/playwright', { recursive: true });
const env = { ...process.env, KW_DATA_ROOT: root, DSH_HOME: join(root, 'dsh'), KW_HOST_PORT: String(port), KW_PUBLIC_URL: `http://127.0.0.1:${port}/`, KW_CONTAINER: 'false', KW_BACKUP_ENABLED: 'false', KW_MEMORY_DEMAND_TEST: 'true', NO_PROXY: '127.0.0.1,localhost' };
const path = join(root, 'harness.log'), log = openSync(path, 'a', 0o600); let host, browser;
const admin = (action, payload = null) => { const value = spawnSync(process.execPath, ['scripts/admin.mjs', action, JSON.stringify(payload)], { env, encoding: 'utf8', timeout: 60000 }); assert.equal(value.status, 0, value.stderr); return JSON.parse(value.stdout); };
async function start() { host = spawn(process.execPath, ['scripts/start.mjs'], { env, stdio: ['ignore', log, log] }); for (let end = Date.now() + 90000; Date.now() < end;) { assert.equal(host.exitCode, null); const ready = await fetch(`http://127.0.0.1:${port}/kw-health`).then(response => response.ok, error => { if (error.cause?.code === 'ECONNREFUSED') return false; throw error; }); if (ready) return; await delay(300); } throw new Error('Panel Host启动超时'); }
async function stop() { if (host?.exitCode === null) { const exit = new Promise(resolve => host.once('exit', resolve)); admin('shutdown'); await Promise.race([exit, delay(20000, undefined, { ref: false })]); assert.notEqual(host.exitCode, null); } }
try {
  await start();
  admin('role.create', { id, name: '按需记忆界面验收', accountId: 'main', initialPersona: '隔离管理界面验收角色，保持暂停。', provider: env.KW_LLM_PROVIDER, model: env.KW_LLM_MODEL, state: 'paused' });
  admin('role.prepare', { id });
  admin('extension', { roleId: id, request: { action: 'install', id: 'memory-demand', spec: resolve('tests/fixtures/memory-demand') } });
  admin('extension', { roleId: id, request: { action: 'enable', id: 'memory-demand' } });
  await stop(); await start();
  const post = async body => { const response = await fetch(`http://127.0.0.1:${port}/kw-memory-demand-test`, { method: 'POST', body: JSON.stringify(body) }); const value = await response.json(); assert.ok(response.ok, value.error); return value; };
  const seeded = await post({ action: 'seed' });
  const pipeline = await post({ action: 'execute', code: 'return await tools.memory_recall({query:"纸城面试"})' });
  assert.equal(pipeline.results[0].result.isError, false);
  const returned = pipeline.results[0].result.value.result;
  assert.ok(returned.items.some(item => item.id === seeded.memoryId)); assert.ok('nextCursor' in returned);
  const source = admin('events', { roleId: id, limit: 50 }).items.find(event => event.id === seeded.sourceId); assert.ok(source);
  assert.deepEqual(admin('usage.report', { roleId: id, since: '2026-01-01T00:00:00+08:00' }).items, []);
  for (let index = 0; index < 35; index++) admin('memory.revise', { memory: { roleId: id, kind: 'episode', title: `检索分页资料${index}`, content: `检索分页资料的完整正文${index}。`.repeat(90), realm: 'fictional', epistemic: 'fictional', sources: [source.id] }, expectedRevision: null, reason: '真实界面分页材料' });
  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chromium', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addLocatorHandler(page.getByRole('dialog', { name: '预览版说明' }), dialog => dialog.getByRole('button', { name: '继续', exact: true }).click());
  const link = [...(await readFile(path, 'utf8')).matchAll(/dsh web: (http[^\s]+)/g)].at(-1)?.[1]; assert.ok(link);
  await page.goto(link); await page.getByRole('button', { name: 'KWAgent', exact: true }).click();
  await page.locator(`[data-role-id="${id}"]`).click(); await page.getByRole('button', { name: '角色', exact: true }).click();
  await page.getByRole('button', { name: '编辑角色', exact: true }).click(); await expect(page.getByLabel('记忆上下文预算')).toHaveCount(0);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '记忆', exact: true }).click(); await page.getByLabel('检索记忆', { exact: true }).fill('检索分页'); await page.getByRole('button', { name: '检索', exact: true }).click();
  const cards = page.locator('article').filter({ has: page.getByRole('heading', { name: /^检索分页资料/ }) });
  await expect(cards.first()).toBeVisible(); const count = await cards.count();
  await page.getByRole('button', { name: '读取更多检索结果', exact: true }).click(); await expect.poll(() => cards.count()).toBeGreaterThan(count);
  const first = cards.first(); const title = await first.getByRole('heading').textContent();
  await first.getByRole('button', { name: '阅读正文', exact: true }).click(); await page.locator('.kw-detail').getByRole('button', { name: /^读取完整负载/ }).click(); await expect(page.locator('.kw-detail')).toContainText('检索分页资料的完整正文');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await first.getByRole('button', { name: '查看来源', exact: true }).click(); await page.locator('.kw-detail').getByRole('button', { name: '阅读关联', exact: true }).first().click(); await expect(page.locator('.kw-detail')).toContainText(source.id); await page.getByRole('button', { name: '关闭', exact: true }).click();
  const hit = admin('memory.recall', { roleId: id, query: title }).items[0]; const memory = admin('memory.read', { roleId: id, id: hit.id });
  admin('memory.revise', { memory: { ...memory, content: '管理接口更新正文，验证游标失效。' }, expectedRevision: memory.revision, reason: '真实并发修订' });
  const loaded = await cards.count(); await page.getByRole('button', { name: '读取更多检索结果', exact: true }).click(); await expect(page.getByText(/游标已失效/)).toBeVisible(); assert.equal(await cards.count(), loaded);
  await first.getByRole('button', { name: '编辑这条认识', exact: true }).click();
  const editor = page.locator('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await editor.getByRole('button', { name: '编辑认识', exact: true }).click(); await editor.getByLabel('记忆正文', { exact: true }).fill('保留当前尚未提交的正文。');
  const current = admin('memory.read', { roleId: id, id: memory.id }); admin('memory.revise', { memory: { ...current, content: '第二次接口并发修订。' }, expectedRevision: current.revision, reason: '验证编辑冲突' });
  await editor.getByRole('button', { name: '保存', exact: true }).click(); await expect(editor.getByLabel('记忆正文', { exact: true })).toHaveValue('保留当前尚未提交的正文。'); await expect(page.getByText(/内容已经更新，请读取当前版本后重新提交/)).toBeVisible();
  await editor.getByRole('button', { name: '取消编辑', exact: true }).click();
  await page.screenshot({ path: 'output/playwright/memory-demand-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: 'output/playwright/memory-demand-mobile.png', fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.reload(); await expect(page.getByRole('button', { name: 'KWAgent', exact: true })).toBeVisible();
  assert.deepEqual(errors, []); assert.equal((await post({ action: 'execute', code: 'return await tools.continuity_read({kind:"life"})' })).results[0].result.isError, false);
  const final = await (await fetch(`http://127.0.0.1:${port}/kw-memory-demand-test`)).json(); assert.equal(final.requests.length, 0);
  const report = { root, browser: true, desktop: true, narrow: true, paging: true, staleCursorPreservesResults: true, fullPayload: true, sourceNavigation: true, conflictPreservesInput: true, reload: true, actualToolPipeline: true, noModelRequests: true, noSocialSends: true };
  await writeFile('.artifacts/verification/memory-demand-panel.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) { if (browser) { const page = browser.contexts()[0]?.pages()[0]; if (page) await page.screenshot({ path: 'output/playwright/memory-demand-failure.png', fullPage: true }); } throw new Error(error.message.replace(/token=[^\s&]+/g, 'token=[REDACTED]')); }
finally { await browser?.close(); await stop(); closeSync(log); }
