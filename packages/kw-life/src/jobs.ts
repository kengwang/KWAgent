import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import { asJson, registerTool } from '@kwagent/core';
import type {} from './index.ts';
import { AsyncExecutor } from './async-executor.ts';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';

export const name = 'kwagent-task-controls';
export const inject = ['kwLife', 'jobs', 'tools', 'systemPrompt', 'ptcRuntime', 'sandboxPolicy', 'workingDirectory'];
export function apply(ctx: Context): void {
  const life = ctx.kwLife;
  if (ctx.ptcRuntime.retainsState) throw new Error('KWAgent 异步工具执行要求 PTC 使用 per-call 运行方式');
  ctx.tools.setExecutor(new AsyncExecutor(ctx, life.tasks));
  ctx.jobs.attachController('kwagent-task-controls');
  const role = (sessionId: string | undefined) => { const value = life.store.roles().find(role => role.sessionId === sessionId); if (!value) throw new Error('任务控制需要当前角色'); return value; };
  registerTool(ctx, 'job_list', '按用户明确要求查看当前角色的任务列表，包括持久化的结束结果。后台结束会自动通知并唤醒你，不要用此工具轮询任务进度或等待结果。', z.object({}).strict(), async (_args, exec) => life.tasks.list({ roleId: role(exec.agent?.session.id).id, cursor: 0, limit: 200 }).items.filter(task => task.mode === 'background').map(task => life.tasks.jobView(task)));
  registerTool(ctx, 'job_output', '后台完成、失败或取消后会自动通知并唤醒你，不要轮询结果。仅在收到完成通知后需要补充具体内容，或用户明确要求查看该任务时读取一次。running或stopping时结束查询并等待自动通知；即使后续依赖结果也先结束当前活动。不要通过wait=true、sleep或重复调用等待结果。空正文和查询超时都不表示失败。', z.object({ job_id: z.string(), wait: z.boolean().default(false), timeout_ms: z.number().int().positive().max(600000).default(30000) }).strict(), async (args, exec) => {
    const owner = role(exec.agent?.session.id);
    const value = await life.tasks.output(owner.id, args.job_id, args.wait, args.timeout_ms, exec.signal, life.tasks.claimCall(owner.id, String(exec.rootCallId)));
    const result = value.result as Record<string, any> | null;
    const text = Array.isArray(result?.results) ? result.results.flatMap((item: any) => item.result.content.filter((block: any) => block.type === 'text').map((block: any) => block.text)).join('\n') : [...(result?.chunks ?? []).filter((chunk: any) => chunk.channel !== 'log').map((chunk: any) => chunk.text), ...(typeof result?.result === 'string' ? [result.result] : [])].join('\n');
    const pending = ['starting', 'running', 'stopping'].includes(value.task.state);
    const instruction = pending ? '目标任务仍在执行或释放资源，空正文和查询超时不表示失败。停止查询：不要再次调用job_output/job_list，也不要sleep、wait:true、循环或安排定时查询。完成、失败或取消后系统会自动通知并唤醒你；结束当前活动不会取消任务，即使依赖结果也先结束本轮。可以继续其他独立事项，不要重复提交原操作。' : '这是目标任务的终态结果，请直接结合实际子调用和回执继续处理，不要再次查询同一结果或重复执行已经完成的操作。';
    return asJson({ text, job: life.tasks.jobView(value.task), taskId: value.task.id, resultRef: value.task.resultRef, instruction, content: await life.tasks.deferred(owner.id, value.task.id, exec.signal) });
  }, (_args, value) => {
    const body = value as unknown as { text: string; content: ContentBlock[]; job: unknown; resultRef: unknown; instruction: string };
    return [{ type: 'text', text: JSON.stringify({ text: body.text, job: body.job, resultRef: body.resultRef, instruction: body.instruction }) }, ...body.content];
  });
  registerTool(ctx, 'job_kill', '请求取消当前角色的后台任务；取消中表示仍在释放资源，结果未知的远程副作用需要核实。', z.object({ job_id: z.string(), reason: z.string().optional() }).strict(), async (args, exec) => {
    const task = life.tasks.cancel(role(exec.agent?.session.id).id, args.job_id, args.reason ?? '角色请求取消任务');
    return { outcome: ['starting', 'running', 'stopping'].includes(task.state) ? 'cancellation-requested' : 'already-finished', job: life.tasks.jobView(task) };
  });
}
