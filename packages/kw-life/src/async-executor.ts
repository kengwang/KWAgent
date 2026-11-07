import type { Context } from '@deepseek-ai/cordis';
import { PtcExecutor } from '@deepseek-ai/dsh-tool-executor-ptc';
import { ToolExecutionPipeline, executeToolBatch } from '@deepseek-ai/dsh-tools/pipeline';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import type { ToolExecutor, ToolDefinition, ToolBatchInput, ToolBatchResult, JsonSchemaNode } from '@deepseek-ai/dsh-tools';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { asJson } from '@kwagent/core';
import { z } from 'zod';
import type { Tasks } from './tasks.ts';
import { runProgram } from './program.ts';

/** 前台提交与实际 PTC 程序分别拥有执行生命周期。 */
export class AsyncExecutor implements ToolExecutor {
  readonly sections;
  private readonly ptc: PtcExecutor;
  private readonly pipeline: ToolExecutionPipeline;
  private readonly transport: ToolDefinition;
  private readonly logged = new Set<string>();
  constructor(readonly ctx: Context, readonly tasks: Tasks) {
    this.ptc = new PtcExecutor(ctx);
    this.sections = [...this.ptc.sections, { name: 'tools:kw-async', order: 10105, interpolate: false, text: `run_code支持run_in_background:true立即提交整段后台程序；普通程序等待${tasks.life.config.asyncForegroundWaitMs}毫秒后自动转入后台。后台任务完成、失败或取消后，系统会自动发送结果通知并唤醒你，结束当前回复不会取消任务。收到background句柄后不要轮询结果：不要调用job_output或job_list检查是否完成，不要通过wait:true、sleep、循环、另一个后台程序或定时计划反复检查。即使后续操作依赖该结果，也应结束当前活动，收到自动通知后再继续。可以继续独立活动或处理新消息；没有其他事项就直接结束本轮，等待系统通知。预计耗时且认为对方需要知道时，可以在启动后简短告知正在处理；是否告知完全由你结合场合判断。告知启动不代表操作完成。完成通知包含状态、结果预览和resultRef，优先直接使用；仅在收到通知后需要补充具体内容，或用户明确要求查看某项任务时，按需读取一次job_output或payload_read。job_output的job.status为running或stopping时停止查询，继续等待自动通知；空正文和查询超时都不表示失败，不要重新提交相同操作。已有子调用及程序内await继续执行，无需结束回复前收集全部任务。job_kill请求取消。` }];
    const schema = this.ptc.describe([]).schemas[0]!;
    this.transport = {
      ...schema,
      parameters: { ...schema.parameters, properties: { ...(schema.parameters.properties as Record<string, JsonSchemaNode>), run_in_background: { type: 'boolean', description: '立即将整段程序提交后台；省略时先等待配置的前台时间。' } } },
      output: { schema: {}, render: (_args, value) => {
        const body = value as unknown as { background?: unknown; logs?: string[]; result?: unknown; sandbox?: { mode: string; denied: boolean; enforcement?: string } };
        const parts = body.background ? [JSON.stringify(body.background)] : [body.logs?.join('\n'), body.result === undefined ? '' : typeof body.result === 'string' ? body.result : JSON.stringify(body.result, null, 2)].filter(Boolean);
        if (body.sandbox?.enforcement === 'partial') parts.push('File sandbox enforcement is partial on this host.');
        if (body.sandbox?.denied) parts.push(`The ${body.sandbox.mode} file sandbox denied an operation.`);
        return [{ type: 'text', text: parts.join('\n') || '(run_code completed with no output)' }];
      } },
      execute: async (raw, exec) => {
        const violations = validateJsonSchemaValue(this.transport.parameters, raw); if (violations.length) throw new Error(violations.join('; '));
        const args = z.object({ code: z.string(), description: z.string().trim().min(1), run_in_background: z.boolean().default(false) }).passthrough().parse(raw);
        if (args.timeoutMs !== undefined && (typeof args.timeoutMs !== 'number' || !Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) throw new Error('timeoutMs 必须为正数');
        if (!exec.agent) throw new Error('异步执行需要角色 Agent');
        exec.signal.throwIfAborted();
        const agent = exec.agent, selection = agent.model.current(); if (!selection) throw new Error('角色没有模型选择');
        const { run_in_background: immediate, ...program } = args;
        const task = await tasks.start(agent, String(exec.callId), args.description, asJson(program), immediate, this.logged.has(String(exec.callId)), async (id, signal, taskId) => {
          return runProgram(ctx, agent, selection, taskId, id, String(exec.rootCallId), exec.token, program, signal);
        });
        let completed: ToolBatchResult | undefined;
        try { completed = immediate ? undefined : await tasks.foreground(task, exec.signal); }
        catch (error) { tasks.promote(task.roleId, task.id); throw error; }
        if (completed) {
          const result = completed.results[0]?.result; if (!result) throw new Error('程序缺少实际执行结果');
          tasks.forget(task.id);
          if (result.isError) throw new HarnessError(result.error.message, result.error.info?.code ?? 'ASYNC_PROGRAM_FAILED');
          for (const context of completed.additionalContexts) exec.deferContext(context);
          if (completed.concluded) exec.concludeTurn();
          return result.value;
        }
        const current = tasks.promote(task.roleId, task.id);
        return { background: { taskId: task.id, jobId: task.jobId, status: current.state, meaning: '后台任务已提交。完成、失败或取消后系统会自动通知并唤醒你；结束本轮不会取消任务。不要轮询job_output/job_list，不要sleep、循环、wait:true或创建定时查询。即使依赖结果也先结束本轮，收到自动通知后再继续；有其他独立事项可以先处理。不要重复提交相同操作。', read: { when: '收到完成通知后确实需要补充内容，或用户明确要求查看此任务时，读取一次。', tool: 'job_output', arguments: { job_id: task.jobId } } } };
      },
    };
    this.pipeline = new ToolExecutionPipeline(ctx, { get: name => name === 'run_code' ? this.transport : undefined });
  }
  describe() { return { schemas: [{ name: this.transport.name, description: this.transport.description, parameters: this.transport.parameters }], knownNames: ['run_code'] }; }
  async execute(input: ToolBatchInput): Promise<ToolBatchResult> {
    if (input.log) for (const call of input.calls) this.logged.add(String(call.id));
    try { return await executeToolBatch(input, this.pipeline, () => 10); }
    finally { for (const call of input.calls) this.logged.delete(String(call.id)); }
  }
}
