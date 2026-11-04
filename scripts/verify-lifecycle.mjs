import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { openSync, closeSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store, operationSchema } from '@kwagent/core';

loadEnvFile('.env');
const root = resolve('.artifacts/lifecycle', String(Date.now())); await mkdir(root, { recursive: true });
const id = 'lifecycle-integration';
const env = { ...process.env, KW_DATA_ROOT: root, DSH_HOME: join(root, 'dsh'), KW_HOST_PORT: '3095', KW_PUBLIC_URL: 'http://127.0.0.1:3095/', KW_BACKUP_ENABLED: 'false', KW_CHAT_THINKING_FORMAT: 'deepseek', KW_LIFECYCLE_TEST: 'true', KW_LIFECYCLE_TEST_ROLE: id, HTTP_PROXY: 'http://127.0.0.1:7897', HTTPS_PROXY: 'http://127.0.0.1:7897', NO_PROXY: 'localhost,127.0.0.1' };
const log = openSync(join(root, 'harness.log'), 'a', 0o600);
let host, ready = false;
const command = (action, payload = null) => spawnSync(process.execPath, ['scripts/admin.mjs', action, JSON.stringify(payload)], { env, encoding: 'utf8' });
const admin = (action, payload = null) => { const result = command(action, payload); if (result.status !== 0) throw new Error(result.stderr || result.stdout); return JSON.parse(result.stdout); };
const role = () => admin('role.read', { roleId: id });
async function until(test, text, milliseconds = 180000) { for (const end = Date.now() + milliseconds; Date.now() < end;) { if (host.exitCode !== null) throw new Error(`Host退出：${host.exitCode}`); const value = await test(); if (value) return value; await delay(200); } throw new Error(`等待超时：${text}`); }
async function start() {
  ready = false; host = spawn(process.execPath, ['scripts/start.mjs'], { env, stdio: ['ignore', log, log] });
  await until(async () => { try { return (await fetch('http://127.0.0.1:3095/kw-health')).ok; } catch (error) { if (error.cause?.code === 'ECONNREFUSED') return false; throw error; } }, 'Host就绪', 60000); ready = true;
}
async function stop() { if (host?.exitCode === null) { const exit = new Promise(resolve => host.once('exit', resolve)); if (ready) admin('shutdown'); else host.kill('SIGTERM'); await Promise.race([exit, delay(20000)]); if (host.exitCode === null) { host.kill('SIGKILL'); throw new Error('Host未正常关闭'); } ready = false; } }
async function fixture(action) { const response = await fetch('http://127.0.0.1:3095/kw-lifecycle-test', action ? { method: 'POST', body: JSON.stringify({ action }), headers: { 'Content-Type': 'application/json' } } : {}); if (!response.ok) throw new Error(`验收入口返回 ${response.status}：${await response.text()}`); return response.json(); }
async function observer() { const result = admin('extension', { roleId: id, request: { action: 'enable', id: 'observer' } }); if (result.state === 'pending-restart') { await stop(); await start(); } }
function completedReset(from) { return admin('records.list', { roleId: id, kind: 'operation', limit: 200 }).items.some(item => item.tool === 'role_lifecycle_reset' && item.arguments.from === from && item.state === 'succeeded'); }
function readPayload(payloadId, roleId = id) { let text = '', offset = 0; for (;;) { const page = admin('payload.read', { roleId, id: payloadId, offset, limit: 65536 }); text += page.text; if (page.nextCursor === null) return JSON.parse(text); offset = page.nextCursor; } }
async function marked(sessionId) { try { return (await readFile(join(root, 'workspaces', id, 'lifecycle-observations.jsonl'), 'utf8')).split('\n').filter(Boolean).map(value => JSON.parse(value)).some(item => item.sessionId === sessionId); } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
try {
  await start();
  const initial = admin('role.create', { id, accountId: 'main', name: '会话与角色管理验收', initialPersona: '这是本机隔离验收，没有真实会话绑定。每次感知后只调用一次verification_mark保存一句内部观察，然后结束。禁止所有QQ、空间、shell和额外计划，不手动压缩上下文。', provider: env.KW_LLM_PROVIDER, model: env.KW_LLM_MODEL, state: 'paused' });
  admin('role.prepare', { id });
  admin('extension', { roleId: id, request: { action: 'install', id: 'observer', spec: resolve('tests/fixtures/lifecycle-observer') } }); await observer();
  const source = admin('event', { roleId: id, text: '本机验收输入：保留这段经历和正在研究的问题，重置当前对话。', context: { scene: 'group', peerId: 20001 } });
  const memory = admin('memory.revise', { memory: { roleId: id, kind: 'focus', title: '保留的研究问题', content: '本地会话管理的经历需要保留。', realm: 'real', epistemic: 'reported', people: [], aliases: [], sources: [source.id], archived: false, attention: 0.7 }, expectedRevision: null, reason: '验证真实持久状态' });
  const goal = admin('plan', { roleId: id, request: { action: 'create', kind: 'goal', title: '继续研究', instruction: '之后继续理解实际来源。', sources: [source.id] } });
  const timer = admin('plan', { roleId: id, request: { action: 'create', kind: 'time', title: '稍后阅读', instruction: '重新阅读本地研究问题。', timing: { kind: 'after', after_seconds: 3600 } } });
  const previous = role();
  const reset = admin('role.reset', { id, expectedRevision: previous.revision });
  assert.notEqual(reset.sessionId, initial.sessionId); assert.equal(reset.state, 'paused'); assert.equal(reset.persona, previous.persona);
  assert.equal(admin('memory.read', { roleId: id, id: memory.id }).revision, memory.revision);
  assert.equal(admin('record.read', { roleId: id, kind: 'plan', id: goal.id }).id, goal.id);
  assert.equal(admin('record.read', { roleId: id, kind: 'plan', id: timer.id }).status, 'paused');
  assert.notEqual(command('role.reset', { id, expectedRevision: previous.revision }).status, 0);
  await observer();
  let state = await fixture(); assert.ok(state.archived.includes(previous.sessionId)); assert.equal(state.frozen.recentExchanges.length, 0);
  const oldRows = admin('session.records', { roleId: id, sessionId: previous.sessionId, limit: 50 }); assert.ok(oldRows.items.length);
  const oldRecord = admin('session.read', { roleId: id, sessionId: previous.sessionId, seq: oldRows.items[0].seq }); assert.equal(readPayload(oldRecord.payloadId).seq, oldRows.items[0].seq);
  admin('role.create', { id: 'other-role', accountId: 'main', name: '独立角色', initialPersona: '独立。', provider: env.KW_LLM_PROVIDER, model: env.KW_LLM_MODEL });
  assert.notEqual(command('session.read', { roleId: 'other-role', sessionId: previous.sessionId, seq: oldRows.items[0].seq }).status, 0);
  const archived = role().sessionId; await fixture('archive'); await until(() => completedReset(archived), '归档后自动换会话');
  assert.notEqual(role().sessionId, archived); assert.equal(role().state, 'paused'); await observer();
  const cold = role().sessionId; await fixture('archive-during-maintenance'); await stop(); await start();
  await until(() => completedReset(cold), '重启发现旧会话已归档'); assert.notEqual(role().sessionId, cold); assert.equal(role().state, 'paused'); await observer();
  await fixture('crash-next-reset'); const crashExit = new Promise(resolve => host.once('exit', resolve));
  const interrupted = command('role.reset', { id, expectedRevision: role().revision }); assert.notEqual(interrupted.status, 0); assert.equal(await crashExit, 73); ready = false;
  const database = new Store(join(root, 'kwagent/state.sqlite')); const pendingId = database.meta(`lifecycle:${id}`); assert.ok(pendingId); const pending = database.get('operation', pendingId, operationSchema); const target = pending.arguments.to; assert.equal(database.role(id).sessionId, target); database.close();
  await start(); await until(() => admin('record.read', { roleId: id, kind: 'operation', id: pendingId }).state === 'succeeded', '恢复中断的管理操作');
  assert.equal(role().sessionId, target); assert.equal(role().state, 'paused');
  await observer(); admin('role.control', { id, state: 'active' });
  await until(() => marked(target), '旧会话的真实模型步骤');
  state = await fixture(); const oldTask = state.schedules.find(task => task.sessionId === target && task.status === 'active'); assert.ok(oldTask);
  await fixture('archive'); await until(() => completedReset(target), '运行中归档后换会话'); const continued = role().sessionId;
  await until(() => marked(continued), '新会话继续真实模型步骤');
  state = await fixture(); assert.ok(state.schedules.some(task => task.sessionId === continued && task.status === 'active')); assert.equal(state.schedules.some(task => task.sessionId === target && task.status === 'active'), false);
  admin('role.control', { id, state: 'paused' });
  const beforeDelete = role(); const deleted = admin('role.delete', { id, expectedRevision: beforeDelete.revision }); assert.ok(deleted.deletedAt);
  assert.equal(admin('records.list', { kind: 'role', limit: 200 }).items.some(item => item.id === id), false);
  assert.notEqual(command('role.read', { roleId: id }).status, 0);
  assert.equal(admin('memory.read', { roleId: id, id: memory.id }).content, memory.content);
  assert.equal(readPayload(admin('memory.detail', { roleId: id, id: memory.id }).payloadId).content, memory.content);
  assert.equal(readPayload(admin('session.read', { roleId: id, sessionId: previous.sessionId, seq: oldRows.items[0].seq }).payloadId).seq, oldRows.items[0].seq);
  assert.equal(readPayload(admin('persona.read', { roleId: id }).payloadId).deletedAt, deleted.deletedAt);
  assert.equal(readPayload(admin('source.read', { roleId: id, id: `role:${id}` }).payloadId).deletedAt, deleted.deletedAt);
  assert.equal(readPayload(admin('revision.read', { roleId: id, entity: 'role', id, revision: 1 }).payloadId).revision, 1);
  assert.equal(admin('record.read', { roleId: id, kind: 'plan', id: goal.id }).status, 'cancelled');
  assert.equal(admin('record.read', { roleId: id, kind: 'plan', id: timer.id }).status, 'cancelled');
  assert.equal(readPayload(admin('record.detail', { roleId: id, kind: 'plan', id: timer.id }).payloadId).status, 'cancelled');
  assert.equal(admin('records.list', { kind: 'operation', roleId: id, limit: 200 }).items.some(item => /^send_/.test(item.tool)), false);
  const backup = admin('backup'); const restored = join(root, 'restored'); const restore = spawnSync(process.execPath, ['scripts/admin.mjs', 'restore', backup.directory, restored], { env, encoding: 'utf8' }); assert.equal(restore.status, 0, restore.stderr);
  const snapshot = new Store(join(restored, 'kwagent/state.sqlite')); assert.equal(snapshot.roles().some(item => item.id === id), false); assert.equal(snapshot.memory(memory.id).content, memory.content); snapshot.close();
  const report = { actualHarness: true, actualModel: true, manualReset: true, archiveRollover: true, coldArchiveRecovery: true, realProcessCrash: true, interruptedOperationRecovered: true, sameTargetAfterRecovery: true, memoryAndPlansPreserved: true, oldSessionReadable: true, crossRoleSessionRejected: true, scheduleMoved: true, deleteRole: true, deletedHistoryRestored: true, noSocialSends: true, root };
  await mkdir('.artifacts/verification', { recursive: true }); await writeFile('.artifacts/verification/lifecycle.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { await stop(); closeSync(log); }
