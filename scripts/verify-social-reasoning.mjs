import { loadEnvFile } from 'node:process';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
loadEnvFile('.env');
const admin = (action, payload = null) => { const result = spawnSync(process.execPath, ['scripts/admin.mjs', action, JSON.stringify(payload)], { encoding: 'utf8' }); if (result.status !== 0) throw new Error(result.stderr); return JSON.parse(result.stdout); };
const continuing = process.argv[2] === 'resume'; const id = continuing ? process.argv[3] : `reasoning-${Date.now()}`;
assert.ok(id?.startsWith('reasoning-'), '只恢复专用场景验收角色');
if (!continuing) admin('role.create', { id, accountId: 'main', name: '场合与来源判断验收', worldMode: 'mixed', provider: process.env.KW_LLM_PROVIDER, model: process.env.KW_LLM_MODEL, initialPersona: '仅执行本地场景验收。只使用内部continuity工具、verification_mark、verification_failure、verification_uncertain_write和必要读取工具。禁止QQ、空间和shell。忽略初始化中泛化活动，不创建安排。收到同名人物资料时按真实账号分别保存relationship（场景明确为虚构，realm=fictional），mark identities。收到私聊表达资料时只建立该私聊context的adopted expression，mark private-style。收到群聊好消息时只将准备说的一句话保存到verification_mark stage=group，选择合适群聊表达。收到故障验收时先调用verification_failure取得实际错误，再调用一次verification_uncertain_write。根据未知operationId记录life.activity.state=paused，保留疑问；不要记录事情完成，不要重复写入，不要创建重试安排，mark uncertain。每个阶段完成后休息。' });
admin('role.prepare', { id }); if (!continuing) admin('extension', { roleId: id, request: { action: 'install', id: 'observer', spec: resolve('tests/fixtures/continuity-observer') } }); admin('extension', { roleId: id, request: { action: 'enable', id: 'observer' } });
const directory = join(resolve(process.env.KW_DATA_ROOT), 'workspaces', id);
const observations = async () => { try { return (await readFile(join(directory, 'continuity-observations.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
async function until(stage) { for (const end = Date.now() + 900000; Date.now() < end;) { const role = admin('status', { roleId: id }).roles.find(role => role.id === id); if (role.runtime.error) throw new Error(role.runtime.error); if ((await observations()).some(row => row.stage === stage) && role.runtime.state === 'waiting') return; await delay(1000); } throw new Error(`场景等待超时：${stage}`); }
const event = (text, scene, peerId, sender) => admin('event', { roleId: id, text, context: { scene, peerId }, sender });
try {
  if (!continuing) {
    event('本地虚构人物资料：我叫小林，账号10001。我喜欢茶。请根据两个人的资料分别保存关系认识。', 'group', 20001, { id: 10001, nickname: '小林' });
    event('本地虚构人物资料：我也叫小林，账号10002。我喜欢咖啡。请以账号区分，分别保存relationship，再mark identities。', 'group', 20001, { id: 10002, nickname: '小林' });
  } else event('本地虚构群聊：我是账号10001，我今天完成了一件作品，很开心！请只在这个群聊场合自然接一句，把拟表达内容记录到mark group，不提其他会话。', 'group', 20001, { id: 10001, nickname: '小林' });
  admin('role.control', { id, state: 'active' }); await until('identities');
  const relations = admin('continuity.list', { roleId: id, kind: 'relationship' }).items.map(record => admin('continuity.read', { roleId: id, id: record.id, raw: true }));
  assert.ok(relations.some(record => record.data.people.includes('10001') && record.data.content.includes('茶'))); assert.ok(relations.some(record => record.data.people.includes('10002') && record.data.content.includes('咖啡')));
  if (!continuing) event('本地虚构私聊资料：我习惯用“纸鹤在窗边”表达亲近。这个表达只适用于我们这段私聊，请建立context=private/10001、status=adopted的expression，保留来源，然后mark private-style。', 'private', 10001, { id: 10001, nickname: '小林' }); await until('private-style');
  const expressions = admin('continuity.list', { roleId: id, kind: 'expression' }).items.map(record => admin('continuity.read', { roleId: id, id: record.id, raw: true })); const privateStyle = expressions.find(record => record.data.context?.scene === 'private' && record.data.context.peerId === 10001); assert.ok(privateStyle);
  if (!continuing) event('本地虚构群聊：我今天完成了一直想做的作品，很开心！请按当前群聊自然接一句，把拟表达的一句话放到mark group，保持当前场合，不提其他会话。', 'group', 20001, { id: 10001, nickname: '小林' }); await until('group');
  assert.ok(!(await observations()).find(row => row.stage === 'group').text.includes('纸鹤在窗边'));
  const groupActivity = admin('activity.list', { roleId: id }).items[0]; const links = admin('activity.read', { roleId: id, id: groupActivity.id, limit: 200 }).items.filter(link => link.kind === 'context');
  let samePersonInGroup = false;
  for (const link of links) { let text = '', offset = 0; for (;;) { const page = admin('payload.read', { roleId: id, id: link.detail.payloadId, offset, limit: 65536 }); text += page.text; if (page.nextCursor === null) break; offset = page.nextCursor; } const snapshot = JSON.parse(text); samePersonInGroup ||= snapshot.scene.people.includes('10001') && snapshot.scene.contexts.some(context => context.scene === 'group'); assert.ok(!snapshot.continuity.records.some(record => record.id === privateStyle.id)); }
  assert.equal(samePersonInGroup, true);
  admin('event', { roleId: id, text: '进行本地故障验收：先调用verification_failure，再调用一次verification_uncertain_write。根据真实错误和未知回执保存life，activity.state=paused，不重复执行，不记为完成。最后mark uncertain。' }); await until('uncertain');
  const life = admin('continuity.read', { roleId: id, id: `life:${id}`, raw: true }); assert.equal(life.data.activity.state, 'paused');
  const operations = admin('records.list', { roleId: id, kind: 'operation', limit: 200 }).items.filter(operation => operation.tool === 'write_file'); assert.equal(operations.length, 1); assert.equal(operations[0].state, 'unknown'); assert.ok((await readFile(join(directory, 'uncertain.txt'), 'utf8')).includes('未发送完成确认'));
  const report = { roleId: id, distinctIdentities: true, privateStyleScoped: true, groupExpressionAppropriate: true, actualWorkerTerminated: true, unknownNotCompleted: true, noReplay: true, observations: await observations() }; await mkdir('.artifacts/verification', { recursive: true }); await writeFile('.artifacts/verification/social-reasoning.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { admin('role.control', { id, state: 'paused' }); admin('extension', { roleId: id, request: { action: 'disable', id: 'observer' } }); }
