import type { Context } from '@deepseek-ai/cordis';
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent';
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline';
import { createUserMessage, type ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm';
import type { ToolBatchResult, ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools';
import { approveEscalation, validateEscalationArgs } from '@deepseek-ai/dsh-sandbox';
import type {} from '@deepseek-ai/dsh-sandbox-policy';
import { appendPluginRecord } from '@deepseek-ai/dsh-session';
import { asJson, type Json } from '@kwagent/core';

declare module '@deepseek-ai/dsh-session' { interface PluginRecordMap { 'plugin:kwagent/async-dispatch': Json } }
declare module '@deepseek-ai/dsh-llm/message' { interface MessageSourceMap { 'kw-async-media': { kind: 'kw-async-media'; taskId: string } } }

/** 使用公开 PTC runtime 和工具流水线，后台记录允许跨越模型 turn。 */
export async function runProgram(ctx: Context, agent: Agent, selection: ModelSelection, taskId: string, callId: string, rootCallId: string, parent: ToolExecutionToken, args: { code: string; timeoutMs?: number; sandbox_permissions?: string; justification?: string }, signal: AbortSignal): Promise<ToolBatchResult> {
  const admitted = await ctx.tools.resolve({ agent, modelSelection: selection, signal });
  const pipeline = new ToolExecutionPipeline(ctx);
  const controller = new AbortController(), runSignal = AbortSignal.any([signal, controller.signal]);
  const contexts: UserMessage[] = [];
  let releasePolicy = () => {};
  let tail = Promise.resolve(), ordinal = 0, concluded = false;
  const record = async (data: Json) => {
    const view = await ctx.kwLife.context.kwMind.payloads.view(ctx.kwLife.store.meta(`session-owner:${agent.session.id}`)!, `task:${taskId}`, data, ctx.kwLife.config.budgets.tool);
    appendPluginRecord(agent.session, 'plugin:kwagent/async-dispatch', asJson({ taskId, view }));
  };
  const dispatch = (name: string, arguments_: unknown) => {
    const subCallId = `${callId}:ptc:${++ordinal}` as ToolCallId;
    const operation = tail.then(async () => {
      runSignal.throwIfAborted();
      await record(asJson({ taskId, phase: 'start', callId: subCallId, rootCallId, name, arguments: arguments_ }));
      const prepared = await pipeline.prepare({ name, arguments: arguments_, callId: subCallId, rootCallId: rootCallId as ToolCallId, parent, agent, toolSet: admitted, signal: runSignal });
      const outcome = prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared;
      const result = await pipeline.complete(prepared.exec, outcome);
      await record(asJson({ taskId, phase: 'result', callId: subCallId, name, isError: result.isError, content: result.content }));
      contexts.push(...result.additionalContexts ?? []);
      if (!result.isError && result.content.some(block => block.type === 'image')) contexts.push(createUserMessage({ content: result.content, source: { kind: 'kw-async-media', taskId } }));
      concluded ||= !result.isError && result.concludesTurn === true;
      if (result.isError) throw new Error(result.error.message);
      return result.value;
    });
    tail = operation.then(() => {}, () => {});
    return operation;
  };
  try {
    const runtime = ctx.ptcRuntime;
    if (runtime.retainsState || runtime.programFormat !== 'function-body') throw new Error('异步程序要求 per-call function-body PTC runtime');
    validateEscalationArgs(args.sandbox_permissions, args.justification);
    let policy = ctx.sandboxPolicy.resolve({ session: agent.session });
    const standingMode = policy.mode;
    releasePolicy = ctx.on('session/event', (session, event) => { if (session.id === agent.session.id && event.type === 'sandbox/mode' && event.data.mode !== standingMode) controller.abort(new Error('sandbox mode changed')); });
    if (args.sandbox_permissions && args.justification) policy = { ...policy, mode: await approveEscalation({ requestedMode: args.sandbox_permissions, justification: args.justification, effectiveMode: policy.mode, subject: 'program' }, { approver: ctx.get('approval'), agent, callId, toolName: 'run_code', signal: runSignal }) };
    const cwd = await ctx.workingDirectory.ensure(agent, runSignal);
    const functions = Object.fromEntries(ctx.tools.schemas(agent, admitted).map(schema => [schema.name, (args: unknown) => dispatch(schema.name, args)]));
    const result = await runtime.run(runtime.resolve({ program: args.code, bindings: [{ global: 'tools', functions, errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' } }], cwd, sandboxPolicy: policy, signal: runSignal, ...args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs } }));
    controller.abort(new Error('后台程序已结束')); await tail;
    const value = asJson({ logs: result.logs, ...result.value === undefined ? {} : { result: result.value }, ...result.sandbox === undefined ? {} : { sandbox: result.sandbox } });
    const failure = result.error ? `code run failed (${result.error.kind}): ${result.error.message}${result.logs.length ? `\nCaptured output:\n${result.logs.join('\n')}` : ''}${result.sandbox ? `\nFile sandbox: ${result.sandbox.mode}${result.sandbox.denied ? '; operation denied' : ''}.` : ''}` : null;
    const output: ToolExecutionResult = result.error ? { isError: true, error: { message: failure!, info: { name: result.error.kind === 'abort' ? 'AbortError' : 'CodeRunFailedError', code: result.error.kind === 'abort' ? 'ABORTED' : 'CODE_RUN_FAILED' } }, content: [{ type: 'text', text: failure! }] } : { isError: false, value, content: [{ type: 'text', text: [result.logs.join('\n'), typeof result.value === 'string' ? result.value : result.value === undefined ? '' : JSON.stringify(result.value, null, 2)].filter(Boolean).join('\n') || '(run_code completed with no output)' }] };
    return { results: [{ callId: callId as ToolCallId, result: output }], additionalContexts: contexts, concluded };
  } finally { releasePolicy(); controller.abort(); await tail; admitted.dispose(); }
}
