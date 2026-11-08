import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { openSync, closeSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

loadEnvFile('.env');
const root = resolve('.artifacts/memory-demand', String(Date.now())), port = 3117, id = 'memory-demand';
await mkdir(root, { recursive: true });
const env = { ...process.env, KW_DATA_ROOT: root, DSH_HOME: join(root, 'dsh'), KW_HOST_PORT: String(port), KW_PUBLIC_URL: `http://127.0.0.1:${port}/`, KW_CONTAINER: 'false', KW_BACKUP_ENABLED: 'false', KW_MEMORY_DEMAND_TEST: 'true', NO_PROXY: '127.0.0.1,localhost' };
const log = openSync(join(root, 'harness.log'), 'w', 0o600); let host;
const admin = (action, payload = null) => { const value = spawnSync(process.execPath, ['scripts/admin.mjs', action, JSON.stringify(payload)], { env, encoding: 'utf8', timeout: 180000 }); assert.equal(value.status, 0, value.stderr); return JSON.parse(value.stdout); };
const state = () => fetch(`http://127.0.0.1:${port}/kw-memory-demand-test`).then(response => response.json());
async function until(check, label) { for (let end = Date.now() + 180000; Date.now() < end;) { assert.equal(host.exitCode, null); const value = await check(); if (value) return value; await delay(500); } throw new Error(label); }
async function start() { host = spawn(process.execPath, ['scripts/start.mjs'], { env, stdio: ['ignore', log, log] }); await until(() => fetch(`http://127.0.0.1:${port}/kw-health`).then(response => response.ok, error => { if (error.cause?.code === 'ECONNREFUSED') return false; throw error; }), '隔离Host启动超时'); }
async function stop() { if (host?.exitCode === null) { const exit = new Promise(resolve => host.once('exit', resolve)); admin('shutdown'); await Promise.race([exit, delay(20000, undefined, { ref: false })]); assert.notEqual(host.exitCode, null); } }
async function idle(after) { return until(async () => { const value = await state(); assert.ok(!value.runtime?.error, value.runtime?.error); return value.requests.length > after && value.agentStatus === 'idle' ? value : undefined; }, '模型没有结束当前交流'); }
try {
  await start();
  assert.ok(new URL(env.KW_CHAT_BASE_URL).hostname.includes('workbuddy2api'));
  admin('role.create', { id, name: '纸城修书人', accountId: 'main', initialPersona: '你是生活在纸城的修书人。这是隔离内部资料验收，普通问候简短回应；遇到历史约定时主动通过记忆工具查询摘要、阅读记录，并核对原始来源。全部普通文字留在内部，不使用社交工具，不创建计划，不调用shell。初始化只用一句话确认自己身份并结束。', provider: 'kw-chat', model: env.KW_LLM_MODEL, preinjectSkills: ['kwagent-life'], reasoningEffort: 'medium', worldMode: 'fictional', state: 'paused' });
  admin('role.prepare', { id });
  admin('extension', { roleId: id, request: { action: 'install', id: 'memory-demand', spec: resolve('tests/fixtures/memory-demand') } });
  admin('extension', { roleId: id, request: { action: 'enable', id: 'memory-demand' } });
  await stop(); await start();
  const response = await fetch(`http://127.0.0.1:${port}/kw-memory-demand-test`, { method: 'POST', body: JSON.stringify({ action: 'seed' }) });
  const seeded = await response.json(); assert.ok(response.ok, seeded.error);
  admin('role.control', { id, state: 'active' });
  const initialized = await idle(0);
  const count = initialized.requests.length;
  admin('event', { roleId: id, text: '你好，今天心情怎么样？这是普通问候。' });
  const greeting = await idle(count);
  assert.equal(greeting.calls.filter(call => call.name === 'memory_recall').length, 0, '普通问候不应固定检索记忆');
  admin('event', { roleId: id, text: '上次说的纸城面试，我们约定带哪一件东西？请查阅已有记录及原始来源后告诉我。', context: { scene: 'private', peerId: 10001 }, sender: { id: 10001, nickname: '读者' } });
  const recalled = await idle(greeting.requests.length);
  assert.ok(recalled.calls.some(call => call.name === 'memory_recall' && !call.isError));
  assert.ok(recalled.calls.some(call => call.name === 'memory_read' && call.id === seeded.memoryId && !call.isError));
  assert.ok(recalled.calls.some(call => call.name === 'memory_read' && call.id === seeded.sourceId && !call.isError));
  assert.ok(recalled.answers.some(answer => answer.includes('蓝色桐木书签')));
  assert.ok(recalled.requests.every(request => request.contextBytes.every(bytes => bytes < 20000)));
  admin('role.control', { id, state: 'paused' });
  const consolidated = admin('memory.consolidate', { roleId: id }); assert.equal(consolidated.status, 'completed');
  const before = await state();
  admin('memory.consolidate', { roleId: id }); assert.equal((await state()).operations.length, before.operations.length);
  await stop(); await start();
  admin('role.control', { id, state: 'active' });
  admin('event', { roleId: id, text: '请重新通过工具查阅纸城面试约定，核对当前记录与来源，再简短确认需要带的东西。', context: { scene: 'private', peerId: 10001 }, sender: { id: 10001 } });
  const restarted = await idle(0);
  assert.equal(restarted.sessionId, before.sessionId);
  assert.ok(restarted.calls.some(call => call.name === 'memory_read' && call.id === seeded.memoryId && !call.isError));
  assert.equal(restarted.operations.filter(operation => operation.tool === 'memory_query_expand').length, 0);
  admin('role.control', { id, state: 'paused' });
  const report = { root, actualHarness: true, actualModel: true, provider: 'kw-chat', model: env.KW_LLM_MODEL, modelBaseHost: new URL(env.KW_CHAT_BASE_URL).hostname, seeded, greetingRequests: greeting.requests, beforeRestart: before, afterRestart: restarted, noSocialSends: true, sameSession: true };
  await writeFile('.artifacts/verification/memory-demand-model.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ root, actualHarness: true, actualModel: true, noSocialSends: true, sameSession: true, requests: [...before.requests, ...restarted.requests].map(({ provider, model, category, usage, contextBytes }) => ({ provider, model, category, usage, contextBytes })), queryExpansionRequests: 0 }));
} finally { await stop(); closeSync(log); }
