import { Context, Service } from '@deepseek-ai/cordis';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import { MessageId, isAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import { estimateContent, estimateMessage, estimateToolsTokens, ROLE_OVERHEAD } from '@deepseek-ai/dsh-token-meter/estimate';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId, appendPluginRecord } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-query';
import type {} from '@deepseek-ai/dsh-cmdline';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type {} from '@deepseek-ai/dsh-schedule';
import type {} from '@deepseek-ai/dsh-jobs';
import type {} from '@deepseek-ai/dsh-compaction';
import type {} from '@kwagent/kw-mind';
import type {} from '@kwagent/kw-lagrange';
import { asJson, CapabilityError, errorText, now, registerTool, roleInputSchema, roleSchema, publicConfig, redact, tokens, summary, readable, continuityActive } from '@kwagent/core';
import type { AppConfig, Experience, Json, Role, RoleInput, Store, ContinuityScene } from '@kwagent/core';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Plans, planRequestSchema, scheduleNotices } from './plans.ts';
import type { PlanRequest } from './plans.ts';
import { Extensions, extensionRequestSchema } from './extensions.ts';
import { Operations } from './operations.ts';
import { preparePerception } from './perception.ts';
import { Activities, activitySchema } from './activities.ts';
import { APP_VERSION } from '@kwagent/core';

export { Plans, planRequestSchema, timingSchema } from './plans.ts';
export { Extensions, extensionRequestSchema } from './extensions.ts';
export { restoreBackup } from './operations.ts';
declare module '@deepseek-ai/cordis' { interface Context { kwLife: Life } }
declare module '@deepseek-ai/dsh-llm/message' { interface MessageSourceMap { 'kw-event': { kind: 'kw-event'; roleId: string; eventIds: string[] } } }
declare module '@deepseek-ai/dsh-session' { interface PluginRecordMap { 'plugin:kwagent/context': Json; 'plugin:kwagent/payload': Json } }

interface RoleRuntime { state: string; error: string | null; lastActivityAt: string | null }

/** 一个角色拥有一个长期 Agent，事件、计划、Panel 和维护命令共享状态控制。 */
export class Life extends Service {
  readonly handles = new Map<string, AgentHandle>();
  readonly runtime = new Map<string, RoleRuntime>();
  readonly plans: Plans;
  readonly extensions: Extensions;
  readonly operations: Operations;
  readonly activities: Activities;
  readonly store: Store;
  readonly config: AppConfig;
  maintenance = false;
  started = false;
  startupError: string | null = null;
  private readonly creating = new Map<string, Promise<AgentHandle>>();
  private readonly dispatching = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingTasks = new Set<Promise<unknown>>();
  private readonly contexts = new Map<string, string>();
  private readonly scenes = new Map<string, ContinuityScene>();
  private readonly continuityWork = new Map<string, Promise<void>>();
  private readonly toolViews = new Map<string, Json>();
  private readonly dispatchAbort = new Map<string, AbortController>();
  private readonly dispatchWork = new Map<string, Promise<void>>();
  private closing = false;
  private startTask?: Promise<void>;
  private closeTask?: Promise<void>;
  private maintenanceTask?: Promise<void>;
  private readonly sessions: Context['sessions'];
  private readonly jobs: Context['jobs'];

