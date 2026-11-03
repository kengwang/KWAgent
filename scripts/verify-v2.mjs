import { spawnSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { resolve, join } from 'node:path';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

loadEnvFile('.env');
function admin(action, payload = null) { const result = spawnSync(process.execPath, ['scripts/admin.mjs', action, JSON.stringify(payload)], { encoding: 'utf8' }); if (result.status !== 0) throw new Error(result.stderr); return JSON.parse(result.stdout); }
function roles() { const items = []; let cursor = 0; for (;;) { const page = admin('records.list', { kind: 'role', cursor }); items.push(...page.items); if (page.nextCursor === null) return items; cursor = page.nextCursor; } }
if (process.argv[2] === 'resume') {
  const report = JSON.parse(await readFile('.artifacts/verification/v2.json', 'utf8'));
  admin('role.prepare', { id: report.roleId }); assert.equal(admin('role.read', { roleId: report.roleId }).state, 'paused');
  assert.ok(admin('payload.read', { roleId: report.roleId, id: report.payloadId }).text);
  let cursor = 0; let found = false;
  for (;;) { const page = admin('session.records', { roleId: report.roleId, cursor, limit: 200 }); found ||= page.items.some(item => item.type === 'plugin:kwagent/payload'); if (page.nextCursor === null) break; cursor = page.nextCursor; }
  assert.equal(found, true); await writeFile('.artifacts/verification/v2.json', JSON.stringify({ ...report, restartedReferencesReadable: true }, null, 2)); console.log(JSON.stringify({ restartedReferencesReadable: true })); process.exit(0);
}
const before = roles().map(role => ({ id: role.id, state: role.state }));
const id = `v2-${Date.now()}`;
admin('role.create', { id, accountId: 'main', name: 'v0.2 工具与状态验收', initialPersona: '仅执行本地验证，保持安静。', provider: process.env.KW_LLM_PROVIDER, model: process.env.KW_LLM_MODEL });
admin('role.prepare', { id });
admin('extension', { roleId: id, request: { action: 'install', id: 'validation', spec: resolve('tests/fixtures/v2-validation') } });
try {
  admin('extension', { roleId: id, request: { action: 'enable', id: 'validation' } });
  admin('role.control', { id, state: 'active' });
  const path = join(resolve(process.env.KW_DATA_ROOT), 'workspaces', id, 'v2-validation.json'); let result;
  for (const deadline = Date.now() + 60000; Date.now() < deadline;) {
    try { result = JSON.parse(await readFile(path, 'utf8')); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(250);
  }
  assert.ok(result, '原生工具验收未完成'); if (result.error) throw new Error(result.error);
  const after = new Map(roles().map(role => [role.id, role.state])); for (const role of before) assert.equal(after.get(role.id), role.state);
  await mkdir('.artifacts/verification', { recursive: true }); await writeFile('.artifacts/verification/v2.json', JSON.stringify({ roleId: id, ...result, originalRoleStatesPreserved: true }, null, 2)); console.log(JSON.stringify(result));
} finally { admin('role.control', { id, state: 'paused' }); admin('extension', { roleId: id, request: { action: 'disable', id: 'validation' } }); }
