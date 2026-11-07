import assert from 'node:assert/strict';
import { existsSync, createWriteStream } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Store, Payloads, prepareRolePython } from '@kwagent/core';
import { resolve } from 'node:path';

assert.equal(process.platform, 'linux');
assert.equal(process.getuid(), 10001);
assert.equal(process.versions.node, '24.18.0');
for (const path of ['.env', '.git', '.artifacts', 'scripts/verify-social.mjs']) assert.equal(existsSync(path), false, path);
for (const [command, args] of [['bun', ['--version']], ['git', ['--version']], ['ffmpeg', ['-version']], ['uv', ['--version']]]) {
  const result = spawnSync(command, args, { encoding: 'utf8' }); assert.equal(result.status, 0, command);
  if (command === 'bun') assert.equal(result.stdout.trim(), '1.4.2');
  if (command === 'uv') assert.match(result.stdout, /^uv 0\.13\.7\b/);
}
const python = await prepareRolePython('/data/workspaces/image-python');
const browser = spawnSync(python, [resolve('scripts/verify-python-browser.py'), 'image'], { cwd: '/data/workspaces/image-python', encoding: 'utf8', timeout: 60000 });
assert.equal(browser.status, 0, browser.stderr || browser.stdout);
console.log(browser.stdout.trim());
await mkdir('/data/tmp', { recursive: true });
const log = createWriteStream('/data/tmp/image-smoke.log');
const child = spawn(process.execPath, ['scripts/start.mjs'], { env: { ...process.env, KW_BIND_IP: '127.0.0.1', LAGRANGE_BASE_URL: 'http://127.0.0.1:9/', LAGRANGE_TOOL_TIMEOUT_MS: '1000', KW_BACKUP_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
const exited = once(child, 'exit');
function admin(action, payload = null) {
  const result = spawnSync(process.execPath, ['scripts/admin.mjs', action, JSON.stringify(payload)], { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
try {
  let ready = false;
  for (const deadline = Date.now() + 60000; Date.now() < deadline;) {
    assert.equal(child.exitCode, null, 'Harness 提前退出');
    const response = await fetch('http://127.0.0.1:3080/kw-health', { signal: AbortSignal.timeout(1000) }).catch(error => { if (!['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET'].includes(error.cause?.code)) throw error; });
    if (response?.ok && (await response.json()).managementReady) { ready = true; break; }
    await delay(250);
  }
  assert.equal(ready, true, 'Harness 管理界面未就绪，诊断位于 /data/tmp/image-smoke.log');
  assert.equal(admin('doctor').database, 'ok');
  if (process.env.KW_TEST_SCHEMA) { assert.equal(admin('role.read', { roleId: 'legacy-image' }).state, 'disabled'); assert.ok((await readdir('/data/kwagent')).some(name => name.includes(`.schema${process.env.KW_TEST_SCHEMA}-`))); }
  const role = admin('role.create', { id: 'image-smoke', accountId: 'main', name: '镜像验证', initialPersona: '仅保存本地构建验证记录。', provider: 'deepseek-official', model: 'configured-at-deployment', preinjectSkills: ['kwagent-life', 'lagrange'], adminQQs: [10001] });
  assert.equal(role.state, 'disabled');
  assert.deepEqual(role.preinjectSkills, ['kwagent-life', 'lagrange']); assert.deepEqual(role.adminQQs, [10001]); assert.deepEqual(admin('skill.list', { roleId: role.id }), []);
  const event = admin('event', { roleId: role.id, text: '镜像中的 SQLite、Session 管理与对象目录可写。' });
  const source = admin('source.read', { roleId: role.id, id: event.id });
  const continuity = admin('continuity.revise', { roleId: role.id, expectedRevision: null, data: { kind: 'thread', title: '镜像中的持续事项', content: '验证连续性备份恢复。', sources: [event.id] }, reason: '断网镜像验收' });
  assert.equal(admin('continuity.read', { roleId: role.id, id: continuity.id, raw: true }).revision, 1);
  assert.ok(admin('payload.read', { roleId: role.id, id: source.payloadId }).text.includes(event.id));
  const reset = admin('role.reset', { id: role.id, expectedRevision: role.revision });
  assert.notEqual(reset.sessionId, role.sessionId); assert.equal(reset.state, 'disabled');
  assert.equal(admin('continuity.read', { roleId: role.id, id: continuity.id, raw: true }).revision, 1);
  const disposable = admin('role.create', { id: 'image-delete', accountId: 'main', name: '镜像删除验收', initialPersona: '保留历史。', provider: 'deepseek-official', model: 'configured-at-deployment' });
  const deleted = admin('role.delete', { id: disposable.id, expectedRevision: disposable.revision }); assert.ok(deleted.deletedAt);
  assert.equal(admin('records.list', { kind: 'role' }).items.some(item => item.id === disposable.id), false);
  assert.ok(admin('persona.read', { roleId: disposable.id }).summary.deletedAt);
  for (const state of ['paused', 'stopped']) {
    const inactive = admin('role.create', { id: `image-${state}`, accountId: 'main', name: state, initialPersona: '离线管理角色。', provider: 'deepseek-official', model: 'configured-at-deployment', state });
    const changed = admin('role.reset', { id: inactive.id, expectedRevision: inactive.revision }); assert.equal(changed.state, state); assert.notEqual(changed.sessionId, inactive.sessionId);
    assert.ok(admin('session.records', { roleId: inactive.id }).items.length);
    assert.ok(admin('role.delete', { id: inactive.id, expectedRevision: changed.revision }).deletedAt);
  }
  const duplicate = spawnSync(process.execPath, ['scripts/start.mjs'], { encoding: 'utf8', timeout: 10000 });
  assert.notEqual(duplicate.status, 0); assert.match(duplicate.stderr, /ELOCKED/);
  admin('quiesce');
  const backup = admin('backup');
  const restored = spawnSync(process.execPath, ['scripts/admin.mjs', 'restore', backup.directory, '/data/tmp/image-restored'], { encoding: 'utf8', timeout: 20000 }); assert.equal(restored.status, 0, restored.stderr);
  const store = new Store('/data/tmp/image-restored/kwagent/state.sqlite');
  try { assert.equal(store.integrity(), 'ok'); assert.equal(store.role(role.id).state, 'disabled'); assert.equal(store.role(role.id).sessionId, reset.sessionId); assert.deepEqual(store.role(role.id).preinjectSkills, role.preinjectSkills); assert.deepEqual(store.role(role.id).adminQQs, role.adminQQs); assert.equal(store.roles().some(item => item.id === disposable.id), false); assert.equal(store.db.prepare("SELECT revision FROM documents WHERE kind='continuity' AND id=?").get(continuity.id).revision, 1); assert.equal((await new Payloads(store, '/data/tmp/image-restored/artifacts').value(role.id, source.payloadId)).id, event.id); } finally { store.close(); }
  admin('shutdown');
  const result = await Promise.race([exited, delay(20000, undefined, { ref: false }).then(() => { throw new Error('Harness 未在期限内停止'); })]); assert.equal(result[0], 0);
  console.log(JSON.stringify({ nonRoot: true, node: process.versions.node, harness: true, database: true, payload: true, singleInstance: true, backupRestore: true, noExternalNetwork: true }));
} finally {
  if (child.exitCode === null) { child.kill('SIGTERM'); await exited; }
  log.end();
}
