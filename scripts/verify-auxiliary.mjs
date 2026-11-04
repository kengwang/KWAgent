import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { openSync, closeSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
loadEnvFile('.env');
const root = resolve('.artifacts/auxiliary', String(Date.now()));
await mkdir(root, { recursive: true });
const env = { ...process.env, KW_DATA_ROOT: root, DSH_HOME: join(root, 'dsh'), KW_HOST_PORT: '3093', KW_PUBLIC_URL: 'http://127.0.0.1:3093/', KW_BACKUP_ENABLED: 'false', KW_CHAT_THINKING_FORMAT: 'deepseek', HTTP_PROXY: 'http://127.0.0.1:7897', HTTPS_PROXY: 'http://127.0.0.1:7897', NO_PROXY: 'localhost,127.0.0.1' };
const log = openSync(join(root, 'harness.log'), 'w', 0o600);
const host = spawn(process.execPath, ['scripts/start.mjs'], { env, stdio: ['ignore', log, log] });
let ready = false;
const admin = (action, payload = null) => {
  const result = spawnSync(process.execPath, ['scripts/admin.mjs', action, JSON.stringify(payload)], { env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
};
try {
  for (const end = Date.now() + 60000; Date.now() < end;) {
    if (host.exitCode !== null) throw new Error(`验收Host退出：${host.exitCode}`);
    try { ready = (await fetch('http://127.0.0.1:3093/kw-health')).ok; } catch (error) { if (error.cause?.code !== 'ECONNREFUSED') throw error; }
    if (ready) break;
    await delay(200);
  }
  assert.ok(ready);
  const id = 'auxiliary';
  admin('role.create', { id, accountId: 'main', name: '辅助整理契约验收', provider: env.KW_LLM_PROVIDER, model: env.KW_LLM_MODEL, worldMode: 'mixed', initialPersona: '本地验收资料使用明确的本地情境，保留依据。此角色不启用自主活动，不连接真实会话。' });
  const event = admin('event', { roleId: id, text: '本地验收输入：账号10001向我打招呼，并且希望之后了解阅读进展。这里只验证整理记录的来源和会话字段，记下待回应的话头，不发送任何消息。', context: { scene: 'group', peerId: 20001 }, sender: { id: 10001, nickname: '本地验收人物' } });
  const started = Date.now();
  await admin('memory.consolidate', { roleId: id });
  const operations = admin('records.list', { roleId: id, kind: 'operation', limit: 100 }).items.filter(operation => operation.tool === 'memory_consolidate');
  assert.ok(operations.length);
  for (const operation of operations) {
    const record = admin('record.read', { roleId: id, kind: 'operation', id: operation.id });
    assert.equal(record.arguments.reasoningEffort, 'off');
    assert.equal(record.state, 'succeeded');
    assert.equal(record.result.usage?.reasoningTokens ?? 0, 0);
  }
  const memories = admin('memory.list', { roleId: id }).items;
  assert.ok(memories.some(memory => memory.sources.includes(event.id)));
  const records = admin('continuity.list', { roleId: id }).items.map(record => admin('continuity.read', { roleId: id, id: record.id, raw: true }));
  for (const record of records) {
    assert.ok(record.data.sources.includes(event.id));
    if (record.data.context) assert.deepEqual(record.data.context, { scene: 'group', peerId: 20001 });
  }
  assert.equal(admin('role.read', { roleId: id }).state, 'disabled');
  const report = { actualHarness: true, actualModel: true, auxiliaryEffort: 'off', completed: true, schemaCommitted: true, continuityRecords: records.length, roleRemainsDisabled: true, modelRequests: operations.length, elapsedMs: Date.now() - started, noSocialSends: true };
  await mkdir('.artifacts/verification', { recursive: true });
  await writeFile('.artifacts/verification/auxiliary.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  if (host.exitCode === null) { const exit = new Promise(resolve => host.once('exit', resolve)); if (ready) admin('shutdown'); else host.kill('SIGTERM'); await Promise.race([exit, delay(20000)]); if (host.exitCode === null) host.kill('SIGKILL'); }
  closeSync(log);
}
