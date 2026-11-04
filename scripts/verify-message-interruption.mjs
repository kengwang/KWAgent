import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { openSync, closeSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

loadEnvFile('.env');
const root = resolve('.artifacts/message-interruption', String(Date.now()));
await mkdir(root, { recursive: true });
const env = { ...process.env, KW_DATA_ROOT: root, DSH_HOME: join(root, 'dsh'), KW_HOST_PORT: '3092', KW_PUBLIC_URL: 'http://127.0.0.1:3092/', HTTP_PROXY: 'http://127.0.0.1:7897', HTTPS_PROXY: 'http://127.0.0.1:7897', NO_PROXY: 'localhost,127.0.0.1' };
const log = openSync(join(root, 'harness.log'), 'w', 0o600);
const host = spawn(process.execPath, ['scripts/start.mjs'], { env, stdio: ['ignore', log, log] });
const admin = (action, payload = null) => {
  const result = spawnSync(process.execPath, ['scripts/admin.mjs', action, JSON.stringify(payload)], { env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
};
const payload = payloadId => {
  let text = '', offset = 0;
  for (;;) {
    const page = admin('payload.read', { roleId: id, id: payloadId, offset, limit: 65536 });
    text += page.text; if (page.nextCursor === null) return JSON.parse(text); offset = page.nextCursor;
  }
};
async function until(test, description, milliseconds = 180000) {
  for (const end = Date.now() + milliseconds; Date.now() < end;) {
    if (host.exitCode !== null) throw new Error(`验收 Host 已退出：${host.exitCode}`);
    const value = await test(); if (value) return value;
    await delay(200);
  }
  throw new Error(`等待超时：${description}`);
}
const id = 'message-interruption';
let created = false;
try {
  await until(async () => { try { return (await fetch('http://127.0.0.1:3092/kw-health')).ok; } catch (error) { if (error.cause?.code === 'ECONNREFUSED') return false; throw error; } }, 'Host 管理就绪');
  admin('role.create', { id, accountId: 'main', name: '收尾中接收新输入验收', provider: env.KW_LLM_PROVIDER, model: env.KW_LLM_MODEL, initialPersona: '本地验收角色。首先加载kwagent-life Skill，再调用verification_read实际读取文件，用真实operationId保存life和一条episode记忆，记忆正文与关联ID分别填写。完成后结束当前活动。新输入到达时优先阅读其内容，用verification_mark stage=group记录一句实际拟回应后结束。禁止QQ、空间发送，不使用shell或创建额外计划。' });
  created = true;
  admin('role.prepare', { id });
  admin('extension', { roleId: id, request: { action: 'install', id: 'observer', spec: resolve('tests/fixtures/continuity-observer') } });
  admin('extension', { roleId: id, request: { action: 'enable', id: 'observer' } });
  admin('role.control', { id, state: 'active' });
  const consolidation = await until(() => {
    const role = admin('status', { roleId: id }).roles.find(role => role.id === id);
    if (role.runtime.error) throw new Error(role.runtime.error);
    return admin('records.list', { roleId: id, kind: 'operation', limit: 100 }).items.find(op => op.tool === 'memory_consolidate' && op.state === 'started');
  }, '真实模型开始收尾记忆整理');
  const started = Date.now();
  const event = admin('event', { roleId: id, text: '这是初始化之后到达的新内容：你好，刚才读到的资料有什么值得继续了解？请及时接纳这条输入，并用verification_mark stage=group记录你的拟回应。不要发送任何QQ或空间消息。', context: { scene: 'group', peerId: 20001 }, sender: { id: 10001, nickname: '本地验收人物' } });
  const accepted = await until(() => admin('events', { roleId: id, limit: 200 }).items.find(item => item.id === event.id && ['accepted', 'completed'].includes(item.delivery.state)), '新消息实际进入模型步骤', 20000);
  const elapsed = Date.now() - started;
  const observationsPath = join(root, 'workspaces', id, 'continuity-observations.jsonl');
  await until(async () => { try { return (await readFile(observationsPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)).find(item => item.stage === 'group'); } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }, '模型处理新消息');
  const observed = admin('events', { roleId: id, limit: 200 }).items;
  assert.equal(admin('status', { roleId: id }).roles.find(role => role.id === id).runtime.error, null);
  admin('role.control', { id, state: 'paused' });
  const calls = observed.filter(item => item.type === 'tool-result').map(item => {
    const event = payload(admin('source.read', { roleId: id, id: item.id }).payloadId);
    const result = event.payload.result?.payloadId ? payload(event.payload.result.payloadId) : event.payload;
    return { name: event.payload.name, arguments: result.arguments ?? event.payload.arguments, isError: event.payload.isError ?? result.result?.isError ?? result.isError };
  });
  assert.ok(calls.some(call => call.name === 'skill' && call.arguments.name === 'kwagent-life'), '模型必须实际加载运行Skill');
  assert.ok(calls.every(call => !call.isError), '内部工具参数与来源应有效');
  const cancelled = admin('record.read', { roleId: id, kind: 'operation', id: consolidation.id });
  assert.equal(cancelled.state, 'failed', '收尾请求应在新输入到达后取消');
  const life = admin('continuity.read', { roleId: id, id: `life:${id}`, raw: true });
  assert.equal(life.data.kind, 'life');
  assert.ok(life.data.memories.length > 0);
  assert.ok(life.data.memories.every(value => admin('memory.read', { roleId: id, id: value })));
  const report = { roleId: id, skillLoaded: true, actualModel: true, realFileRead: true, validMemoryReferences: true, internalToolErrors: 0, consolidationInterrupted: true, inputAccepted: accepted.id, inputAcceptanceMs: elapsed, responseRecorded: true, noSocialSends: true };
  await mkdir('.artifacts/verification', { recursive: true });
  await writeFile('.artifacts/verification/message-interruption.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  if (created && host.exitCode === null) admin('role.control', { id, state: 'paused' });
  if (host.exitCode === null) { const exit = new Promise(resolve => host.once('exit', resolve)); host.kill('SIGTERM'); await Promise.race([exit, delay(20000)]); if (host.exitCode === null) host.kill('SIGKILL'); }
  closeSync(log);
}
