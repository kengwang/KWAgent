import { randomUUID } from 'node:crypto';
import { mkdir, readFile, appendFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import { executionOrigin } from '@kwagent/core';

export const name = 'kwagent-async-verification';
export const inject = ['kwLife', 'webServer', 'tools', 'llm', 'jobs'];
export function apply(ctx) {
  if (process.env.KW_ASYNC_TEST !== 'true' || !/^(127\.0\.0\.1|localhost)$/.test(new URL(process.env.KW_PUBLIC_URL).hostname)) throw new Error('异步验收只允许隔离的本机实例');
  const life = ctx.kwLife, id = 'async-probe', directory = join(process.env.KW_DATA_ROOT, 'workspaces', id);
  const requests = [], turnEnds = [], readQueues = [];
  ctx.on('session/event', (session, event) => { if (session.id === life.store.role(id).sessionId && event.type === 'turn/end') turnEnds.push(event.data); });
  ctx.on('tools/pre-execute', (exec, next) => { if (exec.name === 'job_output') readQueues.push({ at: Date.now(), arguments: exec.arguments, queued: exec.agent.inbox.nextStep.some(message => message.source.kind === 'kw-event' && message.source.eventIds.some(id => life.store.event(id).type === 'background-result')) }); return next(); });
  ctx.on('llm/stream', async function* (options, next) {
    if (isAgentLoopRequest(options) && options.sessionId === life.store.role(id).sessionId) {
      requests.push({ at: Date.now(), provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort ?? null, origin: executionOrigin.getStore() ?? null, tools: options.tools?.map(tool => tool.name), messages: options.messages.filter(message => message.role === 'user').map(message => message.source?.kind) });
      if (process.env.KW_ASYNC_RACE_TEST === 'true' && life.tasks.list({ roleId: id, cursor: 0, limit: 200 }).items.some(task => task.mode === 'background' && task.state === 'running')) await writeFile(join(directory, 'race-release'), '真实后续模型请求已经开始');
    }
    yield* next();
  });
  ctx.tools.guard(exec => /mcp__lagrange__/.test(exec.name) ? '异步验收禁止社交工具' : undefined);
  ctx.tools.register({ name: 'verification_async_file', description: '等待指定时间后实际写入隔离文件。', parameters: { type: 'object', properties: { marker: { type: 'string' }, delay: { type: 'number' } }, required: ['marker', 'delay'] }, output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: async (args, exec) => {
    await mkdir(directory, { recursive: true });
    if (args.marker === 'race-source') for (;;) {
      const ready = await access(join(directory, 'race-release')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
      if (ready) break;
      await delay(50, undefined, { signal: exec.signal });
    }
    await delay(args.delay, undefined, { signal: exec.signal });
    await appendFile(join(directory, 'executions.txt'), `${args.marker}\n`);
    return { marker: args.marker, actualWrite: true };
  } }, { when: ({ agent }) => agent === life.handles.get(id)?.agent });
  ctx.tools.register({ name: 'verification_async_stream', description: '注册实际后台文件写入任务。', parameters: { type: 'object', properties: {} }, output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: async (_args, exec) => {
    const controller = new AbortController();
    const jobId = ctx.jobs.start({ kind: 'bash', owner: exec.agent.session.id, label: '真实原生任务写入', toolCall: { callId: exec.callId, rootCallId: exec.rootCallId }, run: job => ({ cancel: () => controller.abort(), done: delay(1500, undefined, { signal: controller.signal }).then(async () => { await appendFile(join(directory, 'executions.txt'), 'native-complete\n'); job.append('actual-native-output'); return { status: 'completed', result: 'actual-native-result' }; }, () => ({ status: 'killed' })) }) });
    return { jobId };
  } });
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/kw-async-test', handler: async (request, response) => {
    const send = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
    try {
      if (request.method === 'GET') {
        const file = join(directory, 'executions.txt');
        const executions = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
        return send({ tasks: life.tasks.list({ roleId: id, cursor: 0, limit: 200 }), executions: executions.trim().split('\n').filter(Boolean), requests, turnEnds, readQueues, agentStatus: life.handles.get(id)?.agent.status, runtime: life.runtime.get(id), events: life.store.events(id, 100).filter(event => event.type === 'background-result').map(event => ({ id: event.id, delivery: life.store.deliveryStatus(event.id), payload: event.payload })) });
      }
      const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString('utf8'));
      if (body.action === 'execute') {
        const agent = (await life.ensure(id)).agent;
        const role = life.store.role(id);
        if (role.state !== 'active') life.store.updateRole(id, { state: 'active' }, role.revision, 'owner', '隔离工具执行验收');
        const start = performance.now();
        const result = await ctx.tools.execute({ agent, signal: AbortSignal.timeout(60000), calls: [{ type: 'tool-call', id: `async-test-${randomUUID()}`, name: 'run_code', arguments: JSON.stringify({ code: body.code, description: '真实异步程序验收', ...body.background === undefined ? {} : { run_in_background: body.background } }) }] });
        return send({ elapsed: performance.now() - start, result });
      }
      if (body.action === 'pause') { await life.control(id, 'paused'); return send({ paused: true }); }
      response.statusCode = 400; send({ error: '未知验收动作' });
    } catch (error) { response.statusCode = 500; send({ error: error.message }); }
  } }), 'async-verification.route');
}