  constructor(ctx: Context) {
    super(ctx, 'kwLife');
    this.store = ctx.kwMind.store;
    this.config = ctx.kwMind.config;
    this.sessions = ctx.sessions;
    this.jobs = ctx.jobs;
    this.plans = new Plans(ctx, ctx.kwMind.store);
    this.extensions = new Extensions(ctx.kwMind.store, ctx.kwMind.config.dataRoot, ctx);
    this.operations = new Operations(this);
    this.activities = new Activities(this.store);
  }
  get context() { return this.ctx; }
  track<T>(promise: Promise<T>, roleId?: string): void {
    this.pendingTasks.add(promise);
    void promise.catch(error => this.fail(error, roleId)).finally(() => this.pendingTasks.delete(promise));
  }
  fail(error: unknown, roleId?: string): void {
    const message = redact(errorText(error), this.config);
    if (roleId) this.runtime.set(roleId, { state: 'error', error: message, lastActivityAt: now() });
    else this.startupError = message;
    this.store.changes.emit('change', this.store.revision());
    this.ctx.logger.error('%s', message);
  }
  start(): Promise<void> { this.startTask ??= this.initialize().finally(() => { this.startTask = undefined; }); return this.startTask; }
  private async initialize(): Promise<void> {
    if (this.started) return;
    await this.ctx.kwLagrange.start();
    this.started = true;
    this.startupError = null;
    this.extensions.recoverProfile();
    for (const role of this.store.roles()) {
      await this.syncContinuity(role.id);
      if (role.state === 'active') {
        try { await this.ensure(role.id); await this.plans.reconcileRole(role.id); this.enqueue(role.id); }
        catch (error) { this.fail(error, role.id); }
      } else await this.plans.reconcileRole(role.id);
    }
  }
  create(input: RoleInput): Role {
    const parsed = roleInputSchema.parse(input);
    if (parsed.accountId !== 'main') throw new Error('当前 Milky 连接的账号标识为 main');
    const role = this.store.createRole({ ...parsed, memoryTokens: parsed.memoryTokens ?? this.config.memoryTokens });
    if (role.state === 'active') this.track(this.control(role.id, 'active', false), role.id);
    return role;
  }
  syncContinuity(roleId: string): Promise<void> {
    const pending = this.continuityWork.get(roleId) ?? Promise.resolve();
    const task = pending.then(async () => {
      const records = this.store.db.prepare("SELECT id FROM documents WHERE kind='continuity' AND role_id=? AND json_extract(body,'$.data.kind') IN ('thread','conversation')").all(roleId).map(row => this.ctx.kwMind.continuity.read(roleId, String(row.id)));
      for (const record of records) {
        if (record.data.kind !== 'thread' && record.data.kind !== 'conversation') continue;
        const existing = this.store.plans(roleId).find(plan => plan.relatedRecords.includes(record.id) && plan.title === `复核：${record.id}`);
        const date = record.data.reviewAt;
        if (!date || !continuityActive(record, new Date(Math.max(Date.now(), Date.parse(date))).toISOString())) { if (existing && !['cancelled', 'completed'].includes(existing.status)) await this.plans.mutate(roleId, { action: 'cancel', id: existing.id, expectedRevision: existing.revision }); continue; }
        if (existing && JSON.stringify(existing.timing) === JSON.stringify({ kind: 'at', at: date }) && (existing.status !== 'cancelled' || existing.updatedAt >= record.updatedAt)) continue;
        await this.plans.mutate(roleId, { action: existing ? 'update' : 'create', ...(existing ? { id: existing.id, expectedRevision: existing.revision } : {}), kind: 'time', title: `复核：${record.id}`, instruction: `重新读取连续性记录 ${record.id}，根据当前状态决定继续、交流、暂缓或结束。安排不代表对外发送。`, purpose: 'review', relatedRecords: [record.id], context: record.data.context, sources: record.data.sources, timing: { kind: 'at', at: date } });
      }
      await this.plans.reconcileRole(roleId);
    }).finally(() => { if (this.continuityWork.get(roleId) === task) this.continuityWork.delete(roleId); });
    this.continuityWork.set(roleId, task); return task;
  }
  async update(id: string, patch: Partial<Role>, expected: number): Promise<Role> {
    const previous = this.store.role(id);
    const role = this.store.updateRole(id, { ...patch, ...('persona' in patch || 'selfState' in patch || 'expressionExamples' in patch ? { personaSources: [] } : {}) }, expected, 'owner', '人工修改角色');
    if (role.state !== previous.state) await this.control(id, role.state, false);
    const agent = this.handles.get(id)?.agent;
    if (agent && (role.provider !== previous.provider || role.model !== previous.model)) agent.model.select({ provider: role.provider, model: role.model });
    return this.store.role(id);
  }
  async control(roleId: string, state: Role['state'], save = true): Promise<Role> {
    let role = this.store.role(roleId);
    if (save) role = this.store.updateRole(roleId, { state }, role.revision, 'owner', `设置角色状态：${state}`);
    if (state === 'active') {
      const handle = await this.ensure(roleId);
      await this.extensions.restore(roleId, handle.agent.ctx);
      await this.plans.reconcileRole(roleId);
      this.runtime.set(roleId, { state: 'waiting', error: null, lastActivityAt: now() });
      this.enqueue(roleId);
    } else {
      const timer = this.timers.get(roleId); if (timer) clearTimeout(timer); this.timers.delete(roleId);
      this.dispatchAbort.get(roleId)?.abort();
      const agent = this.handles.get(roleId)?.agent;
      if (agent?.status === 'running') this.store.setMeta(`wake:${roleId}`, 'pending');
      agent?.cancel({ kind: 'hook', reason: `角色${state}` }, { keepInbox: true });
      await this.dispatchWork.get(roleId);
      await this.plans.pause(roleId);
      await agent?.whenIdle();
      await this.extensions.suspend(roleId);
      this.runtime.set(roleId, { state, error: null, lastActivityAt: now() });
    }
    return role;
  }
  ensure(roleId: string): Promise<AgentHandle> {
    const live = this.handles.get(roleId); if (live) return Promise.resolve(live);
    const pending = this.creating.get(roleId); if (pending) return pending;
    const promise = this.createAgent(roleId).finally(() => this.creating.delete(roleId));
    this.creating.set(roleId, promise);
    return promise;
  }
  private async createAgent(roleId: string): Promise<AgentHandle> {
    const role = this.store.role(roleId);
    const workspace = join(this.config.dataRoot, 'workspaces', roleId);
    await mkdir(workspace, { recursive: true });
    const setup = async (agentCtx: Context, agent: Agent) => {
      installModelSelection(agentCtx);
      await this.ctx.agentPresets.mount(agentCtx, 'standard');
      this.ctx.kwMind.attach(agentCtx, roleId);
      await this.ctx.kwLagrange.attach(agentCtx, roleId);
      registerTool(agentCtx, 'life_plan', '管理自己的目标、条件事项和唤醒安排。可以自行创建、修改、完成或取消。', planRequestSchema, input => this.plans.mutate(roleId, input));
      registerTool(agentCtx, 'extension_manage', '使用 Bun 管理自己的 Skill、脚本与 Node ESM 扩展依赖。', extensionRequestSchema, (input, exec) => this.extensions.manage(roleId, input, agentCtx, exec.signal));
      agentCtx.systemPrompt.context({ name: 'kw-life-state', order: 900, required: true, interpolate: false, text: () => this.ctx.kwMind.steps.get(roleId) ?? '' });
      agentCtx.on('agent/pre-step', async (payload, next) => {
        const reason = this.admission(roleId);
        if (reason) {
          this.store.setMeta(`wake:${roleId}`, 'pending');
          for (const message of payload.messages) if (message.source.kind !== 'kw-event') this.store.appendEvent({ id: `deferred:${message.id}`, accountId: role.accountId, roleId, source: 'schedule', type: 'deferred-input', occurredAt: now(), scene: null, peerId: null, senderId: null, messageSeq: null, self: false, payload: asJson(message) });
          this.runtime.set(roleId, { state: reason, error: null, lastActivityAt: now() });
          return { kind: 'reject' };
        }
        const hadInput = payload.messages.length > 0;
        const admitted: UserMessage[] = [];
        const scheduleContext: string[] = [];
        const sceneEvents = payload.messages.flatMap(message => message.source.kind === 'kw-event' ? message.source.eventIds.map(id => this.store.event(id)) : []);
        let scene = sceneEvents.length ? this.sceneFor(sceneEvents) : payload.messages.length ? this.sceneFor([]) : this.scenes.get(roleId) ?? this.sceneFor([]);
        for (const message of payload.messages) {
          if (String(message.source.kind) === 'schedule') {
            const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
            const notices = scheduleNotices(text);
            const valid = await this.plans.filterNotices(roleId, notices, message.id);
            if (notices.length && !valid.length) continue;
            const checked: UserMessage = notices.length ? { ...message, content: [{ type: 'text', text: `这些是已核对的时间事项：\n${JSON.stringify(valid)}` }] } : message;
            this.store.appendEvent({ id: `schedule:${message.id}`, accountId: role.accountId, roleId, source: 'schedule', type: 'scheduled-activity', occurredAt: now(), scene: null, peerId: null, senderId: null, messageSeq: null, self: true, payload: asJson(checked) });
            admitted.push(checked);
            for (const notice of valid) if (notice.prompt.startsWith('KWAGENT_PLAN\n')) { const marker = JSON.parse(notice.prompt.slice('KWAGENT_PLAN\n'.length)); const plan = this.store.plan(marker.planId); scene = { ...scene, planIds: [...new Set([...scene.planIds, plan.id])], recordIds: [...new Set([...scene.recordIds, ...plan.relatedRecords])], contexts: [...new Map([...scene.contexts, ...plan.context ? [plan.context] : []].map(context => [`${context.scene}:${context.peerId}`, context])).values()], people: [...new Set([...scene.people, ...plan.context?.scene === 'private' ? [String(plan.context.peerId)] : []])] }; }
            scheduleContext.push(JSON.stringify(checked.content));
            continue;
          }
          admitted.push(message);
        }
        payload.messages.splice(0, payload.messages.length, ...admitted);
        if (hadInput && !payload.messages.length) return { kind: 'reject' };
        if (scheduleContext.length) this.contexts.set(roleId, await this.ctx.kwMind.context(roleId, scheduleContext.join('\n'), payload.signal));
        this.scenes.set(roleId, scene);
        await this.syncContinuity(roleId);
        const frozen = this.ctx.kwMind.freeze(roleId, this.contexts.get(roleId) ?? '{"memories":[]}', scene, this.ctx.kwLagrange.socialContext(roleId, scene.contexts));
        const ref = await this.ctx.kwMind.payloads.put(roleId, `step:${role.sessionId}:${payload.turn}:${payload.step}`, asJson(JSON.parse(frozen)), payload.signal);
        appendPluginRecord(payload.agent.session, 'plugin:kwagent/context', asJson({ roleId, turn: payload.turn, step: payload.step, ...ref, estimatedTokens: tokens(frozen), inputs: payload.messages.map(message => message.id) }));
        const activity = this.activities.current(roleId); if (activity) this.store.link(activity.id, 'context', `${payload.turn}:${payload.step}`, asJson(ref));
        return next();
      });
      agentCtx.tools.guard(() => this.admission(roleId) ?? undefined);
      agentCtx.on('agent/turn-stopping', async payload => {
        if (this.admission(roleId)) return;
        await this.ctx.kwMind.consolidate(payload.agent, roleId, payload.signal);
        await this.syncContinuity(roleId);
        this.store.completeDelivered(roleId, [...this.activities.accepted.get(roleId) ?? []]);
        await this.ctx.sessions.flush(payload.agent.session);
      });
      agentCtx.on('agent/status', ({ status }) => {
        if (this.runtime.get(roleId)?.state === 'error') return;
        this.runtime.set(roleId, { state: this.admission(roleId) ?? (status === 'running' ? 'running' : 'waiting'), error: null, lastActivityAt: now() });
        this.store.changes.emit('change', this.store.revision());
        if (status === 'idle' && this.store.pending(roleId).length) this.enqueue(roleId);
      });
      agentCtx.on('agent/error', ({ error }) => this.fail(error, roleId));
      agentCtx.on('tools/post-execute', async (exec, result, next) => {
        try {
        const nextDecision = await next(); if (nextDecision.kind !== 'accept' || 'value' in nextDecision) return nextDecision;
        const decision = { ...nextDecision };
        const executionId = this.store.invocationId(exec.token);
        if (this.activities.noProgress(roleId, exec.name, asJson(exec.arguments), asJson(result.isError ? result.error : result.value), exec)) decision.additionalContexts = [...decision.additionalContexts ?? [], { id: MessageId(`no-progress:${executionId}`), role: 'user', source: { kind: 'kw-event', roleId, eventIds: [`tool:${roleId}:${executionId}`] }, content: [{ type: 'text', text: '连续三次相同工具与参数得到相同结果，尚未观察到进展。请结合已有结果自主决定接下来的活动。' }] }];
        const content = decision.content ?? result.content;
        const value = asJson({ isError: result.isError, ...(result.isError ? { error: result.error } : {}), content, result, arguments: exec.arguments });
        const view = await this.ctx.kwMind.payloads.view(roleId, `tool:${roleId}:${executionId}`, value, this.config.budgets.tool, exec.signal);
        if (view === value) return decision;
        this.toolViews.set(executionId, view);
        appendPluginRecord(agent.session, 'plugin:kwagent/payload', asJson({ executionId, callId: exec.callId, rootCallId: exec.rootCallId, view }));
        return { ...decision, content: [...content.filter(block => block.type !== 'text'), { type: 'text' as const, text: JSON.stringify(view) }] };
        } catch (error) { if (!exec.signal.aborted) this.fail(error, roleId); throw error; }
      });
      agentCtx.on('tools/result', (exec, result) => {
        try {
        const executionId = this.store.invocationId(exec.token); const projected = this.toolViews.get(executionId); this.toolViews.delete(executionId);
        const saved = this.store.appendEvent({ id: `tool:${roleId}:${executionId}`, accountId: role.accountId, roleId, source: 'tool', type: 'tool-result', occurredAt: now(), scene: null, peerId: null, senderId: null, messageSeq: null, self: true, payload: asJson({ executionId, parentExecutionId: exec.parent ? this.store.invocationId(exec.parent) : null, callId: exec.callId, rootCallId: exec.rootCallId, name: exec.name, ...(projected ? { result: projected, isError: result.isError, ...(result.isError ? { failure: result.error } : {}) } : { arguments: exec.arguments, result }) }) }).event;
        this.activities.tool(roleId, executionId, exec.callId, exec.rootCallId, exec.name, { sourceId: saved.id, isError: result.isError });
        } catch (error) { this.fail(error, roleId); throw error; }
      });
      agentCtx.on('session/event', (_session, event) => {
        try {
        this.activities.event(roleId, role.sessionId, event);
        if (event.type === 'assistant/message') this.store.appendEvent({ id: `assistant:${roleId}:${event.seq}`, accountId: role.accountId, roleId, source: 'system', type: 'internal-activity', occurredAt: new Date(event.time).toISOString(), scene: null, peerId: null, senderId: null, messageSeq: null, self: true, payload: asJson(event.data) });
        if (event.type === 'job/settled') {
          const experience = this.store.appendEvent({ id: `job:${roleId}:${event.data.jobId}:settled`, accountId: role.accountId, roleId, source: 'system', type: 'background-complete', occurredAt: new Date(event.time).toISOString(), scene: null, peerId: null, senderId: null, messageSeq: null, self: false, payload: asJson(event.data) });
          if (experience.inserted) this.enqueue(roleId);
        }
        } catch (error) { this.fail(error, roleId); throw error; }
      });
      if (this.store.role(roleId).state === 'active' && !this.maintenance) await this.extensions.restore(roleId, agentCtx);
    };
    const exists = await this.ctx.sessionPersistence.stat(SessionId(role.sessionId));
    const agentOptions = { provider: role.provider, model: role.model, maxTokens: 8192 };
    const handle = exists
      ? await this.ctx.agents.resume({ resumeSessionId: SessionId(role.sessionId), agentOptions, setup })
      : await this.ctx.agents.create({ sessionId: SessionId(role.sessionId), meta: { cwd: workspace, agentPreset: 'standard' }, agentOptions, setup });
    this.handles.set(roleId, handle);
    const currentRole = this.store.role(roleId);
    if (currentRole.provider !== role.provider || currentRole.model !== role.model) handle.agent.model.select({ provider: currentRole.provider, model: currentRole.model });
    if (currentRole.state !== 'active' || this.maintenance) await this.extensions.suspend(roleId);
    const recovered = await this.ctx.sessionQuery.readSession(SessionId(role.sessionId));
    this.activities.accepted.set(roleId, new Set(recovered.events.flatMap(event => event.type === 'user/message' ? [String(event.data.id)] : [])));
    this.store.recoverDeliveries(roleId, [...this.activities.accepted.get(roleId)!]);
    for (const activity of this.store.list('activity', activitySchema, roleId, 200)) if (activity.state === 'running') this.store.put('activity', activity.id, roleId, asJson({ ...activity, state: 'interrupted', endedAt: now(), revision: activity.revision + 1 }), activity.revision, 'system', '恢复未完成活动');
    this.store.setMeta(`activity:${roleId}`, '');
    if (!exists) this.store.appendEvent({ id: `init:${roleId}`, accountId: role.accountId, roleId, source: 'system', type: 'initialize', occurredAt: now(), scene: null, peerId: null, senderId: null, messageSeq: null, self: false, payload: { instruction: '认识当前环境与可用工具，自主决定自己的目标、活动和后续安排。' } });
    return handle;
  }
  private day(): string { return new Intl.DateTimeFormat('en-CA', { timeZone: this.config.timeZone }).format(new Date()); }
  admission(roleId: string): string | null {
    if (this.closing || this.maintenance) return 'maintenance';
    const role = this.store.role(roleId);
    if (role.state !== 'active') return role.state;
    if (this.runtime.get(roleId)?.state === 'error') return 'error';
    const usage = this.store.usage(roleId, this.day());
    if ((role.dailyRequests && usage.requests >= role.dailyRequests) || (role.dailyTokens && usage.tokens >= role.dailyTokens)) return 'quota';
    if (role.activeHours) {
      const clock = new Intl.DateTimeFormat('en-GB', { timeZone: this.config.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
      const { start, end } = role.activeHours;
      if (!(start <= end ? clock >= start && clock < end : clock >= start || clock < end)) return 'outside-active-hours';
    }
    return null;
  }
  receive(event: Experience): void {
    if (!event.roleId || event.self) return;
    for (const plan of this.store.plans(event.roleId)) {
      if (plan.kind !== 'condition' || plan.status !== 'active' || !plan.condition) continue;
      if (plan.condition.eventTypes.length && !plan.condition.eventTypes.includes(event.type)) continue;
      if (plan.condition.peerIds.length && (event.peerId === null || !plan.condition.peerIds.includes(event.peerId))) continue;
      this.store.appendEvent({ id: `condition:${plan.id}:${event.id}`, accountId: event.accountId, roleId: event.roleId, source: 'system', type: 'condition-candidate', occurredAt: now(), scene: event.scene, peerId: event.peerId, senderId: null, messageSeq: null, self: false, payload: { planId: plan.id, sourceEventId: event.id, condition: plan.condition.text, instruction: plan.instruction, context: plan.context, sources: plan.sources } });
    }
    this.enqueue(event.roleId);
  }
  enqueue(roleId: string): void {
    if (this.timers.has(roleId) || this.dispatching.has(roleId) || this.admission(roleId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(roleId);
      const task = this.dispatch(roleId).finally(() => this.dispatchWork.delete(roleId));
      this.dispatchWork.set(roleId, task);
      this.track(task, roleId);
    }, this.config.batchMs);
    this.timers.set(roleId, timer);
  }
  private async dispatch(roleId: string): Promise<void> {
    if (this.dispatching.has(roleId) || this.admission(roleId)) return;
    this.dispatching.add(roleId);
    const controller = new AbortController();
    this.dispatchAbort.set(roleId, controller);
    try {
      const batch = this.store.pendingBatch(roleId);
      const events = batch.events;
      if (!events.length && this.store.meta(`wake:${roleId}`) === 'pending') {
        const role = this.store.role(roleId);
        events.push(this.store.appendEvent({ accountId: role.accountId, roleId, source: 'system', type: 'resume-activity', occurredAt: now(), scene: null, peerId: null, senderId: null, messageSeq: null, self: false, payload: { instruction: '活动条件已经恢复，请结合已保存的输入与执行记录决定是否继续。' } }).event);
      }
      if (!events.length) return;
      for (let index = events.length - 1; index >= 0; index--) {
        const event = events[index]!;
        if (event.type !== 'deferred-input' || typeof event.payload !== 'object' || event.payload === null || !('content' in event.payload)) continue;
        const input = z.object({ id: z.string(), source: z.object({ kind: z.string() }), content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()) }).parse(event.payload);
        if (input.source.kind !== 'schedule') continue;
        const notices = scheduleNotices(input.content.filter(block => block.type === 'text').map(block => block.text).join('\n'));
        const valid = await this.plans.filterNotices(roleId, notices, input.id);
        if (notices.length && !valid.length) { this.store.delivery([event.id], `filtered:${input.id}`, 'completed'); events.splice(index, 1); }
        else if (notices.length) events[index] = { ...event, payload: { sourceEventId: event.id, validatedNotices: asJson(valid) } };
      }
      if (!events.length) return;
      const handle = await this.ensure(roleId);
      controller.signal.throwIfAborted(); if (this.admission(roleId)) return;
      const query = events.map(event => JSON.stringify(readable(event.payload))).join('\n').slice(0, 4000);
      this.contexts.set(roleId, await this.ctx.kwMind.context(roleId, query, controller.signal));
      controller.signal.throwIfAborted();
      if (this.admission(roleId)) return;
      const messageId = batch.messageId ?? `kw-${createHash('sha256').update(events.map(event => event.id).join('\n')).digest('hex')}`;
      const ids = events.map(event => event.id);
      const frame = await preparePerception(this.store, this.ctx.kwMind.payloads, roleId, events, messageId, this.config.budgets.perception, controller.signal);
      this.store.delivery(ids, messageId, 'prepared');
      const alreadyInSession = this.activities.accepted.get(roleId)?.has(messageId) || [...handle.agent.inbox.nextTurn, ...handle.agent.inbox.nextStep].some(message => message.id === messageId);
      if (!alreadyInSession) {
        const message: UserMessage = {
          id: MessageId(messageId), role: 'user', source: { kind: 'kw-event', roleId, eventIds: ids },
          content: [{ type: 'text', text: JSON.stringify(frame) }],
        };
        handle.agent.steer(message);
      }
      await this.ctx.sessions.flush(handle.agent.session);
      this.store.delivery(ids, messageId, 'delivered');
      this.store.setMeta(`wake:${roleId}`, 'delivered');
    } catch (error) { if (!controller.signal.aborted) throw error; }
    finally { this.dispatching.delete(roleId); this.dispatchAbort.delete(roleId); if (this.store.pending(roleId, 1).length && !this.admission(roleId)) this.enqueue(roleId); }
  }
  manual(roleId: string, text: string, type = 'manual'): Experience {
    const role = this.store.role(roleId);
    const event = this.store.appendEvent({ accountId: role.accountId, roleId, source: 'manual', type, occurredAt: now(), scene: null, peerId: null, senderId: null, messageSeq: null, self: false, payload: { text } }).event;
    this.enqueue(roleId);
    return event;
  }
  private sceneFor(events: Experience[]): ContinuityScene {
    return { eventIds: events.map(event => event.id), people: [...new Set(events.flatMap(event => event.senderId ? [String(event.senderId)] : event.scene === 'private' && event.peerId ? [String(event.peerId)] : []))], contexts: [...new Map(events.flatMap(event => event.scene && event.peerId && ['group', 'private'].includes(event.scene) ? [[`${event.scene}:${event.peerId}`, { scene: event.scene as 'group' | 'private', peerId: event.peerId }] as const] : [])).values()], planIds: [], recordIds: [], query: events.map(event => JSON.stringify(readable(event.payload))).join('\n').slice(0, 4000) };
  }
  quiesce(): Promise<void> {
    this.maintenance = true;
    this.maintenanceTask ??= this.hold();
    return this.maintenanceTask;
  }
  private async hold(): Promise<void> {
    await this.operations.drain();
    await this.plans.suspend();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const controller of this.dispatchAbort.values()) controller.abort();
    await Promise.allSettled([...this.dispatchWork.values()]);
    for (const role of this.store.roles()) {
      for (const job of this.jobs.list(SessionId(role.sessionId))) this.jobs.kill(job.id, SessionId(role.sessionId), '服务器维护');
    }
    for (const [roleId, handle] of this.handles) { if (handle.agent.status === 'running') this.store.setMeta(`wake:${roleId}`, 'pending'); handle.agent.cancel({ kind: 'hook', reason: '服务器维护' }, { keepInbox: true }); }
    await Promise.all([...this.handles.values()].map(async handle => { await handle.agent.whenIdle(); await this.sessions.flush(handle.agent.session); }));
    await this.extensions.close();
  }
  async resume(): Promise<void> { if (this.closing) return; await this.maintenanceTask; this.maintenanceTask = undefined; this.maintenance = false; await this.plans.resume(); for (const role of this.store.roles()) if (role.state === 'active') { const handle = await this.ensure(role.id); await this.extensions.restore(role.id, handle.agent.ctx); this.enqueue(role.id); } }
  snapshot(roleId?: string): Json {
    const preview = <T>(items: T[]) => items.slice(0, 50).map(item => summary(item, this.config.budgets.panelBodyBytes));
    const value = { revision: this.store.revision(), version: APP_VERSION, maintenance: this.maintenance, started: this.started, startupError: this.startupError,
      roles: preview(this.store.roles().sort((a, b) => Number(b.id === roleId) - Number(a.id === roleId)).map(role => ({ ...role, runtime: this.runtime.get(role.id) ?? { state: role.state, error: null, lastActivityAt: null }, usage: this.store.usage(role.id, this.day()) }))),
      activities: preview(this.store.list('activity', activitySchema, roleId, 50)), events: preview(this.store.events(roleId, 50).map(event => ({ ...event, delivery: this.store.deliveryStatus(event.id) }))), memories: preview(roleId ? this.store.memories(roleId, 50) : []), plans: preview(this.store.plans(roleId)), operations: preview(this.store.operations(roleId, 50)),
      extensions: preview(this.store.extensions(roleId)), connections: { mcp: this.ctx.kwLagrange.client.status, events: this.ctx.kwLagrange.events.status }, config: publicConfig(this.config), truncated: false };
    const lists: unknown[][] = [value.roles, value.activities, value.events, value.memories, value.plans, value.operations, value.extensions];
    while (Buffer.byteLength(JSON.stringify(value)) > this.config.budgets.snapshotBytes) {
      const largest = [...lists].sort((a, b) => Buffer.byteLength(JSON.stringify(b)) - Buffer.byteLength(JSON.stringify(a)))[0]!;
      if (!largest.length) throw new Error('Panel 必需状态超过快照容量'); largest.pop(); value.truncated = true;
    }
    return asJson(value);
  }
  close(): Promise<void> { this.closeTask ??= this.stop(); return this.closeTask; }
  private async stop(): Promise<void> {
    this.closing = true;
    await this.operations.close();
    await this.quiesce();
    for (const [roleId] of this.handles) this.store.recoverDeliveries(roleId, [...this.activities.accepted.get(roleId) ?? []]);
    await Promise.all([...this.handles.values()].map(handle => handle.dispose()));
    await Promise.allSettled([...this.pendingTasks]);
    await this.extensions.close();
  }
}

