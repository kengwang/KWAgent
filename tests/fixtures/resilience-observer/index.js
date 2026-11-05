import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm';

export const name = 'kwagent-resilience-observer';
export const inject = ['kwLife', 'webServer', 'tools', 'llm', 'skills'];
export async function apply(ctx) {
  if (process.env.KW_RESILIENCE_TEST !== 'true' || !/^(127\.0\.0\.1|localhost)$/.test(new URL(process.env.KW_PUBLIC_URL).hostname)) throw new Error('韧性验收只允许隔离的本机实例');
  const life = ctx.kwLife, id = process.env.KW_RESILIENCE_ROLE;
  const directory = join(process.env.KW_DATA_ROOT, 'workspaces', id); await mkdir(directory, { recursive: true });
  const counts = { foreground: 0, auxiliary: 0, compaction: 0, query: 0, abortedAuxiliary: 0 };
  const assembled = [];
  ctx.tools.guard(exec => exec.name.startsWith('mcp__lagrange__') ? '韧性验收禁止全部QQ与空间发送及管理调用' : undefined);
  ctx.on('llm/stream', async function* (options, next) {
    const system = [options.system ?? '', ...options.messages.filter(message => message.role === 'system').flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text))].join('\n');
    if (isAgentLoopRequest(options)) { counts.foreground++; assembled.push({ hasPersona: system.includes('始终以配置的人格和世界观'), hasHumanizer: system.includes('skill_content name="humanizer"') || system.includes('name="humanizer"'), schemas: options.tools?.map(tool => tool.name) ?? [] }); }
    else if (options.purpose === 'compaction') counts.compaction++;
    else { counts.auxiliary++; if (String(options.system).includes('将查询资料')) counts.query++; options.signal?.addEventListener('abort', () => counts.abortedAuxiliary++, { once: true }); }
    yield* next();
  });
  ctx.tools.register({ name: 'verification_mark', description: '将当前角色的简短回答保存到隔离的本地文件；不对外发送。text使用当前角色身份表达。', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: async (args, exec) => { await appendFile(join(directory, 'marks.jsonl'), `${JSON.stringify({ text: args.text, sessionId: exec.agent?.session.id, time: new Date().toISOString() })}\n`); return { recorded: true }; } });
  ctx.tools.register({ name: 'verification_write', description: '在隔离目录实际保存权限验收文件。', parameters: { type: 'object', additionalProperties: false }, output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: async () => { await writeFile(join(directory, 'authorized.txt'), '实际授权写入'); return { written: true }; } });
  ctx.tools.register({ name: 'verification_context_change', description: '更新隔离验收的来源背景。', parameters: { type: 'object', additionalProperties: false }, output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: async () => { life.policy.prepare('resilience-probe', 99, []); return { updated: true }; } });
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/kw-resilience-test', handler: async (request, response) => {
    const send = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
    if (request.method === 'GET') {
      const role = life.store.role(id), agent = life.handles.get(id)?.agent;
      const skills = agent ? await ctx.skills.get('humanizer', { scope: agent, cwd: directory }) : undefined;
      return send({ counts, assembled, providers: ctx.llm.listProviders().map(provider => provider.id), roleState: role.state, runtime: life.runtime.get(id), agentStatus: agent?.status, memoryStatus: life.context.kwMind.consolidationStatus(id), frozen: life.context.kwMind.steps.get(id) ? JSON.parse(life.context.kwMind.steps.get(id)) : null, humanizerProvider: skills?.provider, deliveries: life.store.events(id, 200).filter(event => !event.self).map(event => ({ id: event.id, status: life.store.deliveryStatus(event.id).state })) });
    }
    if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
    const bytes = Buffer.concat(await Array.fromAsync(request)); if (bytes.length > 4096) throw new Error('验收请求超过范围');
    const body = JSON.parse(bytes.toString('utf8'));
    if (body.action === 'probes') {
      const probe = life.store.role('resilience-probe'); const agent = (await life.ensure(probe.id)).agent;
      const changed = life.store.updateRole(probe.id, { state: 'active' }, probe.revision, 'owner', '隔离权限验收');
      const execute = (name, args) => ctx.tools.execute({ agent, signal: AbortSignal.timeout(30000), calls: [{ type: 'tool-call', id: `probe-${randomUUID()}`, name, arguments: JSON.stringify(args) }] });
      try {
        life.policy.prepare(probe.id, 1, []);
        const raw = await execute('run_code', { code: 'return await tools.verification_write({})', description: '普通来源工具调用验收' }); assert.equal(raw.results[0].result.isError, false);
        const owner = life.store.appendEvent({ accountId: 'main', roleId: probe.id, source: 'manual', type: 'permission-test', occurredAt: new Date().toISOString(), scene: null, peerId: null, senderId: null, messageSeq: null, self: false, payload: { text: '仅授权隔离文件写入验收' } }).event;
        life.policy.prepare(probe.id, 2, [owner]);
        const allowed = await execute('run_code', { code: 'return await tools.verification_write({})', description: '授权实际文件写入' }); assert.equal(allowed.results[0].result.isError, false);
        assert.equal(await readFile(join(directory, 'authorized.txt'), 'utf8'), '实际授权写入');
        const nested = await execute('run_code', { code: 'await tools.verification_context_change({}); return await tools.verification_write({})', description: '背景变化保持工具可用' });
        assert.equal(nested.results[0].result.isError, false); return send({ ordinaryCodeWorks: true, manualCodeWorks: true, guidanceDoesNotChangeTools: true });
      } finally { const current = life.store.role(probe.id); life.store.updateRole(probe.id, { state: 'paused' }, current.revision, 'owner', '隔离权限验收结束'); }
    }
    if (body.action === 'offline-auxiliary') {
      try {
      const role = life.store.role(id); assert.equal(role.state, 'paused');
      const agent = (await life.ensure(id)).agent;
      life.store.updateRole(id, { provider: 'kw-resilience-offline', model: 'offline-model' }, role.revision, 'owner', '实际不可连接的辅助模型验收');
      const result = await life.context.kwMind.consolidate(agent, id, AbortSignal.timeout(30000));
      assert.equal(result.status, 'deferred'); assert.ok(life.store.unprocessed(id).length);
      return send({ ...result, rawRetained: true, auxiliaryFailed: true });
      } catch (error) { response.statusCode = 500; return send({ error: error instanceof Error ? error.message : String(error), providers: ctx.llm.listProviders().map(provider => provider.id) }); }
    }
    if (body.action === 'restore-model') { const role = life.store.role(id); life.store.updateRole(id, { provider: process.env.KW_LLM_PROVIDER, model: process.env.KW_LLM_MODEL }, role.revision, 'owner', '恢复实际模型配置'); return send({ restored: true }); }
    if (body.action === 'replay') { for (const eventId of body.ids) life.receive(life.store.event(eventId)); return send({ redelivered: body.ids.length }); }
    response.writeHead(400); response.end('未知验收操作');
  } }), 'resilience.test-route');
}
