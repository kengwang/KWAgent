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
  registerTool(ctx, 'job_list', '查询当前角色的后台任务，包括持久化的结束结果。保存jobId，结果会主动送达。', z.object({}).strict(), async (_args, exec) => life.tasks.list({ roleId: role(exec.agent?.session.id).id, cursor: 0, limit: 200 }).items.filter(task => task.mode === 'background').map(task => life.tasks.jobView(task)));
  registerTool(ctx, 'job_output', '读取后台任务，结果长期保存。默认不等待，wait=true只用于确实依赖结果时；正常交流无需等待所有任务完成。', z.object({ job_id: z.string(), wait: z.boolean().default(false), timeout_ms: z.number().int().positive().max(600000).default(30000) }).strict(), async (args, exec) => {
    const owner = role(exec.agent?.session.id);
    const value = await life.tasks.output(owner.id, args.job_id, args.wait, args.timeout_ms, exec.signal, life.tasks.claimCall(owner.id, String(exec.rootCallId)));
    const result = value.result as Record<string, any> | null;
    const text = Array.isArray(result?.results) ? result.results.flatMap((item: any) => item.result.content.filter((block: any) => block.type === 'text').map((block: any) => block.text)).join('\n') : [...(result?.chunks ?? []).filter((chunk: any) => chunk.channel !== 'log').map((chunk: any) => chunk.text), ...(typeof result?.result === 'string' ? [result.result] : [])].join('\n');
    return asJson({ text, job: life.tasks.jobView(value.task), taskId: value.task.id, resultRef: value.task.resultRef, content: await life.tasks.deferred(owner.id, value.task.id, exec.signal) });
  }, (_args, value) => {
    const body = value as unknown as { text: string; content: ContentBlock[]; job: unknown; resultRef: unknown };
    return [{ type: 'text', text: JSON.stringify({ text: body.text, job: body.job, resultRef: body.resultRef }) }, ...body.content];
  });
  registerTool(ctx, 'job_kill', '请求取消当前角色的后台任务；取消中表示仍在释放资源，结果未知的远程副作用需要核实。', z.object({ job_id: z.string(), reason: z.string().optional() }).strict(), async (args, exec) => {
    const task = life.tasks.cancel(role(exec.agent?.session.id).id, args.job_id, args.reason ?? '角色请求取消任务');
    return { outcome: ['starting', 'running', 'stopping'].includes(task.state) ? 'cancellation-requested' : 'already-finished', job: life.tasks.jobView(task) };
  });
}
