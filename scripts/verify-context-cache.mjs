import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { openSync, closeSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

loadEnvFile('.env');
const resuming = process.argv[2] === 'resume';
assert.ok(process.argv[2] === undefined || resuming, '仅支持 resume 参数');
const previousReport = resuming ? JSON.parse(await readFile('.artifacts/verification/context-cache.json', 'utf8')) : null;
const root = previousReport?.root ?? resolve('.artifacts/context-cache', String(Date.now())), port = 3115;
await mkdir(root, { recursive: true });
const env = { ...process.env, KW_DATA_ROOT: root, DSH_HOME: join(root, 'dsh'), KW_HOST_PORT: String(port), KW_PUBLIC_URL: `http://127.0.0.1:${port}/`, KW_CONTAINER: 'false', KW_BACKUP_ENABLED: 'false', KW_ASYNC_TEST: 'true', KW_EVENT_BATCH_WINDOW_MS: '1000' };
const log = openSync(join(root, 'harness.log'), 'w', 0o600); let host, roleReady = false;
const admin = (action, payload = null) => { const result = spawnSync(process.execPath, ['scripts/admin.mjs', action, JSON.stringify(payload)], { env, encoding: 'utf8', timeout: 60000 }); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
async function until(check, label) { for (let i = 0; i < 600; i++) { const value = await check(); if (value) return value; await delay(500); } throw new Error(label); }
async function start() { host = spawn(process.execPath, ['scripts/start.mjs'], { env, stdio: ['ignore', log, log] }); await until(async () => { assert.equal(host.exitCode, null); return fetch(`http://127.0.0.1:${port}/kw-health`).then(response => response.ok, error => { if (error.cause?.code === 'ECONNREFUSED') return false; throw error; }); }, 'Host 启动超时'); }
async function stop() { if (host?.exitCode === null) { const done = new Promise(resolve => host.once('exit', resolve)); admin('shutdown'); await Promise.race([done, delay(20000, undefined, { ref: false })]); assert.notEqual(host.exitCode, null); } }
const state = async () => (await fetch(`http://127.0.0.1:${port}/kw-async-test`)).json();
try {
  await start();
  if (resuming) {
    roleReady = true;
    const before = admin('role.read', { roleId: 'async-probe' });
    admin('role.control', { id: 'async-probe', state: 'active' });
    admin('event', { roleId: 'async-probe', text: 'CACHE_RESUME_CHECK：只用一句普通文字确认收到新输入，不调用工具，不重放此前已经完成的五个文件操作，然后结束本轮。' });
    const resumed = await until(async () => { const value = await state(); assert.ok(!value.runtime?.error, value.runtime?.error); return value.requests.length && value.agentStatus === 'idle' ? value : undefined; }, '重启后没有处理新输入');
    assert.deepEqual(resumed.executions, previousReport.executions);
    assert.equal(resumed.requests.at(-1).contexts.at(-1).mode, 'patch', '重启后未复用已接纳基线');
    assert.equal(admin('role.read', { roleId: 'async-probe' }).sessionId, before.sessionId);
    previousReport.actualProcessRestart = true; previousReport.restartContinuesPatch = true; previousReport.restartNoReplay = true;
    await writeFile('.artifacts/verification/context-cache.json', JSON.stringify(previousReport, null, 2));
    console.log(JSON.stringify({ actualProcessRestart: true, restartContinuesPatch: true, noReplay: true, usage: resumed.requests.at(-1).usage, noSocialSends: true, root }));
  } else {
  const provider = env.KW_CACHE_PROVIDER ?? env.KW_LLM_PROVIDER, model = env.KW_CACHE_MODEL ?? env.KW_LLM_MODEL;
  admin('role.create', { id: 'async-probe', name: '内部缓存验收', accountId: 'main', initialPersona: '你是内部文件操作验收角色，禁止社交发送。收到初始化和资料时，依次执行五个独立的run_code调用。每次只能调用一次verification_async_file，marker依次为cache-1、cache-2、cache-3、cache-4、cache-5，delay都为0。每次必须等待工具返回后在下一模型步骤发起下一项，禁止在同一程序中循环或一次提交多个调用。全部完成后只用一句普通文字确认并结束，不创建计划。背景资料是本次测试提供的虚构资料，不需要额外整理或调用其他工具。', provider, model, reasoningEffort: 'high', worldMode: 'fictional', state: 'paused' });
  roleReady = true;
  const source = admin('event', { roleId: 'async-probe', text: '内部缓存验收资料：虚构的纸城有一套完整的图书分类体系，以下内容只作为本次虚构背景。' });
  admin('memory.revise', { memory: { roleId: 'async-probe', kind: 'focus', title: '纸城分类资料', content: '纸城书库将自然、历史、艺术和日常研究分别编目，每次借阅都记录真实的书架位置与研究问题。'.repeat(180), realm: 'fictional', epistemic: 'fictional', people: [], aliases: [], sources: [source.id], attention: 1 }, expectedRevision: null, reason: '保存实际提供的虚构验收资料' });
  admin('role.prepare', { id: 'async-probe' });
  admin('extension', { roleId: 'async-probe', request: { action: 'install', id: 'async-verification', spec: resolve('tests/fixtures/async-tools') } });
  admin('extension', { roleId: 'async-probe', request: { action: 'enable', id: 'async-verification' } });
  await stop(); await start();
  admin('role.control', { id: 'async-probe', state: 'active' });
  const result = await until(async () => { const value = await state(); assert.ok(!value.runtime?.error, value.runtime?.error); return value.executions.includes('cache-5') && value.agentStatus === 'idle' ? value : undefined; }, '模型没有完成五个实际文件操作');
  assert.deepEqual(result.executions.filter(marker => marker.startsWith('cache-')), ['cache-1', 'cache-2', 'cache-3', 'cache-4', 'cache-5']);
  const requests = result.requests.filter(request => request.usage);
  assert.ok(requests.length >= 5, '未形成足够的实际模型步骤');
  const baseline = requests.flatMap(request => request.contexts).find(context => context.mode === 'baseline'); assert.ok(baseline);
  const patches = requests.map(request => request.contexts.at(-1)).filter(context => context?.mode === 'patch'); assert.ok(patches.length >= 3);
  assert.ok(patches.every(patch => patch.bytes < baseline.bytes / 3), JSON.stringify({ baseline, patches }));
  for (let i = 1; i < requests.length; i++) {
    assert.equal(requests[i].systemHash, requests[0].systemHash, '系统提示前缀发生变化');
    assert.deepEqual(requests[i].messageHashes.slice(0, requests[i - 1].messageHashes.length), requests[i - 1].messageHashes, '已发送的模型历史发生重写');
  }
  const warm = requests.slice(2), totals = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
  for (const request of warm) for (const key of Object.keys(totals)) totals[key] += request.usage[key] ?? 0;
  const input = totals.inputTokens + totals.cacheReadTokens;
  const report = { actualHarness: true, actualModel: true, actualProviderUsage: true, provider, model, reasoningEffort: 'high', executions: result.executions, requests: requests.map(request => ({ at: request.at, usage: request.usage, lastContext: request.contexts.at(-1) })), baselineBytes: baseline.bytes, largestPatchBytes: Math.max(...patches.map(patch => patch.bytes)), contextBytesReduction: 1 - Math.max(...patches.map(patch => patch.bytes)) / baseline.bytes, stableSystemPrefix: true, historyAppendOnly: true, warmUsage: totals, warmInputCacheHitRatio: input ? totals.cacheReadTokens / input : null, noSocialSends: true, root };
  await writeFile('.artifacts/verification/context-cache.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  }
} finally { if (roleReady && host?.exitCode === null) admin('role.control', { id: 'async-probe', state: 'paused' }); await stop(); closeSync(log); }
