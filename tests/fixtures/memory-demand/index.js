import { createHash } from 'node:crypto';
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';

export const name = 'kwagent-memory-demand-verification';
export const inject = ['kwLife', 'webServer', 'tools', 'llm'];
export function apply(ctx) {
  if (process.env.KW_MEMORY_DEMAND_TEST !== 'true' || new URL(process.env.KW_PUBLIC_URL).hostname !== '127.0.0.1') throw new Error('记忆验收只允许隔离本机实例');
  const life = ctx.kwLife, mind = life.context.kwMind, id = 'memory-demand';
  const requests = [], calls = [];
  ctx.tools.guard(exec => /mcp__lagrange__/.test(exec.name) ? '记忆验收禁止QQ和空间工具' : undefined);
  ctx.on('tools/result', (exec, result) => { calls.push({ name: exec.name, isError: result.isError, id: exec.arguments?.id ?? null }); });
  ctx.on('llm/stream', async function* (options, next) {
    if (options.sessionId !== life.store.role(id).sessionId) { yield* next(); return; }
    const main = isAgentLoopRequest(options);
    const record = { at: Date.now(), provider: options.provider, model: options.model, category: main ? 'main' : options.purpose ?? 'auxiliary',
      inputBytes: Buffer.byteLength(JSON.stringify({ system: options.system, messages: options.messages, tools: options.tools })),
      systemHash: createHash('sha256').update(options.system ?? '').digest('hex'),
      contextBytes: options.messages.filter(message => message.source?.kind === 'kw-step-context').map(message => Buffer.byteLength(JSON.stringify(message.content))) };
    requests.push(record);
    for await (const chunk of next()) { if (chunk.type === 'usage') record.usage = chunk.usage; yield chunk; }
  });
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/kw-memory-demand-test', handler: async (request, response) => {
    const send = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
    try {
      if (request.method === 'GET') {
        const role = life.store.role(id), agent = life.handles.get(id)?.agent;
        const session = await life.context.sessionQuery.readSession(SessionId(role.sessionId));
        const answers = session.events.filter(event => event.type === 'assistant/message').map(event => event.data.message?.content?.filter(block => block.type === 'text').map(block => block.text).join('') ?? '').filter(Boolean);
        const operations = life.store.operations(id, 200).filter(item => /^memory_/.test(item.tool));
        return send({ requests, calls, answers, sessionId: role.sessionId, runtime: life.runtime.get(id), agentStatus: agent?.status,
          operations: await Promise.all(operations.map(async item => ({ id: item.id, tool: item.tool, state: item.state, batchId: item.arguments?.batchId, mode: item.arguments?.mode, result: item.result?.payloadId ? await mind.payloads.value(id, item.result.payloadId) : item.result }))) });
      }
      const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString('utf8'));
      if (body.action === 'execute') {
        const agent = (await life.ensure(id)).agent;
        const before = life.store.role(id);
        life.store.updateRole(id, { state: 'active' }, before.revision, 'owner', '隔离工具管道验收');
        try {
          return send(await ctx.tools.execute({ agent, signal: AbortSignal.timeout(30000), calls: [{ type: 'tool-call', id: `memory-test-${Date.now()}`, name: 'run_code', arguments: JSON.stringify({ code: body.code, description: '隔离实际查询工具验收' }) }] }));
        } finally { const current = life.store.role(id); life.store.updateRole(id, { state: before.state }, current.revision, 'owner', '结束隔离工具管道验收'); }
      }
      if (body.action === 'seed') {
        const source = life.store.appendEvent({ accountId: 'main', roleId: id, source: 'system', type: 'character-setting', occurredAt: new Date().toISOString(), scene: 'private', peerId: 10001, senderId: 10001, messageSeq: null, self: true, payload: { text: '隔离虚构资料：纸城面试约定带蓝色桐木书签。' } }).event;
        let memory;
        life.store.transaction(() => {
          for (let index = 0; index < 400; index++) life.store.saveMemory({ roleId: id, kind: 'self', title: `旧研究资料${index}`, content: `独立虚构档案${index}。`.repeat(40), realm: 'fictional', epistemic: 'fictional', people: [], aliases: [], sources: [source.id], archived: false, attention: 1 }, null, 'owner', '隔离验收资料');
          memory = life.store.saveMemory({ roleId: id, kind: 'promise', title: '纸城面试约定', content: '对方约定参加纸城面试时带蓝色桐木书签，之后核对准备情况。', realm: 'fictional', epistemic: 'fictional', people: ['10001'], aliases: ['书签'], sources: [source.id], archived: false, attention: 1 }, null, 'owner', '隔离验收资料');
          life.store.markConsolidated([source.id]);
        });
        return send({ memoryId: memory.id, sourceId: source.id, memoryCount: 401 });
      }
      response.statusCode = 400; send({ error: '未知验收动作' });
    } catch (error) { response.statusCode = 500; send({ error: error.message }); }
  } }), 'memory-demand-verification.route');
}
