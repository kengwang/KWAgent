import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';

export const name = 'kwagent-resilience-boundaries';
export const inject = ['kwLife', 'webServer', 'tools', 'llm'];
export async function apply(ctx) {
  if (process.env.KW_BOUNDARY_TEST !== 'true' || !/^(127\.0\.0\.1|localhost)$/.test(new URL(process.env.KW_PUBLIC_URL).hostname)) throw new Error('边界验收仅允许隔离的本机实例');
  const life = ctx.kwLife, id = 'boundary-flow', probeId = 'boundary-probe';
  const markers = new Map(), captured = [];
  let sequence = 1000000;
  const directory = join(process.env.KW_DATA_ROOT, 'workspaces', probeId);
  await mkdir(directory, { recursive: true });
  ctx.tools.guard(exec => exec.name.startsWith('mcp__lagrange__') ? '边界验收禁止QQ和空间调用' : undefined);
  ctx.on('llm/stream', async function* (options, next) {
    const role = life.store.roles().find(role => role.sessionId === options.sessionId);
    if (role?.id === id && isAgentLoopRequest(options)) {
      const frozen = JSON.parse(life.context.kwMind.steps.get(id));
      const inputs = frozen.scene.eventIds.map(eventId => life.store.event(eventId));
      const serialized = JSON.stringify({ system: options.system, messages: options.messages });
      const pending = life.store.events(id, 200).filter(event => event.senderId === 10002 && !inputs.some(input => input.id === event.id) && !['completed', 'accepted'].includes(life.store.deliveryStatus(event.id).state));
      const visible = pending.filter(event => markers.has(event.id) && serialized.includes(markers.get(event.id)));
      const record = { trusted: frozen.authorization.trusted, adminInputs: inputs.filter(event => event.senderId === 10001).length, ordinaryInputs: inputs.filter(event => event.senderId === 10002).length, pendingVisible: visible.length, identityVisible: serialized.includes('当前角色实际使用的QQ账号'), runCodeExposed: options.tools?.some(tool => tool.name === 'run_code') ?? false };
      captured.push(record);
      assert.equal(record.identityVisible, true, '实际请求缺少已确认的登录账号身份');
      assert.ok(!(record.adminInputs && record.ordinaryInputs), '不同权限的输入进入同一实际请求');
      if (record.trusted) assert.equal(record.pendingVisible, 0, '尚未接纳的普通请求进入了管理员实际上下文');
      else assert.equal(record.runCodeExposed, false, '普通请求暴露了代码执行入口');
    }
    yield* next();
  });
  const probeAgent = exec => { assert.equal(exec.agent?.session.id, life.store.role(probeId).sessionId); };
  ctx.tools.register({ name: 'verification_boundary_write', description: '在隔离验收目录真实写入权限结果。', parameters: { type: 'object', properties: { name: { type: 'string', enum: ['allowed', 'forbidden'] } }, required: ['name'], additionalProperties: false }, output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: async (args, exec) => { probeAgent(exec); await writeFile(join(directory, `${args.name}.txt`), '实际工具执行'); return { written: true }; } });
  ctx.tools.register({ name: 'verification_boundary_revoke', description: '撤销隔离角色的管理员QQ配置。', parameters: { type: 'object', additionalProperties: false }, output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: async (_args, exec) => { probeAgent(exec); const role = life.store.role(probeId); life.store.updateRole(probeId, { adminQQs: [] }, role.revision, 'owner', '真实撤权验收'); return { revoked: true }; } });
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/kw-boundary-test', handler: async (request, response) => {
    const send = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
    try {
      if (request.method === 'GET') {
        const role = life.store.role(id), agent = life.handles.get(id)?.agent;
        const session = await life.context.sessionQuery.readSession(SessionId(role.sessionId));
        const answers = session.events.filter(event => event.type === 'assistant/message' && !event.data.interrupted).map(event => event.data.message?.content?.filter(block => block.type === 'text').map(block => block.text).join('') ?? '').filter(Boolean);
        return send({ captured, runtime: life.runtime.get(id), agentStatus: agent?.status, answers, deliveries: [...markers].map(([eventId, marker]) => ({ id: eventId, marker, state: life.store.deliveryStatus(eventId).state })) });
      }
      if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
      const bytes = Buffer.concat(await Array.fromAsync(request)); if (bytes.length > 8192) throw new Error('验收请求超出范围');
      const body = JSON.parse(bytes.toString('utf8'));
      if (body.action === 'deliver') {
        const emitted = [];
        for (const item of body.items) {
          const sender = item.admin ? 10001 : 10002;
          const packet = { message_scene: 'group', peer_id: 20001, message_seq: sequence++, sender_id: sender, time: Math.floor(Date.now() / 1000), segments: [{ type: 'text', data: { text: `${item.marker} ${item.text}` } }] };
          life.context.kwLagrange.events.acceptMessage(packet);
          const event = life.store.events(id, 100).find(event => event.senderId === sender && event.messageSeq === packet.message_seq);
          assert.ok(event); markers.set(event.id, item.marker); emitted.push(event.id);
        }
        return send({ ids: emitted });
      }
      if (body.action === 'tools') {
        const role = life.store.role(probeId), agent = (await life.ensure(probeId)).agent;
        life.store.updateRole(probeId, { state: 'active' }, role.revision, 'owner', '隔离工具执行验收');
        const event = senderId => life.store.appendEvent({ accountId: 'main', roleId: probeId, source: 'milky', type: 'message_receive', occurredAt: new Date().toISOString(), scene: 'private', peerId: senderId, senderId, messageSeq: null, self: false, payload: { text: '隔离来源验证' } }).event;
        const admin = event(10001), ordinary = event(10002);
        const execute = (name, args) => ctx.tools.execute({ agent, signal: AbortSignal.timeout(30000), calls: [{ type: 'tool-call', id: `boundary-${randomUUID()}`, name, arguments: JSON.stringify(args) }] });
        try {
          life.policy.prepare(probeId, 1, [admin, ordinary], [], true);
          assert.ok((await execute('verification_boundary_write', { name: 'forbidden' })).results[0].result.isError);
          assert.ok((await execute('run_code', { code: 'return await tools.verification_boundary_write({name:"forbidden"})', description: '混合来源禁止提权' })).results[0].result.isError);
          await assert.rejects(stat(join(directory, 'forbidden.txt')), error => error.code === 'ENOENT');
          life.policy.prepare(probeId, 2, [admin], [], true);
          assert.equal((await execute('run_code', { code: 'return await tools.verification_boundary_write({name:"allowed"})', description: '真实管理员请求写入' })).results[0].result.isError, false);
          assert.equal(await readFile(join(directory, 'allowed.txt'), 'utf8'), '实际工具执行');
          const plan = await life.plans.mutate(probeId, { action: 'create', kind: 'goal', title: '授权目标', instruction: '仅继续本地授权验收' }, life.policy.current(probeId));
          life.policy.prepare(probeId, 3, [ordinary], [plan.id], true); assert.equal(life.policy.trusted(probeId), false);
          life.policy.prepare(probeId, 4, [], [plan.id], true); assert.equal(life.policy.trusted(probeId), true);
          const updated = await life.plans.mutate(probeId, { action: 'update', id: plan.id, expectedRevision: plan.revision, instruction: '普通请求修改目标' }, { owner: false, sources: [] });
          assert.equal(life.policy.trusted(probeId), false, '旧目标权限没有随实际修订撤销');
          await life.plans.mutate(probeId, { action: 'cancel', id: plan.id, expectedRevision: updated.revision });
          life.policy.prepare(probeId, 5, [admin], [], true);
          const nested = await execute('run_code', { code: 'await tools.verification_boundary_revoke({}); return await tools.verification_boundary_write({name:"forbidden"})', description: '真实撤权后拒绝嵌套写入' });
          assert.ok(JSON.stringify(nested).includes('角色管理员'));
          life.policy.prepare(probeId, 6, [ordinary], [], true);
          const memory = { kind: 'episode', title: 'BOUNDARY-corrected', content: '实际工具来源检查', realm: 'real', epistemic: 'reported', people: ['昵称不能充当账号'], aliases: [], sources: [ordinary.id], archived: false, attention: 0.5 };
          assert.ok((await execute('memory_revise', { memory, expectedRevision: null, reason: '真实错误字段' })).results[0].result.isError);
          assert.notEqual(life.runtime.get(probeId)?.state, 'error');
          assert.equal((await execute('memory_revise', { memory: { ...memory, people: ['10002'] }, expectedRevision: null, reason: '纠正实际字段' })).results[0].result.isError, false);
          assert.ok(life.store.memories(probeId).some(item => item.title === memory.title));
          return send({ mixedNativeDenied: true, mixedPtcDenied: true, adminActualWrite: true, planMutationRevoked: true, nestedActualConfigRevoked: true, evidenceCorrectable: true });
        } finally { await life.control(probeId, 'paused'); }
      }
      if (body.action === 'usage-failure') {
        const agent = (await life.ensure(probeId)).agent;
        life.store.db.exec("CREATE TEMP TRIGGER boundary_usage_failure BEFORE INSERT ON usage WHEN NEW.role_id='boundary-probe' BEGIN SELECT RAISE(ABORT,'BOUNDARY actual usage storage failure'); END");
        try {
          await assert.rejects(life.context.kwMind.consolidate(agent, probeId, AbortSignal.timeout(15000)), /BOUNDARY actual usage storage failure/);
          assert.notEqual(life.context.kwMind.consolidationStatus(probeId)?.status, 'deferred');
          assert.equal(life.runtime.get(probeId)?.state, 'error');
          assert.ok(life.store.unprocessed(probeId).length);
          return send({ actualUsageSqliteFailure: true, hardFailurePreserved: true, rawRetained: true });
        } finally { life.store.db.exec('DROP TRIGGER boundary_usage_failure'); }
      }
      if (body.action === 'memory-validation-failure') {
        const agent = (await life.ensure(probeId)).agent;
        const role = life.store.role(probeId);
        life.store.updateRole(probeId, { state: 'active' }, role.revision, 'owner', '隔离持久行校验故障');
        const path = join(directory, 'validation-source.txt');
        const source = life.store.startOperation('main', probeId, 'verification_observation', { path });
        await writeFile(path, '实际持久来源读取');
        const content = await readFile(path, 'utf8');
        life.store.finishOperation(source.id, 'succeeded', { path, content, bytes: Buffer.byteLength(content) });
        const saved = life.store.db.prepare("SELECT body FROM documents WHERE kind='operation' AND id=?").get(source.id).body;
        life.store.db.prepare("UPDATE documents SET body=json_set(body,'$.state','CORRUPTED_STATE') WHERE kind='operation' AND id=?").run(source.id);
        const faults = [];
        const dispose = ctx.on('kw-mind/error', (roleId, error) => { if (roleId === probeId) faults.push({ name: error.name, message: error.message }); });
        try {
          const result = await ctx.tools.execute({ agent, signal: AbortSignal.timeout(30000), calls: [{ type: 'tool-call', id: `boundary-corrupt-${randomUUID()}`, name: 'memory_revise', arguments: JSON.stringify({ memory: { kind: 'episode', title: 'BOUNDARY-corrupt-operation', content: '实际持久来源故障', realm: 'real', epistemic: 'observed', people: [], aliases: [], sources: [source.id], archived: false, attention: 0.5 }, expectedRevision: null, reason: '真实损坏来源读取' }) }] });
          const tool = result.results[0].result;
          assert.equal(tool.isError, true);
          assert.ok(JSON.stringify(tool).includes('持久记录格式损坏或不兼容'));
          const value = { actualHarnessTool: true, actualCorruptOperationRow: true, isError: tool.isError, mindErrors: faults, runtimeState: life.runtime.get(probeId)?.state ?? null, memorySaved: life.store.memories(probeId).some(memory => memory.title === 'BOUNDARY-corrupt-operation'), noSocialSends: true };
          if (typeof body.expectFatal === 'boolean') assert.equal(value.mindErrors.length > 0 && value.runtimeState === 'error', body.expectFatal);
          return send(value);
        } finally { dispose(); life.store.db.prepare("UPDATE documents SET body=? WHERE kind='operation' AND id=?").run(saved, source.id); await life.control(probeId, 'paused'); }
      }
      response.writeHead(400); response.end('未知验收操作');
    } catch (error) { response.statusCode = 500; send({ error: error.message }); }
  } }), 'boundary-verification.route');
}
