import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { openSync, closeSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

loadEnvFile('.env');
const root = resolve('.artifacts/resilience', String(Date.now())); await mkdir(root, { recursive: true });
const id = 'resilience-main';
const env = { ...process.env, KW_DATA_ROOT: root, DSH_HOME: join(root, 'dsh'), KW_HOST_PORT: '3098', KW_PUBLIC_URL: 'http://127.0.0.1:3098/', KW_BACKUP_ENABLED: 'false', KW_RESILIENCE_TEST: 'true', KW_RESILIENCE_ROLE: id, KW_RESILIENCE_OFFLINE_TOKEN: 'unused-local-connection-test', KW_CHAT_THINKING_FORMAT: 'deepseek', HTTP_PROXY: 'http://127.0.0.1:7897', HTTPS_PROXY: 'http://127.0.0.1:7897', NO_PROXY: 'localhost,127.0.0.1' };
const log = openSync(join(root, 'harness.log'), 'a', 0o600); let host, ready = false;
function admin(action, payload = null) { const result = spawnSync(process.execPath, ['scripts/admin.mjs', action, JSON.stringify(payload)], { env, encoding: 'utf8', timeout: 150000 }); if (result.status) throw new Error(result.stderr || result.stdout); return JSON.parse(result.stdout); }
async function until(test, label, timeout = 180000) { for (const end = Date.now() + timeout; Date.now() < end;) { assert.equal(host.exitCode, null, `Host退出：${host.exitCode}`); const result = await test(); if (result) return result; await delay(200); } throw new Error(`等待超时：${label}`); }
async function start() { ready = false; host = spawn(process.execPath, ['scripts/start.mjs'], { env, stdio: ['ignore', log, log] }); await until(async () => { try { return (await fetch('http://127.0.0.1:3098/kw-health')).ok; } catch (error) { if (error.cause?.code === 'ECONNREFUSED') return false; throw error; } }, 'Host就绪', 60000); ready = true; }
async function stop() { if (host?.exitCode === null) { const exited = new Promise(resolve => host.once('exit', resolve)); if (ready) admin('shutdown'); else host.kill('SIGTERM'); await Promise.race([exited, delay(20000)]); if (host.exitCode === null) { host.kill('SIGKILL'); throw new Error('Host未正常停止'); } ready = false; } }
async function fixture(action, extra = {}) { const response = await fetch('http://127.0.0.1:3098/kw-resilience-test', action ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...extra }) } : {}); if (!response.ok) throw new Error(await response.text()); return response.json(); }
function sessionRecords() { let cursor = 0; const rows = []; for (;;) { const page = admin('session.records', { roleId: id, cursor, limit: 200 }); rows.push(...page.items); if (page.nextCursor === null) return rows; cursor = page.nextCursor; } }
function assistantTexts() { return sessionRecords().filter(event => event.type === 'assistant/message').flatMap(event => { const ref = admin('session.read', { roleId: id, seq: event.seq }); let text = '', offset = 0; for (;;) { const page = admin('payload.read', { roleId: id, id: ref.payloadId, offset, limit: 65536 }); text += page.text; if (page.nextCursor === null) break; offset = page.nextCursor; } return JSON.parse(text).data.message.content.filter(block => block.type === 'text').map(block => block.text); }); }
try {
  await start();
  const config = { accountId: 'main', provider: env.KW_LLM_PROVIDER, model: env.KW_LLM_MODEL, state: 'paused' };
  admin('role.create', { ...config, id, name: '小雪', worldMode: 'mixed', initialPersona: '你叫小雪，住在北境图书馆，语气简短自然，持续演绎这个角色。当前是隔离内部验证，对输入写一句角色内的内部回答，然后结束。禁止所有QQ与空间调用、shell及额外计划，不手动压缩。' });
  admin('role.create', { ...config, id: 'resilience-probe', name: '权限隔离验证', initialPersona: '仅供隔离工具验证，不主动调用模型。' });
  admin('role.prepare', { id }); admin('role.prepare', { id: 'resilience-probe' });
  admin('extension', { roleId: id, request: { action: 'install', id: 'observer', spec: resolve('tests/fixtures/resilience-observer') } });
  admin('extension', { roleId: id, request: { action: 'enable', id: 'observer' } }); await stop(); await start();
  const probes = await fixture('probes');
  const imported = admin('skill.install', { roleId: id, repository: 'https://github.com/Aboudjem/humanizer-skill', path: 'skills/humanizer' });
  assert.equal(imported.name, 'humanizer'); assert.match(imported.commit, /^[a-f0-9]{40}$/);
  const current = admin('role.read', { roleId: id }); admin('role.update', { id, expectedRevision: current.revision, patch: { preinjectSkills: ['kwagent-life', 'lagrange', 'humanizer'] } });
  const first = admin('event', { roleId: id, text: '你是谁？写一句角色内的内部自我介绍，然后结束。' });
  admin('memory.revise', { memory: { roleId: id, kind: 'focus', title: '隔离资料', content: '正在检查角色是否可以连续接纳输入。', realm: 'real', epistemic: 'reported', people: [], aliases: [], sources: [first.id], archived: false, attention: 0.5 }, expectedRevision: null, reason: '提供实际管理输入作为检索背景' });
  admin('role.control', { id, state: 'active' }); await until(async () => (await fixture()).deliveries.some(item => item.id === first.id && item.status === 'completed'), '首个真实角色回答');
  let state = await fixture(); assert.equal(state.frozen.identity.account.userId > 0, true); assert.equal(state.frozen.role.name, '小雪'); assert.ok(state.assembled.some(request => request.hasPersona && request.hasHumanizer));
  assert.equal(state.humanizerProvider, `kw-role-skills-${id}`);
  const inputs = [];
  for (let index = 0; index < 16; index++) inputs.push(admin('event', { roleId: id, text: `连续输入 ${index + 1}/16。结合已接纳的新内容，写一句角色内的内部回应，然后结束。` }).id);
  await until(async () => { const value = await fixture(); return inputs.every(input => value.deliveries.some(item => item.id === input && item.status === 'completed')); }, '全部连续输入完成处理');
  await until(async () => (await fixture()).agentStatus === 'idle', '前台回合已经结束');
  state = await fixture(); assert.ok(state.counts.query < inputs.length, '查询不应为每条消息重复调用');
  const beforeReplay = state.counts.foreground; await fixture('replay', { ids: inputs }); await delay(2500); assert.equal((await fixture()).counts.foreground, beforeReplay);
  admin('role.control', { id, state: 'paused' });
  const fallbackInput = admin('event', { roleId: id, text: '辅助模型不可用验收：保持小雪身份，写一句角色内的内部回应，然后结束。' });
  const failed = await fixture('offline-auxiliary'); assert.equal(failed.status, 'deferred'); assert.equal(failed.rawRetained, true);
  admin('role.control', { id, state: 'active' }); await until(async () => (await fixture()).deliveries.some(item => item.id === fallbackInput.id && item.status === 'completed'), '辅助模型失败期间前台仍成功回应');
  await fixture('restore-model'); admin('role.control', { id, state: 'paused' });
  const records = sessionRecords(); const countBeforeRestart = records.filter(event => event.type === 'user/message').length;
  await stop(); await start();
  assert.equal(admin('role.read', { roleId: id }).state, 'paused'); assert.equal(sessionRecords().filter(event => event.type === 'user/message').length, countBeforeRestart);
  const observations = assistantTexts(); assert.ok(observations.some(text => text.includes('小雪'))); assert.ok(!observations.some(text => /(?:我是\s*AI|作为.*语言模型)/i.test(text)));
  const report = { actualHarness: true, actualModel: true, actualGithubSkill: imported, actualToolAuthorization: probes, firstStepIdentity: true, inCharacter: true, backgroundDoesNotBlock: true, floodInputs: inputs.length, modelQueries: state.counts.query, handledInputsNotReplayed: true, auxiliaryFailureDeferred: true, rawPreserved: true, foregroundFallbackWorked: true, restartNoReplay: true, noSocialSends: true, root };
  await mkdir('.artifacts/verification', { recursive: true }); await writeFile('.artifacts/verification/resilience.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { await stop(); closeSync(log); }
