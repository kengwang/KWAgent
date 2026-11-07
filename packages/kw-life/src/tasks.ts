import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { z } from 'zod';
import { JobId, type JobView, type JobOutcome } from '@deepseek-ai/dsh-jobs';
import { SessionId } from '@deepseek-ai/dsh-session';
import { asJson, now, jsonSchema, executionOrigin, type Json } from '@kwagent/core';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { ToolBatchResult } from '@deepseek-ai/dsh-tools';
import type { Life } from './index.ts';
declare module '@deepseek-ai/dsh-jobs' { interface JobKindMap { 'kw-async': 'kw-async' } }

export const taskSchema = z.object({
  id: z.string(), roleId: z.string(), sessionId: z.string(), activityId: z.string().nullable(),
  callId: z.string().nullable(), executionCallId: z.string(), jobId: z.string().nullable(), label: z.string(),
  kind: z.string(), mode: z.enum(['foreground', 'background']), state: z.enum(['starting', 'running', 'stopping', 'completed', 'failed', 'cancelled', 'interrupted']),
  parentTaskId: z.string().nullable().default(null),
  sessionReceiptRequired: z.boolean().default(false), foregroundCommitted: z.boolean().default(false),
  people: z.array(z.string()).default([]),
  createdAt: z.string(), finishedAt: z.string().nullable(), reason: z.string().nullable(),
  programRef: jsonSchema.nullable(), resultRef: jsonSchema.nullable(), preview: jsonSchema.nullable(),
  context: z.object({ scene: z.enum(['group', 'private']), peerId: z.number() }).nullable(), sources: z.array(z.string()),
});
export type AsyncTask = z.infer<typeof taskSchema>;
export const taskListSchema = z.object({ roleId: z.string(), state: taskSchema.shape.state.optional(), cursor: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(200).default(50) }).strict();
const terminal = (task: AsyncTask) => !['starting', 'running', 'stopping'].includes(task.state);
const refId = (value: Json): string => { if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.payloadId !== 'string') throw new Error('任务负载引用无效'); return value.payloadId; };

