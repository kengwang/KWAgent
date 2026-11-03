import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';

function admin(action, payload) {
  const result = spawnSync(process.execPath, ['scripts/admin.mjs', action, JSON.stringify(payload)], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}

const log = await readFile('.artifacts/harness.log', 'utf8');
const match = /dsh web: (http[^\s]+)/.exec(log);
if (!match) throw new Error('没有找到已启动的 Harness 页面地址');
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chromium', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); console.log(message.text().slice(0, 1500)); } });
await page.addLocatorHandler(page.getByRole('dialog', { name: '预览版说明' }), async dialog => { await dialog.getByRole('button', { name: '继续', exact: true }).click(); });
try {
  await page.goto(match[1], { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'KWAgent', exact: true }).click({ timeout: 30000 });
  await page.getByRole('heading', { name: '全部活动' }).waitFor();
  await page.getByRole('button', { name: '创建角色', exact: true }).click();
  const id = `verify-${Date.now()}`;
  const name = `界面验收 ${id}`;
  await page.getByLabel('标识', { exact: true }).fill(id);
  await page.getByLabel('名称', { exact: true }).fill(name);
  await page.getByRole('textbox', { name: '人格', exact: true }).fill('阅读资料、观察自己的经历。当前配置用于本地管理界面验证。');
  await page.getByRole('button', { name: '保存角色', exact: true }).click();
  await page.getByRole('button', { name: `${name} 未启用`, exact: true }).click();
  await page.getByRole('heading', { name, exact: true }).waitFor();
  await page.getByRole('button', { name: '角色', exact: true }).click();
  await page.getByText('阅读资料、观察自己的经历。当前配置用于本地管理界面验证。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '编辑角色', exact: true }).click();
  await page.getByRole('textbox', { name: '人格', exact: true }).fill('保留正在编辑的人格。');
  const current = admin('status', { roleId: id }).roles.find(role => role.id === id);
  admin('role.update', { id, expectedRevision: current.revision, patch: { persona: '管理接口提交的新人格。' } });
  await page.getByText('管理接口提交的新人格。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: '人格', exact: true }).inputValue(), '保留正在编辑的人格。');
  await page.getByRole('button', { name: '保存角色', exact: true }).click();
  await page.getByText('内容已经更新，请读取当前版本后重新提交', { exact: true }).waitFor();
  await page.getByRole('button', { name: '读取当前版本', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: '人格', exact: true }).inputValue(), '管理接口提交的新人格。');
  await page.getByRole('button', { name: '保存角色', exact: true }).click();
  await page.getByRole('button', { name: '编辑角色', exact: true }).waitFor();
  const memory = admin('memory.revise', { memory: { roleId: id, kind: 'focus', title: '界面检索记忆', content: '管理界面保存了这条验收记录。', realm: 'real', epistemic: 'observed', people: [], aliases: [], sources: [`role:${id}`], archived: false, attention: 0.5 }, expectedRevision: null, reason: '验证记忆编辑' });
  await page.getByRole('button', { name: '记忆', exact: true }).click();
  await page.getByRole('button', { name: '检索', exact: true }).click();
  const article = page.locator('article').filter({ has: page.getByRole('heading', { name: '界面检索记忆', exact: true }) });
  await article.getByRole('button', { name: '编辑认识', exact: true }).click();
  await article.getByRole('textbox', { name: '记忆正文', exact: true }).fill('保存后的检索结果应显示这段正文。');
  await article.getByRole('button', { name: '保存', exact: true }).click();
  await article.getByText('保存后的检索结果应显示这段正文。', { exact: true }).waitFor();
  await article.getByRole('button', { name: '编辑认识', exact: true }).click();
  await article.getByRole('textbox', { name: '记忆正文', exact: true }).fill('第二次编辑使用更新后的修订号。');
  await article.getByRole('button', { name: '保存', exact: true }).click();
  await article.getByText('第二次编辑使用更新后的修订号。', { exact: true }).waitFor();
  assert.equal(admin('status', { roleId: id }).memories.find(item => item.id === memory.id).revision, 3);
  await page.getByRole('button', { name: '目标与安排', exact: true }).click();
  await page.getByLabel('标题', { exact: true }).fill('阅读记录');
  await page.getByLabel('内容', { exact: true }).fill('观察保存后的目标是否能够继续读取。');
  await page.getByRole('button', { name: '保存事项', exact: true }).click();
  await page.getByRole('heading', { name: '阅读记录', exact: true }).waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByText('持续目标 · 已取消', { exact: true }).waitFor();
  await mkdir('.artifacts/browser', { recursive: true });
  await page.screenshot({ path: '.artifacts/browser/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '.artifacts/browser/mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ panel: 'passed', roleId: id, editConflict: true, searchEditRefresh: true, browserErrors: errors.length, screenshots: ['desktop.png', 'mobile.png'] }));
} catch (error) {
  await mkdir('.artifacts/browser', { recursive: true });
  await page.screenshot({ path: '.artifacts/browser/failure.png', fullPage: true });
  await writeFile('.artifacts/browser/failure.txt', await page.locator('body').ariaSnapshot());
  throw new Error(error.message.replace(/token=[^\s&]+/g, 'token=[REDACTED]'));
} finally {
  await writeFile('.artifacts/browser-errors.json', JSON.stringify(errors, null, 2));
  await browser.close();
}
