import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { openSync, closeSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

loadEnvFile('.env');
const root = resolve('.artifacts/auxiliary-cost', String(Date.now())), port = 3116, id = 'auxiliary-probe';
await mkdir(root, { recursive: true });
const env = { ...process.env, KW_DATA_ROOT: root, DSH_HOME: join(root, 'dsh'), KW_HOST_PORT: String(port), KW_PUBLIC_URL: `http://127.0.0.1:${port}/`, KW_CONTAINER: 'false', KW_BACKUP_ENABLED: 'false', KW_AUXILIARY_TEST: 'true' };
const log = openSync(join(root, 'harness.log'), 'w', 0o600);
let host;
const admin = (action, payload = null) => { const result = spawnSync(process.execPath, ['scripts/admin.mjs', action, JSON.stringify(payload)], { env, encoding: 'utf8', timeout: 180000 }); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
async function call(action, details = {}) { const response = await fetch(`http://127.0.0.1:${port}/kw-auxiliary-cost-test`, { method: 'POST', body: JSON.stringify({ action, ...details }) }); const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value; }
async function start() {
  host = spawn(process.execPath, ['scripts/start.mjs'], { env, stdio: ['ignore', log, log] });
  let ready = false;
  for (let i = 0; i < 120; i++) { assert.equal(host.exitCode, null); ready = await fetch(`http://127.0.0.1:${port}/kw-health`).then(value => value.ok, error => { if (error.cause?.code === 'ECONNREFUSED') return false; throw error; }); if (ready) break; await delay(500); }
  assert.ok(ready);
}
async function stop() {
  if (host?.exitCode === null) { const done = new Promise(resolve => host.once('exit', resolve)); admin('shutdown'); await Promise.race([done, delay(20000, undefined, { ref: false })]); assert.notEqual(host.exitCode, null); }
}
try {
  await start();
  admin('model.save', { id: 'official-test', name: '官方隔离验收', kind: 'chat', harnessProvider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off', expectedRevision: null });
  admin('role.create', { id, accountId: 'main', name: '辅助消耗验收', initialPersona: '本机内部阅读资料验收，保留真实来源；同一阅读主题的进展可以合并。', provider: env.KW_LLM_PROVIDER, model: env.KW_LLM_MODEL, chatPresetId: 'official-test', worldMode: 'mixed', state: 'paused' });
  admin('role.prepare', { id });
  admin('extension', { roleId: id, request: { action: 'install', id: 'auxiliary-cost', spec: resolve('tests/fixtures/auxiliary-cost') } });
  admin('extension', { roleId: id, request: { action: 'enable', id: 'auxiliary-cost' } });
  await stop(); await start();
  assert.ok((await call('seed')).pending >= 20);
  const contexts = await call('contexts');
  assert.ok(contexts.every(value => value.memories.length === 0));
  assert.equal((await call('stats')).operations.filter(item => item.tool === 'memory_query_expand').length, 0);
  admin('memory.recall', { roleId: id, query: '红楼梦阅读的后续讨论', semantic: true });
  admin('memory.recall', { roleId: id, query: '红楼梦阅读的后续讨论', semantic: true });
  assert.equal((await call('stats')).operations.filter(item => item.tool === 'memory_query_expand').length, 1);
  const result = admin('memory.consolidate', { roleId: id }); assert.equal(result.status, 'completed');
  const settled = await call('stats');
  const operations = settled.operations.filter(item => item.tool === 'memory_consolidate');
  assert.ok(operations.length <= 3, JSON.stringify(operations.map(item => item.state)));
  assert.ok(operations.some(item => item.state === 'succeeded'));
  assert.equal(settled.pending, 0);
  admin('memory.consolidate', { roleId: id });
  assert.equal((await call('stats')).operations.filter(item => item.tool === 'memory_consolidate').length, operations.length);
  const generated = admin('role.generate', { idea: '住在雨港旧书店的猫耳少女，喜欢修复古书，正在寻找失踪老师留下的地图。', chatPresetId: 'official-test' });
  assert.ok(generated.world.length && generated.expressionExamples.length >= 2 && generated.initialPersona.length > 100);
  assert.equal(admin('status').roles.length, 1, '生成草稿不提前创建角色');
  const created = admin('role.create', { ...generated, id: 'generated-reader', accountId: 'main', provider: env.KW_LLM_PROVIDER, model: env.KW_LLM_MODEL, chatPresetId: 'official-test', state: 'paused' });
  assert.equal(created.initialPersona, generated.initialPersona);
  assert.equal(admin('memory.list', { roleId: created.id }).items.filter(item => item.kind === 'world').length, generated.world.length);
  assert.deepEqual(created.groups, []); assert.deepEqual(created.contacts, []);
  assert.ok((await call('contexts', { roleId: created.id, ageWorld: true })).every(value => value.memories.length === 0), '世界资料按需查询');
  assert.ok(admin('memory.recall', { roleId: created.id, kind: 'world' }).items.length, '初始世界资料可通过工具检索');
  const repair = process.env.KW_AUXILIARY_REPAIR_SAMPLE ? await call('repair', { sample: JSON.parse(await readFile(process.env.KW_AUXILIARY_REPAIR_SAMPLE, 'utf8')) }) : null;
  const report = { actualHarness: true, actualModel: true, localContextRequests: 3, contextModelRequests: 0, explicitQueryRequests: 2, queryExpansionModelRequests: 1, sourceEvents: 20, consolidationModelRequests: operations.length, consolidationUsage: operations.map(item => ({ state: item.state, estimatedTokens: item.arguments.estimatedTokens, usage: item.result?.usage ?? null })), idempotent: true, characterGenerated: true, generatedWorldEntries: generated.world.length, generatedExpressions: generated.expressionExamples.length, createdState: created.state, initialWorldToolRead: true, repair, noSocialSends: true, root };
  await writeFile('.artifacts/verification/auxiliary-cost-model.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await stop();
  closeSync(log);
}
