import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { openSync, closeSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';

loadEnvFile('.env');
const root = resolve('.artifacts/compaction-policy', String(Date.now()));
await mkdir(root, { recursive: true });
const env = { ...process.env, KW_DATA_ROOT: root, DSH_HOME: join(root, 'dsh'), KW_HOST_PORT: '3094', KW_PUBLIC_URL: 'http://127.0.0.1:3094/', KW_BACKUP_ENABLED: 'false', KW_CHAT_THINKING_FORMAT: 'deepseek', HTTP_PROXY: 'http://127.0.0.1:7897', HTTPS_PROXY: 'http://127.0.0.1:7897', NO_PROXY: 'localhost,127.0.0.1' };
const log = openSync(join(root, 'harness.log'), 'a', 0o600);
let host;
let ready = false;
const id = 'compaction-policy';
const admin = (action, payload = null) => {
  const result = spawnSync(process.execPath, ['scripts/admin.mjs', action, JSON.stringify(payload)], { env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
};
async function until(test, description, milliseconds = 180000) {
  for (const end = Date.now() + milliseconds; Date.now() < end;) {
    if (host.exitCode !== null) throw new Error(`验收Host退出：${host.exitCode}`);
    const value = await test(); if (value) return value;
    await delay(250);
  }
  throw new Error(`等待超时：${description}`);
}
async function start() {
  ready = false;
  host = spawn(process.execPath, ['scripts/start.mjs'], { env, stdio: ['ignore', log, log] });
  await until(async () => { try { return (await fetch('http://127.0.0.1:3094/kw-health')).ok; } catch (error) { if (error.cause?.code === 'ECONNREFUSED') return false; throw error; } }, 'Host管理就绪', 60000);
  ready = true;
}
async function stop() {
  if (host?.exitCode === null) {
    const exit = new Promise(resolve => host.once('exit', resolve));
    if (ready) admin('shutdown'); else host.kill('SIGTERM');
    await Promise.race([exit, delay(20000)]);
    if (host.exitCode === null) { host.kill('SIGKILL'); throw new Error('验收Host未完成正常停止'); }
    ready = false;
  }
}
function records() {
  const rows = []; let cursor = 0;
  for (;;) { const page = admin('session.records', { roleId: id, cursor, limit: 200 }); rows.push(...page.items); if (page.nextCursor === null) return rows; cursor = page.nextCursor; }
}
function value(id) {
  let text = '', offset = 0;
  for (;;) { const page = admin('payload.read', { roleId: 'compaction-policy', id, offset, limit: 65536 }); text += page.text; if (page.nextCursor === null) return JSON.parse(text); offset = page.nextCursor; }
}
function sessionEvent(seq) { return value(admin('session.read', { roleId: id, seq }).payloadId); }
const nativeContext = new Context();
const nativePolicy = new BasicCompactionEngine(nativeContext).config;
let sessionId;
try {
  await start();
  admin('role.create', { id, accountId: 'main', name: '宿主压缩策略验收', provider: env.KW_LLM_PROVIDER, model: env.KW_LLM_MODEL, worldMode: 'mixed', initialPersona: '本地内部验收。加载kwagent-life Skill，调用verification_read实际阅读文件，然后用verification_mark stage=initialized记录一句发现，结束活动。禁止任何远程社交发送、shell与额外计划；不主动压缩上下文。' });
  const prepared = admin('role.prepare', { id });
  assert.equal(prepared.agentMaxTokens, null);
  assert.equal(prepared.modelInfo.defaultMaxTokens, undefined);
  assert.deepEqual(prepared.compactionPolicy, JSON.parse(JSON.stringify(nativePolicy)));
  sessionId = prepared.sessionId;
  admin('extension', { roleId: id, request: { action: 'install', id: 'observer', spec: resolve('tests/fixtures/continuity-observer') } });
  admin('extension', { roleId: id, request: { action: 'enable', id: 'observer' } });
  const document = await readFile('docs/architecture.md', 'utf8');
  admin('event', { roleId: id, text: `这是本地真实工程的架构文档，供理解当前环境。依照验收要求读取观察文件并记录一句发现后结束。\n${document}` });
  admin('role.control', { id, state: 'active' });
  await until(async () => {
    const role = admin('status', { roleId: id }).roles.find(role => role.id === id);
    if (role.runtime.error) throw new Error(role.runtime.error);
    let completed;
    try { completed = (await readFile(join(root, 'workspaces', id, 'continuity-observations.jsonl'), 'utf8')).split('\n').filter(Boolean).map(item => JSON.parse(item)).some(item => item.stage === 'initialized'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
    return completed;
  }, '真实模型完成工具检查');
  admin('role.control', { id, state: 'paused' });
  const before = records();
  assert.ok(before.filter(item => item.type === 'step/start').length >= 2);
  const headers = before.filter(item => item.type === 'request/header').map(item => sessionEvent(item.seq));
  assert.ok(headers.length);
  for (const event of headers) assert.equal(event.data.header.config.maxTokens, undefined);
  assert.equal(before.filter(item => item.type.startsWith('compaction/')).length, 0);
  const budgets = before.filter(item => item.type === 'plugin:kwagent/context').map(item => sessionEvent(item.seq)).filter(item => item.data.kind === 'request-budget').map(item => item.data.estimatedTokens);
  assert.ok(budgets.length >= 2);
  const observations = (await readFile(join(root, 'workspaces', id, 'continuity-observations.jsonl'), 'utf8')).split('\n').filter(Boolean).map(item => JSON.parse(item));
  assert.ok(observations.some(item => item.stage === 'initialized'));
  await stop();
  await start();
  const restored = admin('role.prepare', { id });
  assert.equal(restored.sessionId, sessionId);
  assert.equal(restored.agentMaxTokens, null);
  assert.deepEqual(restored.compactionPolicy, prepared.compactionPolicy);
  assert.equal(admin('role.read', { roleId: id }).state, 'paused');
  assert.equal(records().filter(item => item.type.startsWith('compaction/')).length, 0);
  const report = { actualHarness: true, actualModel: true, actualTools: true, inheritedPolicy: true, runtimePolicy: prepared.compactionPolicy, modelInfo: prepared.modelInfo, noExplicitOutputCap: true, estimatedRequests: budgets, automaticCompactions: 0, manualCompactions: 0, pausedAfterToolChecks: true, sessionRestored: true, roleRemainsPaused: true, noSocialSends: true };
  await mkdir('.artifacts/verification', { recursive: true });
  await writeFile('.artifacts/verification/compaction-policy.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await stop(); closeSync(log); await nativeContext.fiber.dispose(); }
