import { spawnSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { resolve, join } from 'node:path';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

loadEnvFile('.env');
function admin(action, payload = null) {
  const result = spawnSync(process.execPath, ['scripts/admin.mjs', action, JSON.stringify(payload)], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}
for (const extension of admin('status').extensions) if (extension.packageName === 'kwagent-plan-validation' && extension.enabled) {
  admin('role.control', { id: extension.roleId, state: 'paused' });
  admin('extension', { roleId: extension.roleId, request: { action: 'disable', id: extension.id } });
}
const id = `plans-${Date.now()}`;
admin('role.create', { id, accountId: 'main', name: '提醒持久化验收', initialPersona: '本地提醒协议检查。', provider: process.env.KW_LLM_PROVIDER, model: process.env.KW_LLM_MODEL });
admin('extension', { roleId: id, request: { action: 'install', id: 'validation', spec: resolve('tests/fixtures/plan-validation') } });
try {
  const enabled = admin('extension', { roleId: id, request: { action: 'enable', id: 'validation' } });
  assert.equal(enabled.enabled, true);
  assert.equal(admin('status').roles.find(role => role.id === id).state, 'disabled');
  admin('role.control', { id, state: 'active' });
  const result = JSON.parse(await readFile(join(resolve(process.env.KW_DATA_ROOT ?? './data'), 'workspaces', id, 'plan-validation.json'), 'utf8'));
  assert.equal(result.selected, 1);
  await mkdir('.artifacts/verification', { recursive: true });
  await writeFile('.artifacts/verification/plans.json', JSON.stringify({ ...result, disabledRoleEnable: true }, null, 2));
  console.log(JSON.stringify(result));
} finally {
  admin('role.control', { id, state: 'paused' });
  admin('extension', { roleId: id, request: { action: 'disable', id: 'validation' } });
}
