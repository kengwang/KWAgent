import { loadEnvFile } from 'node:process';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
loadEnvFile('.env');
const admin = (action, payload = null) => { const result = spawnSync(process.execPath, ['scripts/admin.mjs', action, JSON.stringify(payload)], { encoding: 'utf8' }); if (result.status !== 0) throw new Error(result.stderr); return JSON.parse(result.stdout); };
const id = process.argv[2] === 'resume' ? JSON.parse(await readFile('.artifacts/verification/continuity.json', 'utf8')).roleId : `continuity-${Date.now()}`;
if (process.argv[2] === 'resume') {
  admin('role.prepare', { id }); assert.equal(admin('role.read', { roleId: id }).state, 'paused');
  const page = admin('continuity.list', { roleId: id }); assert.ok(page.items.length >= 3);
  const detail = admin('continuity.read', { roleId: id, id: page.items[0].id }); assert.ok(admin('payload.read', { roleId: id, id: detail.payloadId }).text);
  const report = JSON.parse(await readFile('.artifacts/verification/continuity.json', 'utf8')); await writeFile('.artifacts/verification/continuity.json', JSON.stringify({ ...report, restarted: true }, null, 2)); console.log(JSON.stringify({ restarted: true })); process.exit(0);
}
function roles() { const items = []; let cursor = 0; for (;;) { const page = admin('records.list', { kind: 'role', limit: 200, cursor }); items.push(...page.items); if (page.nextCursor === null) return items; cursor = page.nextCursor; } }
const baseline = roles().map(role => [role.id, role.state]);
admin('role.create', { id, accountId: 'main', name: '连续性行为验收', provider: process.env.KW_LLM_PROVIDER, model: process.env.KW_LLM_MODEL, initialPersona: '仅执行本地连续性验收。只使用continuity_read、continuity_revise、self_revise、life_plan、verification_read、verification_mark及必要内部工具。禁止QQ与空间发送，不执行shell。初始化时实际调用verification_read，以其operationId作为依据，保存当前生活life记录，activity.state=completed，记录读到的资料及尚有疑问。根据人工输入创建标题“面试后续”的thread记录，并调用verification_mark stage=initialized。收到明确拒绝时将该thread改为declined并移除reviewAt，保存verification_mark stage=refused。收到反馈时创建有期限的reflection并mark stage=feedback。不要为反思改写长期人格。完成后休息，不创建额外安排。' });
const prepared = admin('role.prepare', { id }); assert.equal(prepared.compactionEngine, 'MindCompaction'); assert.equal(prepared.compactionMaxTokens, 8192);
admin('extension', { roleId: id, request: { action: 'install', id: 'observer', spec: resolve('tests/fixtures/continuity-observer') } });
admin('extension', { roleId: id, request: { action: 'enable', id: 'observer' } });
const observations = async () => { try { return (await readFile(join(resolve(process.env.KW_DATA_ROOT), 'workspaces', id, 'continuity-observations.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
async function until(stage) {
  for (const end = Date.now() + 900000; Date.now() < end;) {
    const state = admin('status', { roleId: id }); const role = state.roles.find(role => role.id === id); if (role.runtime.error) throw new Error(role.runtime.error);
    if ((await observations()).some(row => row.stage === stage) && role.runtime.state === 'waiting') return;
    await delay(1000);
  }
  throw new Error(`等待连续性阶段超时：${stage}`);
}
try {
  admin('event', { roleId: id, text: '本地场景输入：账号10001告诉我明天面试。请创建面试后续话头，people=["10001"]，context={"scene":"private","peerId":10001}，reviewAt设为明天适当时间。它是本地验收中的转述，不发送消息。来源用本条真实人工事件ID。' });
  admin('role.control', { id, state: 'active' }); await until('initialized');
  let records = admin('continuity.list', { roleId: id }).items; const thread = records.find(record => record.kind === 'thread' && record.title === '面试后续'); assert.ok(thread);
  assert.ok(admin('records.list', { roleId: id, kind: 'plan' }).items.some(plan => plan.relatedRecords.includes(thread.id)));
  admin('event', { roleId: id, text: `账号10001现在明确告诉我：“面试这件事我不想继续聊，也不用再问我。”请结束话头 ${thread.id}，status=declined、reviewAt=null，保留来源及原因。不要推断他心情不好。` }); await until('refused');
  const ended = admin('continuity.read', { roleId: id, id: thread.id, raw: true }); assert.equal(ended.data.status, 'declined');
  assert.ok(admin('records.list', { roleId: id, kind: 'plan' }).items.filter(plan => plan.relatedRecords.includes(thread.id)).every(plan => ['cancelled', 'completed'].includes(plan.status)));
  admin('event', { roleId: id, text: '对你交流方式的本地反馈：“我只是分享开心，你有时解释得太多。先和我一起开心就够了。”请保存一条适用于类似交流的短期reflection，保留本条来源，标记feedback，然后休息。' }); await until('feedback');
  const currentRole = admin('role.read', { roleId: id }); assert.equal(currentRole.persona, currentRole.initialPersona, '短期反馈不应自动改写长期人格');
  admin('role.control', { id, state: 'paused' }); const compacted = admin('role.compact', { id }); assert.ok(compacted);
  records = admin('continuity.list', { roleId: id }).items; assert.ok(records.some(record => record.kind === 'reflection' && record.expiresAt)); assert.ok(records.some(record => record.kind === 'life'));
  const activities = admin('activity.list', { roleId: id }).items; assert.ok(activities.length >= 3);
  assert.ok(activities.some(activity => admin('activity.read', { roleId: id, id: activity.id, limit: 200 }).items.some(link => link.kind === 'continuity')));
  const actual = new Map(roles().map(role => [role.id, role.state])); for (const [roleId, state] of baseline) assert.equal(actual.get(roleId), state);
  const report = { roleId: id, initialized: true, refused: true, feedback: true, schedulesCancelled: true, compacted: true, originalStatesPreserved: true, records: records.length, observations: await observations() };
  await mkdir('.artifacts/verification', { recursive: true }); await writeFile('.artifacts/verification/continuity.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { admin('role.control', { id, state: 'paused' }); admin('extension', { roleId: id, request: { action: 'disable', id: 'observer' } }); }