export const name = 'kw-life';
export const inject = ['kwMind', 'kwLagrange', 'llm', 'agents', 'agentPresets', 'sessions', 'sessionPersistence', 'sessionQuery', 'tools', 'systemPrompt', 'schedule', 'jobs', 'hmr', 'profileContext', 'pluginPackages', 'appReady', 'appExit'];
export async function apply(ctx: Context): Promise<void> {
  const life = new Life(ctx);
  ctx.kwMind.beforeClose(() => life.close());
  ctx.on('kw-mind/error', (roleId, error) => life.fail(error, roleId));
  ctx.on('llm/stream', async function* (options, next) {
    const role = life.store.roles().find(role => role.sessionId === options.sessionId);
    if (role && isAgentLoopRequest(options)) { const reason = life.admission(role.id); if (reason) throw new Error(`角色活动已经停止：${reason}`); }
    if (role) {
      const resolved = await ctx.llm.resolveModelInfo(options.provider, options.model, options.signal);
      const estimated = (options.system ? tokens(options.system) : 0) + options.messages.reduce((sum, message) => sum + ('id' in message && message.id ? estimateMessage(message) : ROLE_OVERHEAD + estimateContent(message.content)), 0) + estimateToolsTokens({ config: { provider: options.provider, model: options.model }, tools: options.tools });
      if (resolved.context && estimated + (options.maxTokens ?? resolved.defaultMaxTokens ?? 0) > resolved.context.contextWindow) throw new Error(`实际装配内容超过模型容量：输入估算 ${estimated} Token，模型容量 ${resolved.context.contextWindow} Token`);
      const agent = life.handles.get(role.id)?.agent;
      if (agent && isAgentLoopRequest(options)) appendPluginRecord(agent.session, 'plugin:kwagent/context', { kind: 'request-budget', estimatedTokens: estimated, contextWindow: resolved.context?.contextWindow ?? null });
    }
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: life.config.timeZone }).format(new Date());
    let usedTokens = 0;
    if (role) life.store.addUsage(role.id, day, 0);
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') usedTokens = chunk.usage.totalTokens ?? (chunk.usage.inputTokens ?? 0) + (chunk.usage.outputTokens ?? 0);
        yield chunk;
      }
    } finally { if (role) life.store.addUsage(role.id, day, usedTokens, 0); }
  });
  const listener = (event: Experience) => life.receive(event);
  const lagrange = ctx.kwLagrange;
  lagrange.received.on('event', listener);
  ctx.effect(() => () => lagrange.received.off('event', listener), 'kw-life.events');
  ctx.effect(() => () => life.close(), 'kw-life.lifecycle');
  await life.operations.start();
  ctx.on('schedule/resolve-agent', async (sessionId, next) => {
    const role = life.store.roles().find(role => role.sessionId === sessionId);
    if (!role) return next();
    return (await life.ensure(role.id)).agent;
  });
  ctx.effect(() => ctx.appReady!.onReady(() => life.track(life.start())), 'kw-life.startup');
}
