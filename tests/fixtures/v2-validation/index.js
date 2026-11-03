import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate';
import { PtcExecutor } from '@deepseek-ai/dsh-tool-executor-ptc';
import { setTimeout as delay } from 'node:timers/promises';
import { invocationId } from '@kwagent/core';

export const name = 'kwagent-v2-validation';
export const inject = ['kwLife', 'kwMind', 'tools', 'sessionQuery', 'systemPrompt', 'ptcRuntime'];
export async function apply(ctx) {
  const life = ctx.kwLife;
  const extension = life.store.extensions().find(item => item.enabled && item.packageName === 'kwagent-v2-validation');
  assert.ok(extension); const roleId = extension.roleId; const agent = life.handles.get(roleId)?.agent; assert.ok(agent);
  ctx.tools.guard(exec => exec.name.startsWith('mcp__lagrange__') ? '验收禁止 QQ 与空间操作' : undefined);
  ctx.tools.setExecutor(new PtcExecutor(ctx));
  const cancellation = new AbortController(); let cancelBodyEntered = false;
  const generated = { document: '真实工具生成的长内容。包含中文和 Unicode 🙂。'.repeat(5000), attachments: [{ base64: 'A'.repeat(100000) }] };
  ctx.tools.register({ name: 'verification_payload', description: '生成实际长文档，检查完整负载及模型预览。', parameters: { type: 'object', additionalProperties: false }, output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: async () => generated });
  ctx.tools.register({ name: 'verification_failure', description: '实际触发无效 URL 解析错误。', parameters: { type: 'object', additionalProperties: false }, output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: async () => { return new URL('invalid-url'); } });
  ctx.tools.register({ name: 'verification_cancel', description: '取消已经进入执行的本地等待。', parameters: { type: 'object', additionalProperties: false }, output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: async (_args, exec) => { cancelBodyEntered = true; cancellation.abort(); await delay(5000, undefined, { signal: exec.signal }); return { completed: true }; } });
  ctx.tools.register({ name: 'verification_write_file', description: '实际保存文件并记录操作回执。', parameters: { type: 'object', additionalProperties: false }, output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: async (_args, exec) => {
    const operation = life.store.startOperation(life.store.role(roleId).accountId, roleId, 'verification_write_file', {}, { callId: exec.callId, rootCallId: exec.rootCallId, executionId: invocationId(exec.token) });
    const path = join(process.env.KW_DATA_ROOT, 'workspaces', roleId, 'operation-output.txt'); await writeFile(path, '实际文件操作回执'); life.store.finishOperation(operation.id, 'succeeded', { path }); return { operationId: operation.id, path };
  } });
  const execute = async code => ctx.tools.execute({ agent, signal: AbortSignal.timeout(30000), calls: [{ type: 'tool-call', id: `validation-${randomUUID()}`, name: 'run_code', arguments: JSON.stringify({ code, description: '验证实际工具执行与负载' }) }] });
  let started = false;
  ctx.on('agent/pre-step', async () => {
    if (started) return { kind: 'reject' };
    started = true;
    const directory = join(process.env.KW_DATA_ROOT, 'workspaces', roleId);
    await mkdir(directory, { recursive: true });
    try {
  const large = await execute('return await tools.verification_payload({})');
  const result = large.results[0].result; assert.equal(result.isError, false); assert.ok(JSON.stringify(result.value).length > 100000);
  assert.ok(estimateContent(result.content) <= life.config.budgets.tool + 32);
  assert.ok(!JSON.stringify(result.content).includes('A'.repeat(1000)));
  const refs = life.store.db.prepare("SELECT id FROM payloads WHERE role_id=? AND source LIKE 'tool:%'").all(roleId); assert.ok(refs.length);
  let text = ''; let cursor = 0; const selected = refs[0].id;
  for (;;) { const page = await ctx.kwMind.payloads.read(roleId, { id: selected, offset: cursor, limit: 65536 }); text += page.text; if (page.nextCursor === null) break; cursor = page.nextCursor; }
  assert.ok(JSON.parse(text)); assert.ok(text.includes(generated.document)); assert.ok(text.includes('A'.repeat(100000)));
  const first = await execute('return await tools.verification_payload({})'); const second = await execute('return await tools.verification_payload({})'); const fourth = await execute('return await tools.verification_payload({})');
  assert.equal(first.additionalContexts.filter(item => String(item.id).startsWith('no-progress')).length, 0);
  assert.ok(second.additionalContexts.some(item => String(item.id).startsWith('no-progress')));
  assert.equal(fourth.additionalContexts.filter(item => String(item.id).startsWith('no-progress')).length, 0);
  const failed = await execute('return await tools.verification_failure({})'); assert.equal(failed.results[0].result.isError, true);
  const failedSource = life.store.events(roleId, 100).find(event => event.type === 'tool-result' && event.payload.name === 'verification_failure'); assert.ok(failedSource); assert.match(JSON.stringify(failedSource.payload), /Invalid URL/);
  const cancelled = await ctx.tools.execute({ agent, signal: cancellation.signal, calls: [{ type: 'tool-call', id: `cancel-${randomUUID()}`, name: 'run_code', arguments: JSON.stringify({ code: 'return await tools.verification_cancel({})', description: '验证实际取消' }) }] });
  assert.equal(cancelBodyEntered, true); assert.equal(cancelled.results[0].result.isError, true); assert.match(cancelled.results[0].result.error.info.code, /ABORTED/);
  const written = await execute('return await tools.verification_write_file({})'); assert.equal(written.results[0].result.isError, false);
  const operation = life.store.operations(roleId).find(item => item.tool === 'verification_write_file'); assert.ok(operation?.executionId);
  assert.ok(life.store.links(life.activities.current(roleId).id, 200).some(link => link.kind === 'receipt' && link.id === operation.id));
  const source = life.manual(roleId, '本地人格修订依据：记录长文档工具的实际执行。');
  const role = life.store.role(roleId); const frozen = ctx.kwMind.freeze(roleId, '{"memories":[]}');
  const revised = ctx.kwMind.selfRevise(roleId, { expectedRevision: role.revision, patch: { selfState: '已观察实际工具结果', expressionExamples: ['我想继续看看这份记录。'] }, reason: '读取本地执行依据', sources: [source.id] });
  assert.equal(revised.revision, role.revision + 1); assert.equal(ctx.kwMind.steps.get(roleId), frozen);
  assert.throws(() => ctx.kwMind.selfRevise(roleId, { expectedRevision: role.revision, patch: { selfState: '过期修订' }, reason: '验证冲突', sources: [source.id] }), /已经更新/);
  assert.throws(() => ctx.kwMind.selfRevise(roleId, { expectedRevision: revised.revision, patch: { selfState: '错误来源' }, reason: '验证来源', sources: ['missing'] }), /来源/);
  assert.notEqual(ctx.kwMind.freeze(roleId, '{"memories":[]}'), frozen);
  const plan = await life.plans.mutate(roleId, { action: 'create', kind: 'goal', title: '本地情境记录', instruction: '仅保存情境，不发送消息。', context: { scene: 'private', peerId: 1136772134 }, sources: [source.id] }); assert.equal(plan.context.peerId, 1136772134); assert.deepEqual(plan.sources, [source.id]);
  for (let index = 0; index < 55; index++) life.manual(roleId, `本地分页记录 ${index}`);
  const firstPage = await life.operations.invoke('events', { roleId, limit: 50 }); assert.equal(firstPage.items.length, 50); assert.ok(firstPage.nextCursor);
  const secondPage = await life.operations.invoke('events', { roleId, limit: 50, before: firstPage.nextCursor }); assert.ok(secondPage.items.length); assert.ok(!secondPage.items.some(item => firstPage.items.some(previous => previous.id === item.id)));
  await assert.rejects(life.operations.invoke('events', { roleId, limit: 201 }));
  const snapshot = life.snapshot(roleId); assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= life.config.budgets.snapshotBytes);
  assert.ok(life.store.events(roleId).some(event => event.type === 'tool-result' && event.payload.rootCallId));
  const identities = life.store.events(roleId).filter(event => event.type === 'tool-result').map(event => event.payload.executionId); assert.ok(identities.every(id => typeof id === 'string')); assert.equal(new Set(identities).size, identities.length);
  await life.context.sessions.flush(agent.session);
  const resultDocument = { toolProjection: true, fullPayload: true, noProgressOnce: true, failurePreserved: true, cancellationPreserved: true, invocationCorrelation: true, personaConflict: true, frozenStep: true, paginatedSources: true, planContextPreserved: true, snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot)), payloads: refs.length, payloadId: selected };
    await writeFile(join(directory, 'v2-validation.json'), JSON.stringify(resultDocument));
    } catch (error) { await writeFile(join(directory, 'v2-validation.json'), JSON.stringify({ error: error.message })); throw error; }
    return { kind: 'reject' };
  });
}