/** 持久记录拥有结果投递；Harness registry 拥有实际任务资源。 */
export class Tasks {
  private readonly work = new Map<string, Promise<JobOutcome>>();
  private readonly captures = new Map<string, Promise<void>>();
  private readonly results = new Map<string, ToolBatchResult>();
  private readonly readClaims = new Map<string, Set<string>>();
  constructor(readonly life: Life) {
    life.context.jobs.events.subscribe({ owners: 'all' }, event => {
      if (event.type !== 'registered' && event.type !== 'settled' && event.type !== 'stopping') return;
      const roleId = event.job.owner && life.store.meta(`session-owner:${event.job.owner}`);
      if (!roleId || event.job.kind === 'kw-async') return;
      try {
      if (event.type === 'registered') this.nativeRecord(roleId, event.job);
      else if (event.type === 'stopping') { const task = this.byJob(roleId, String(event.job.id)); if (task && !terminal(task)) this.save({ ...task, state: 'stopping' }); }
      else if (event.type === 'settled') {
        const task = this.byJob(roleId, String(event.job.id)) ?? this.nativeRecord(roleId, event.job);
        if (event.awaited) { this.save({ ...task, mode: this.readClaims.get(task.id)?.size ? 'background' : 'foreground', state: event.job.status === 'killed' ? 'cancelled' : event.job.status === 'failed' ? 'failed' : 'completed', finishedAt: now() }); return; }
        const capture = this.captureNative(task, event.job);
        this.captures.set(task.id, capture);
        life.track(capture.finally(() => this.captures.delete(task.id)), roleId);
      }
      } catch (error) { life.fail(error, roleId); throw error; }
    });
  }
  private save(task: AsyncTask): AsyncTask {
    const row = this.life.store.db.prepare("SELECT revision FROM documents WHERE kind='async-task' AND id=?").get(task.id);
    this.life.store.put('async-task', task.id, task.roleId, asJson(task), row ? Number(row.revision) : null, 'system', '后台任务状态');
    return task;
  }
  read(roleId: string, id: string): AsyncTask {
    const task = this.life.store.get('async-task', id, taskSchema) ?? this.byJob(roleId, id);
    if (!task || task.roleId !== roleId) throw new Error('任务不存在或属于其他角色');
    return task;
  }
  byJob(roleId: string, jobId: string): AsyncTask | undefined {
    const row = this.life.store.db.prepare("SELECT body FROM documents WHERE kind='async-task' AND role_id=? AND json_extract(body,'$.jobId')=?").get(roleId, jobId);
    return row ? taskSchema.parse(JSON.parse(String(row.body))) : undefined;
  }
  list(input: z.infer<typeof taskListSchema>) {
    const rows = this.life.store.db.prepare("SELECT body FROM documents WHERE kind='async-task' AND role_id=? AND (? IS NULL OR json_extract(body,'$.state')=?) ORDER BY updated_at DESC,id LIMIT ? OFFSET ?").all(input.roleId, input.state ?? null, input.state ?? null, input.limit + 1, input.cursor).map(row => taskSchema.parse(JSON.parse(String(row.body))));
    return { items: rows.slice(0, input.limit).map(task => ({ ...task, notification: this.life.store.db.prepare('SELECT id FROM events WHERE id=?').get(`async-complete:${task.id}`) ? this.life.store.deliveryStatus(`async-complete:${task.id}`).state : task.mode === 'foreground' ? 'not-required' : 'pending' })), nextCursor: rows.length > input.limit ? input.cursor + input.limit : null };
  }
  private nativeRecord(roleId: string, job: JobView): AsyncTask {
    const existing = this.byJob(roleId, String(job.id)); if (existing) return existing;
    const origin = executionOrigin.getStore();
    const parent = origin?.roleId === roleId ? this.read(roleId, origin.taskId) : undefined;
    return this.save({ id: `task-${randomUUID()}`, roleId, sessionId: String(job.owner), activityId: parent?.activityId ?? this.life.activities.current(roleId)?.id ?? null, callId: null, executionCallId: String(job.id), jobId: String(job.id), label: job.label, kind: String(job.kind), mode: 'background', state: 'running', parentTaskId: parent?.id ?? null, sessionReceiptRequired: false, foregroundCommitted: false, people: parent?.people ?? [], createdAt: new Date(job.startedAt).toISOString(), finishedAt: null, reason: null, programRef: null, resultRef: null, preview: null, context: parent?.context ?? null, sources: parent?.sources ?? [] });
  }
  async start(agent: Agent, callId: string, label: string, program: Json, immediate: boolean, sessionReceiptRequired: boolean, run: (id: string, signal: AbortSignal, taskId: string) => Promise<ToolBatchResult>): Promise<AsyncTask> {
    const role = this.life.store.roles().find(role => role.sessionId === agent.session.id); if (!role) throw new Error('后台任务没有当前角色归属');
    const admission = this.life.admission(role.id); if (admission) throw new Error(`角色不能启动任务：${admission}`);
    const frozen = JSON.parse(this.life.context.kwMind.steps.get(role.id) ?? '{}');
    const id = `task-${randomUUID()}`, activityId = this.life.activities.current(role.id)?.id ?? null;
    const sources = activityId ? this.life.store.db.prepare("SELECT target_id FROM activity_links WHERE activity_id=? AND kind='source'").all(activityId).map(row => String(row.target_id)) : [];
    const contexts = frozen.scene?.contexts ?? [];
    const programRef = await this.life.context.kwMind.payloads.put(role.id, id, program);
    let task = this.save({ id, roleId: role.id, sessionId: String(agent.session.id), activityId, callId, executionCallId: `async:${id}`, jobId: null, label: label.slice(0, 240), kind: 'kw-async', mode: immediate ? 'background' : 'foreground', state: 'starting', parentTaskId: null, sessionReceiptRequired, foregroundCommitted: false, people: z.array(z.string()).parse(frozen.scene?.people ?? []), createdAt: now(), finishedAt: null, reason: null, programRef: asJson(programRef), resultRef: null, preview: null, context: contexts[0] ?? null, sources });
    const controller = new AbortController();
    let registered: JobId | undefined;
    try {
      const jobId = this.life.context.jobs.start({ kind: 'kw-async', owner: agent.session.id, label: task.label, toolCall: { callId: callId as never, rootCallId: callId as never }, run: () => {
        const done = Promise.resolve().then(() => executionOrigin.run({ roleId: role.id, activityId, taskId: id }, async () => {
          const result = await run(task.executionCallId, controller.signal, id);
          this.results.set(id, result);
          const ref = await this.life.context.kwMind.payloads.put(role.id, id, asJson(result));
          const preview = await this.life.context.kwMind.payloads.view(role.id, id, asJson(result), this.life.config.budgets.tool);
          const failed = result.results.some(item => item.result.isError);
          task = this.read(role.id, id);
          task = { ...task, state: controller.signal.aborted ? 'cancelled' : failed ? 'failed' : 'completed', resultRef: asJson(ref), preview, finishedAt: now() };
          this.life.store.transaction(() => { this.save(task); if (task.mode === 'background') this.notify(task); });
          if (task.mode === 'background') this.results.delete(id);
          return { status: task.state === 'cancelled' ? 'killed' : failed ? 'failed' : 'completed', result: JSON.stringify({ taskId: id, resultRef: ref }) } as JobOutcome;
        })).catch(async error => {
          this.results.delete(id);
          if (controller.signal.aborted && (error === controller.signal.reason || error instanceof Error && error.name === 'AbortError')) {
            const reason = error instanceof Error ? error.message : String(error);
            const ref = await this.life.context.kwMind.payloads.put(role.id, id, { cancelled: true, reason });
            task = { ...this.read(role.id, id), state: 'cancelled', finishedAt: now(), reason, resultRef: asJson(ref), preview: { cancelled: true, reason } };
            this.life.store.transaction(() => { this.save(task); if (task.mode === 'background') this.notify(task); });
            return { status: 'killed', detail: reason } as JobOutcome;
          }
          this.life.fail(error, role.id);
          this.save({ ...this.read(role.id, id), state: 'failed', finishedAt: now(), reason: error instanceof Error ? error.message : String(error) });
          throw error;
        }).finally(() => { this.work.delete(id); this.life.activities.finishRoot(role.id, callId); });
        this.work.set(id, done);
        return { done, cancel: reason => { controller.abort(new Error(reason ?? '任务取消')); } };
      } });
      registered = jobId;
      task = this.save({ ...task, jobId: String(jobId), state: 'running' });
      if (activityId) this.life.store.link(activityId, 'task', id, { jobId: String(jobId), callId });
      return task;
    } catch (error) {
      controller.abort(error);
      if (registered) this.life.context.jobs.kill(registered, agent.session.id, '任务登记失败');
      await this.work.get(id)?.catch(() => {});
      this.save({ ...task, state: 'failed', finishedAt: now(), reason: error instanceof Error ? error.message : String(error) }); throw error;
    }
  }
  forget(id: string): void {
    this.results.delete(id);
    const task = this.life.store.get('async-task', id, taskSchema);
    if (task?.jobId && task.mode === 'foreground') this.life.context.jobs.remove(JobId(task.jobId), SessionId(task.sessionId));
  }
  async foreground(task: AsyncTask, signal: AbortSignal): Promise<ToolBatchResult | undefined> {
    const view = await this.life.context.jobs.wait(JobId(task.jobId!), this.life.config.asyncForegroundWaitMs, SessionId(task.sessionId), signal);
    if (view.status === 'failed' && !this.results.has(task.id)) throw new Error('后台执行基础设施失败，请查看角色错误与任务记录');
    return this.results.get(task.id);
  }
  promote(roleId: string, id: string): AsyncTask {
    const task = this.read(roleId, id);
    this.life.store.transaction(() => { this.save({ ...task, mode: 'background' }); if (terminal(task)) this.notify({ ...task, mode: 'background' }); });
    this.results.delete(id);
    return this.read(roleId, id);
  }
  private notify(task: AsyncTask, wake = true): void {
    if (wake && this.readClaims.get(task.id)?.size) return;
    const event = this.life.store.appendEvent({ id: `async-complete:${task.id}`, accountId: this.life.store.role(task.roleId).accountId, roleId: task.roleId, source: 'system', type: 'background-result', occurredAt: task.finishedAt ?? now(), scene: task.context?.scene ?? null, peerId: task.context?.peerId ?? null, senderId: null, messageSeq: null, self: false, payload: asJson({ taskId: task.id, jobId: task.jobId, label: task.label, state: task.state, reason: task.reason, originalSessionId: task.sessionId, activityId: task.activityId, people: task.people, sources: task.sources, resultRef: task.resultRef, preview: task.preview, instruction: '这是系统自动送达的实际后台终态结果，优先直接使用state、preview和resultRef继续处理，无需查询任务是否完成。只有预览缺少具体内容时按需读取一次完整负载。自主决定是否交流，不要重复查询同一结果或执行已经完成的操作。程序结束不证明所有子操作成功。' }) });
    if (wake && event.inserted) queueMicrotask(() => { if (this.life.store.deliveryStatus(event.event.id).state !== 'completed' && !this.life.store.get('role', task.roleId, z.object({ deletedAt: z.string().nullable() }))?.deletedAt) this.life.enqueue(task.roleId); });
  }
  private async captureNative(task: AsyncTask, job: JobView): Promise<void> {
    const read = this.life.context.jobs.read(job.id, job.owner);
    const files = [];
    for (const path of job.output.spillPaths ?? []) {
      const parts = [];
      for await (const text of createReadStream(path, { encoding: 'utf8', highWaterMark: 65536 })) parts.push(await this.life.context.kwMind.payloads.put(task.roleId, task.id, { path, part: parts.length, text: String(text) }));
      files.push({ path, parts });
    }
    const full = asJson({ ...read, files });
    const resultRef = await this.life.context.kwMind.payloads.put(task.roleId, task.id, full);
    const preview = await this.life.context.kwMind.payloads.view(task.roleId, task.id, full, this.life.config.budgets.tool);
    task = { ...this.read(task.roleId, task.id), state: job.status === 'killed' ? 'cancelled' : job.status === 'failed' ? 'failed' : 'completed', finishedAt: now(), resultRef: asJson(resultRef), preview };
    this.life.store.transaction(() => { this.save(task); this.notify(task); });
  }
  cancel(roleId: string, id: string, reason = '人工取消任务'): AsyncTask {
    const task = this.read(roleId, id); if (terminal(task)) return task;
    if (!task.jobId) throw new Error('任务尚未完成注册');
    this.life.context.jobs.kill(JobId(task.jobId), SessionId(task.sessionId), reason);
    return this.save({ ...this.read(roleId, id), state: 'stopping', reason });
  }
  async cancelRole(roleId: string, reason: string): Promise<void> {
    const rows = this.life.store.list('async-task', taskSchema, roleId, 100000).filter(task => !terminal(task));
    for (const task of rows) this.cancel(roleId, task.id, reason);
    await Promise.all(rows.map(task => this.work.get(task.id) ?? this.waitNative(task)));
    await Promise.all([...this.captures].filter(([id]) => this.life.store.get('async-task', id, taskSchema)?.roleId === roleId).map(([, work]) => work));
  }
  private async waitNative(task: AsyncTask): Promise<void> {
    if (!task.jobId) return;
    for (;;) {
      const view = await this.life.context.jobs.wait(JobId(task.jobId), 30000, SessionId(task.sessionId));
      if (!['running', 'stopping'].includes(view.status)) return;
    }
  }
  async recover(): Promise<void> {
    const roles = new Set(this.life.store.roles().map(role => role.id));
    for (const original of this.life.store.list('async-task', taskSchema, undefined, 100000)) {
      if (!roles.has(original.roleId)) continue;
      let task = terminal(original) ? original : { ...original, state: 'interrupted' as const, finishedAt: now(), reason: '执行进程已结束，程序未重放；未确认的远程副作用保持未知' };
      if (task.mode === 'foreground' && task.sessionReceiptRequired && !task.foregroundCommitted && task.callId) {
        const records = await this.life.context.sessionQuery.filterEvents(SessionId(task.sessionId), [{ kind: 'type', values: ['tool/result'] }, { kind: 'time', from: Date.parse(task.createdAt) }]);
        for (const record of records) {
          const { target } = await this.life.context.sessionQuery.readEvent({ sessionId: SessionId(task.sessionId), seq: record.seq, before: 0, after: 0 });
          if (target.type === 'tool/result' && target.data.message.toolCallId === task.callId && !target.data.message.isError) { task = { ...task, foregroundCommitted: true }; break; }
        }
      }
      this.life.store.transaction(() => { if (task !== original) this.save(task); if (task.mode === 'background' || task.state === 'interrupted' || task.sessionReceiptRequired && !task.foregroundCommitted) this.notify(task); });
    }
  }
  async output(roleId: string, id: string, wait: boolean, timeout: number, signal: AbortSignal, claim?: string) {
    let task = this.read(roleId, id);
    if (claim) { const claims = this.readClaims.get(task.id) ?? new Set<string>(); claims.add(claim); this.readClaims.set(task.id, claims); }
    if (wait && !terminal(task)) await this.life.context.jobs.wait(JobId(task.jobId!), timeout, SessionId(task.sessionId), signal);
    await this.captures.get(task.id);
    task = this.read(roleId, task.id);
    if (terminal(task) && task.state !== 'interrupted' && !task.resultRef && task.jobId && task.kind !== 'kw-async') { await this.captureNative(task, this.life.context.jobs.get(JobId(task.jobId), SessionId(task.sessionId))); task = this.read(roleId, task.id); }
    if (task.resultRef) return { task, result: await this.life.context.kwMind.payloads.value(roleId, refId(task.resultRef)) };
    if (terminal(task)) return { task, result: null };
    const output = task.jobId ? this.life.context.jobs.read(JobId(task.jobId), SessionId(task.sessionId)) : null;
    return { task, result: asJson(output) };
  }
  claimCall(roleId: string, callId: string): string {
    const origin = executionOrigin.getStore();
    return origin?.roleId === roleId ? this.read(roleId, origin.taskId).callId ?? callId : callId;
  }
  awaitingRead(taskId: string): boolean { return Boolean(this.readClaims.get(taskId)?.size); }
  async deferred(roleId: string, id: string, signal?: AbortSignal): Promise<ContentBlock[]> {
    const task = this.read(roleId, id); if (!task.resultRef) return [];
    const value = await this.life.context.kwMind.payloads.value(roleId, refId(task.resultRef), signal) as unknown as Partial<ToolBatchResult>;
    return (value.additionalContexts ?? []).flatMap(context => context.content.filter(block => block.type !== 'text'));
  }
  jobView(task: AsyncTask) {
    return { id: task.jobId ?? task.id, taskId: task.id, kind: task.kind, label: task.label, status: task.state === 'cancelled' ? 'killed' : task.state === 'interrupted' ? 'failed' : task.state === 'starting' ? 'running' : task.state, startedAt: Date.parse(task.createdAt), ...task.finishedAt ? { finishedAt: Date.parse(task.finishedAt) } : {}, ...task.reason ? { detail: task.reason } : {} };
  }
  async consume(roleId: string, callId: string, accepted: boolean, completion = false): Promise<void> {
    const parent = this.life.store.db.prepare("SELECT body FROM documents WHERE kind='async-task' AND role_id=? AND json_extract(body,'$.callId')=?").get(roleId, callId);
    if (!completion && parent) {
      const task = taskSchema.parse(JSON.parse(String(parent.body)));
      if (task.mode === 'background') return;
      this.save({ ...task, foregroundCommitted: accepted });
      if (!accepted && terminal(task)) this.promote(roleId, task.id);
    }
    for (const [id, claims] of this.readClaims) {
      if (!claims.delete(callId)) continue;
      if (claims.size) continue;
      this.readClaims.delete(id);
      const task = this.read(roleId, id); if (!terminal(task)) continue;
      if (accepted) this.life.store.transaction(() => { this.notify(task, false); this.life.store.delivery([`async-complete:${id}`], `read:${callId}`, 'completed'); });
      else this.life.store.transaction(() => this.notify(task));
    }
  }
}
