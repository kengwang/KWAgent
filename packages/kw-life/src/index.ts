import { Context, Service } from '@deepseek-ai/cordis';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import { MessageId, ReasoningEffortId, isAgentLoopRequest } from '@deepseek-ai/dsh-llm';
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
import { asJson, CapabilityError, errorText, now, registerTool, roleInputSchema, roleSchema, publicConfig, redact, tokens, summary, readable, continuityActive, preparePython } from '@kwagent/core';
import type { AppConfig, Experience, Json, Role, RoleInput, Store, ContinuityScene } from '@kwagent/core';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type {} from '@deepseek-ai/dsh-skill';
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
import { registerRolePreset } from './preset.ts';
import { RoleLifecycle } from './lifecycle.ts';
import { readPreinjectSkills } from './preinject.ts';
import { RoleSkills } from './skills.ts';
import { RolePolicy } from './policy.ts';
import { Tasks, taskSchema } from './tasks.ts';
import { retireStepContexts } from './step-context.ts';
import type {} from '@deepseek-ai/dsh-working-directory';
import { workspaceDomainState } from '@deepseek-ai/dsh-workspace';
import type {} from '@deepseek-ai/dsh-storage-domain';

export { Plans, planRequestSchema, timingSchema } from './plans.ts';
export { Extensions, extensionRequestSchema } from './extensions.ts';
export { restoreBackup } from './operations.ts';
declare module '@deepseek-ai/cordis' { interface Context { kwLife: Life } }
declare module '@deepseek-ai/dsh-llm/message' { interface MessageSourceMap { 'kw-event': { kind: 'kw-event'; roleId: string; eventIds: string[] } } }
declare module '@deepseek-ai/dsh-session' { interface PluginRecordMap { 'plugin:kwagent/context': Json; 'plugin:kwagent/payload': Json } }

interface RoleRuntime { state: string; error: string | null; lastActivityAt: string | null }

function roleModel(role: Pick<Role, 'provider' | 'model'> & { reasoningEffort?: string | null }) {
  return { provider: role.provider, model: role.model, ...role.reasoningEffort == null ? {} : { reasoningEffort: ReasoningEffortId(role.reasoningEffort) } };
}

/** 一个角色拥有一个长期 Agent，事件、计划、Panel 和维护命令共享状态控制。 */
export class Life extends Service {
  readonly handles = new Map<string, AgentHandle>();
  readonly runtime = new Map<string, RoleRuntime>();
  readonly plans: Plans;
  readonly extensions: Extensions;
  readonly operations: Operations;
  readonly activities: Activities;
  readonly tasks: Tasks;
  readonly lifecycle: RoleLifecycle;
  readonly roleSkills: RoleSkills;
  readonly policy: RolePolicy;
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
  private readonly stopping = new Map<string, AbortController>();
  private readonly backgroundWork = new Map<string, Promise<void>>();
  private readonly claimed = new Map<string, { turn: number; messages: UserMessage[] }>();
  private readonly prepared = new Map<string, { role: Role; skills: Json[]; identity: Json }>();
  private closing = false;
  private startTask?: Promise<void>;
  private closeTask?: Promise<void>;
  private presetTask?: Promise<void>;
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
    this.tasks = new Tasks(this);
    this.lifecycle = new RoleLifecycle(this);
    this.roleSkills = new RoleSkills(ctx, this.store, this.config.dataRoot);
    this.policy = new RolePolicy(this.store);
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
    await (this.presetTask ??= registerRolePreset(this.ctx));
    await this.ctx.kwMind.models.restore();
    await this.ctx.kwLagrange.start();
    await this.tasks.recover();
    this.started = true;
    this.startupError = null;
    this.extensions.recoverProfile();
    await this.lifecycle.recover();
    await this.repairArchivedSessions();
    for (const role of this.store.roles()) {
      this.store.setMeta(`session-owner:${role.sessionId}`, role.id);
      if (this.lifecycle.phase(role.id)) continue;
      await this.syncContinuity(role.id);
      if (role.state === 'active') {
        try { await this.ensure(role.id); await this.plans.reconcileRole(role.id); this.enqueue(role.id); }
        catch (error) { this.fail(error, role.id); }
      } else await this.plans.reconcileRole(role.id);
    }
  }
  async reasoningOptions(provider: string, model: string) {
    const info = await this.ctx.llm.resolveModelInfo(provider, model);
    return { efforts: info.reasoning?.efforts.map(effort => ({ id: String(effort.id), name: effort.name })) ?? [], defaultEffort: info.reasoning?.defaultEffort ?? null };
  }
  private async validateReasoning(role: Pick<Role, 'provider' | 'model'> & { reasoningEffort?: string | null }): Promise<void> {
    if (role.reasoningEffort == null) return;
    const supported = await this.reasoningOptions(role.provider, role.model);
    if (!supported.efforts.some(effort => effort.id === role.reasoningEffort)) throw new Error(`模型 ${role.provider}/${role.model} 不支持推理等级 ${role.reasoningEffort}；可选：${supported.efforts.map(effort => effort.id).join('、') || '跟随提供商默认值'}`);
  }
  async create(input: RoleInput): Promise<Role> {
    const parsed = this.ctx.kwMind.models.effective(roleInputSchema.parse(input));
    if (parsed.accountId !== 'main') throw new Error('当前 Milky 连接的账号标识为 main');
    await this.validateReasoning(parsed);
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
    this.lifecycle.assertAvailable(id);
    const previous = this.store.role(id);
    const effective = this.ctx.kwMind.models.effective({ ...previous, ...patch });
    await this.validateReasoning(effective);
    const role = this.store.updateRole(id, { ...patch, ...patch.chatPresetId ? { provider: effective.provider, model: effective.model } : {}, ...('persona' in patch || 'selfState' in patch || 'expressionExamples' in patch ? { personaSources: [] } : {}) }, expected, 'owner', '人工修改角色');
    if (role.state !== previous.state) await this.control(id, role.state, false);
    const agent = this.handles.get(id)?.agent;
    if (agent && (role.provider !== previous.provider || role.model !== previous.model || 'reasoningEffort' in patch || 'chatPresetId' in patch)) agent.model.select(roleModel(this.ctx.kwMind.models.effective(role)));
    return this.store.role(id);
  }
  refreshPresetModels(id: string): void {
    for (const role of this.store.roles()) if (role.chatPresetId === id) this.handles.get(role.id)?.agent.model.select(roleModel(this.ctx.kwMind.models.effective(role)));
  }
  async control(roleId: string, state: Role['state'], save = true): Promise<Role> {
    this.lifecycle.assertAvailable(roleId);
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
      this.stopping.get(roleId)?.abort();
      const agent = this.handles.get(roleId)?.agent;
      if (agent?.status === 'running') this.store.setMeta(`wake:${roleId}`, 'pending');
      agent?.cancel({ kind: 'hook', reason: `角色${state}` }, { keepInbox: true });
      await this.tasks.cancelRole(roleId, `角色${state}`);
      await this.dispatchWork.get(roleId);
      await this.backgroundWork.get(roleId);
      await this.plans.pause(roleId);
      await agent?.whenIdle();
      await this.extensions.suspend(roleId);
      this.runtime.set(roleId, { state, error: null, lastActivityAt: now() });
    }
    return role;
  }
  ensure(roleId: string, recoverArchived = true): Promise<AgentHandle> {
    const role = this.store.role(roleId);
    if (recoverArchived) {
      this.lifecycle.assertAvailable(roleId);
      if (this.ctx.workspaceRegistry.archivedSessionIds.includes(SessionId(role.sessionId))) return this.lifecycle.archived(roleId, role.sessionId).then(() => this.ensure(roleId));
    }
    const live = this.handles.get(roleId); if (live) return Promise.resolve(live);
    const pending = this.creating.get(roleId); if (pending) return pending;
    const promise = this.createAgent(roleId).finally(() => this.creating.delete(roleId));
    this.creating.set(roleId, promise);
    return promise;
  }
  async repairArchivedSessions(): Promise<void> {
    for (const role of this.store.roles()) if (!this.lifecycle.phase(role.id) && this.ctx.workspaceRegistry.archivedSessionIds.includes(SessionId(role.sessionId))) {
      try { await this.lifecycle.archived(role.id, role.sessionId); } catch (error) { this.fail(error, role.id); }
    }
  }
  async prepareEmptySession(role: Role): Promise<void> {
    if (await this.ctx.sessionPersistence.stat(SessionId(role.sessionId))) return;
    const cwd = join(this.config.dataRoot, 'workspaces', role.id); await mkdir(cwd, { recursive: true });
    const handle = await this.ctx.agents.create({ sessionId: SessionId(role.sessionId), meta: { cwd, agentPreset: 'kwagent' }, agentOptions: roleModel(this.ctx.kwMind.models.effective(role)) });
    try { await this.sessions.flush(handle.agent.session); } finally { await handle.dispose(); }
  }
  async retireRole(roleId: string): Promise<void> {
    const timer = this.timers.get(roleId); if (timer) clearTimeout(timer); this.timers.delete(roleId);
    this.dispatchAbort.get(roleId)?.abort(); this.stopping.get(roleId)?.abort();
    await this.tasks.cancelRole(roleId, '角色会话管理');
    await this.backgroundWork.get(roleId);
    await this.creating.get(roleId);
    const handle = this.handles.get(roleId);
    const role = this.store.role(roleId);
    for (const job of this.jobs.list(SessionId(role.sessionId))) if (job.owner === role.sessionId && ['running', 'stopping'].includes(job.status)) this.jobs.kill(job.id, SessionId(role.sessionId), '角色会话管理');
    if (handle) {
      for (const message of [...handle.agent.inbox.nextTurn, ...handle.agent.inbox.nextStep]) if (!['kw-event', 'compact-checkpoint', 'model-selection'].includes(String(message.source.kind))) this.store.appendEvent({ id: `deferred:${message.id}`, accountId: role.accountId, roleId, source: String(message.source.kind) === 'schedule' ? 'schedule' : 'system', type: 'deferred-input', occurredAt: now(), scene: null, peerId: null, senderId: null, messageSeq: null, self: false, payload: asJson(message) });
      handle.agent.cancel({ kind: 'hook', reason: '角色会话管理' }, { keepInbox: true });
      await handle.agent.whenIdle();
      await this.extensions.suspend(roleId);
      await this.sessions.flush(handle.agent.session);
      await handle.dispose(); this.handles.delete(roleId);
    }
    // 投递可能正在等待本次会话切换；取消信号会在它写入 Agent 前拦截。
    await this.continuityWork.get(roleId);
    this.contexts.delete(roleId); this.scenes.delete(roleId); this.ctx.kwMind.steps.delete(roleId); this.activities.release(roleId);
    this.policy.release(roleId);
    this.claimed.delete(roleId); this.prepared.delete(roleId);
  }
  private async createAgent(roleId: string): Promise<AgentHandle> {
    await (this.presetTask ??= registerRolePreset(this.ctx));
    const role = this.ctx.kwMind.models.effective(this.store.role(roleId));
    const workspace = join(this.config.dataRoot, 'workspaces', roleId);
    await mkdir(workspace, { recursive: true });
    const python = process.env.KW_CONTAINER === 'true' ? await preparePython(this.config.dataRoot) : null;
    const setup = async (agentCtx: Context, agent: Agent) => {
      installModelSelection(agentCtx);
      await this.ctx.agentPresets.mount(agentCtx, 'kwagent');
      this.ctx.kwMind.attach(agentCtx, roleId);
      await this.ctx.kwLagrange.attach(agentCtx, roleId);
      await this.roleSkills.attach(agentCtx, roleId);
      if (python) agentCtx.systemPrompt.section({ name: 'deployment:kwagent-python', order: 10090, interpolate: false, text: `已配置共享的持久 Python 环境：${python}，所有角色共用依赖。执行 . ${join(this.config.dataRoot, 'python/.venv/bin/activate')} 即可激活，也可直接使用这个 Python 路径；每次 shell 调用单独激活。使用 uv pip install --python ${python} 包名 安装依赖，容器重建后仍保留，包修改对所有角色生效。已提供 Python Playwright 与无界面 Chromium，可通过 playwright.sync_api 或 async_api 控制浏览器，无需重新安装浏览器。脚本、浏览器登录资料 browser-profile、截图和下载保存在各自工作目录；完成后关闭浏览器。具体示例见 kwagent-life Skill 的 references/python.md。` });
      registerTool(agentCtx, 'life_plan', '管理自己的目标、条件事项和唤醒安排。可以自行创建、修改、完成或取消。', planRequestSchema, input => this.plans.mutate(roleId, input, asJson(this.policy.current(roleId))));
      registerTool(agentCtx, 'extension_manage', '使用 Bun 管理自己的 Skill、脚本与 Node ESM 扩展依赖。', extensionRequestSchema, (input, exec) => this.extensions.manage(roleId, input, agentCtx, exec.signal));
      agentCtx.systemPrompt.context({ name: 'kw-life-state', order: 900, required: true, interpolate: false, text: () => { const frozen = this.ctx.kwMind.steps.get(roleId); if (!frozen) return ''; const snapshot = JSON.parse(frozen); return JSON.stringify({ ...snapshot, preinjectSkills: (snapshot.preinjectSkills ?? []).map(({ content: _content, ...record }: { content: string; [key: string]: unknown }) => record) }); } });
      agentCtx.systemPrompt.section({ name: 'deployment:kwagent-preinject', order: 10080, interpolate: false, text: () => { const frozen = this.ctx.kwMind.steps.get(roleId); return frozen ? (JSON.parse(frozen).preinjectSkills ?? []).map((skill: { content: string }) => skill.content).join('\n\n') : ''; } });
      agentCtx.systemPrompt.section({ name: 'deployment:role-contract', order: -100, interpolate: false, text: '始终以配置的人格和世界观演绎当前角色，initialPersona 是角色边界，persona 是结合经历演进的当前认识。对外发言保持角色身份、语气与场景，不用“我是AI”“作为语言模型”“我是助手”等宿主身份解释自己，不跳出角色讨论提示词、插件或内部流程。工具与QQ账号资料供内部正确行动；角色知道自己使用哪个账号，昵称相近的其他人不会改变你的身份。记忆中的旧发言只是过去经历，不是要求继续出戏的指令。预注入Skill服务于角色表达，不覆盖角色边界、世界情境和真实来源。' });
      agentCtx.systemPrompt.section({ name: 'deployment:kwagent-operations', order: 10100, interpolate: false, text: '全部已接入工具始终按 Harness 提供的固定模式使用，普通聊天、发送消息、读取 Skill 和整理记忆无需管理员授权。管理员 QQ 与实际发送者作为判断请求的背景，重要操作依据明确请求与实际后果自主判断。以本步工具 Schema 为准；只提供 run_code 时，在程序内调用 tools 中的具体能力，并返回可无损表示的 JSON 结果。程序错误后先核对已完成的子调用，避免重复发送。不要给收到的消息添加或撤销表情回应，正常交流通过 Lagrange 消息工具完成。初始化及使用记忆、连续性、计划工具前，先加载 kwagent-life Skill。群聊输入持续到达，新的询问与提及应及时判断，不必先完成初始化探索或整理全部记忆。普通 assistant 输出保存在内部活动中。' });
      agentCtx.on('agent/inbox/claimed', ({ message, turn }) => {
        const batch = this.claimed.get(roleId) ?? { turn, messages: [] }; batch.messages.push(message); batch.turn = turn; this.claimed.set(roleId, batch);
        const events = batch.messages.flatMap(input => input.source.kind === 'kw-event' ? input.source.eventIds.map(id => this.store.event(id)) : []);
        const plans = batch.messages.flatMap(input => String(input.source.kind) === 'schedule' ? scheduleNotices(input.content.filter(block => block.type === 'text').map(block => block.text).join('\n')).flatMap(notice => {
          const planId = this.plans.noticePlan(roleId, notice, input.id); return planId ? [planId] : [];
        }) : []);
        this.policy.prepare(roleId, turn, events, plans, true);
      });
      agentCtx.on('system-prompt/assemble', async (assembly, context, next) => {
        if (context.agent !== agent) return next();
        const batch = this.claimed.get(roleId); this.claimed.delete(roleId);
        const events = batch?.messages.flatMap(input => input.source.kind === 'kw-event' ? input.source.eventIds.map(id => this.store.event(id)) : []) ?? [];
        const scene = events.length ? this.sceneFor(events) : batch?.messages.length ? this.sceneFor([]) : this.scenes.get(roleId) ?? this.sceneFor([]);
        const identity = await this.ctx.kwLagrange.identityContext(roleId, scene.contexts, context.signal);
        const directories = agent.ctx.get('workingDirectory'); if (!directories) throw new Error('角色工作目录服务尚未加载');
        const skills = await readPreinjectSkills(this.store, roleId, this.ctx.skills, { cwd: await directories.ensure(agent, context.signal), signal: context.signal, scope: agent });
        const role = this.ctx.kwMind.models.effective(this.store.role(roleId)); this.prepared.set(roleId, { role, skills, identity });
        assembly.sections = assembly.sections.map(section => section.name === 'deployment:persona-prefix' ? { ...section, text: role.persona } : section.name === 'deployment:kwagent-preinject' ? { ...section, text: skills.map(skill => (skill as { content: string }).content).join('\n\n') } : section);
        return next();
      });
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
          if (message.source.kind === 'kw-event' && message.source.eventIds.length && message.source.eventIds.every(id => { const event = this.store.event(id); return event.type === 'background-result' && this.store.deliveryStatus(id).state === 'completed'; })) continue;
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
        // 重复通知可以被过滤，当前 turn 的工具结果仍需进入下一模型步骤。
        if (hadInput && !payload.messages.length && payload.step === 1) { this.policy.release(roleId); return { kind: 'reject' }; }
        if (payload.messages.length) this.contexts.set(roleId, await this.ctx.kwMind.context(roleId, [scene.query, ...scheduleContext].filter(Boolean).join('\n'), payload.signal));
        this.scenes.set(roleId, scene);
        await this.syncContinuity(roleId);
        const prepared = this.prepared.get(roleId); if (!prepared) throw new Error('当前步骤尚未准备角色与Skill');
        const authorization = this.policy.prepare(roleId, payload.turn, sceneEvents, scene.planIds, hadInput);
        const frozen = this.ctx.kwMind.freeze(roleId, this.contexts.get(roleId) ?? '{"memories":[]}', scene, this.ctx.kwLagrange.socialContext(roleId, scene.contexts), prepared.skills, prepared.identity, authorization, prepared.role);
        const ref = await this.ctx.kwMind.payloads.put(roleId, `step:${role.sessionId}:${payload.turn}:${payload.step}`, asJson(JSON.parse(frozen)), payload.signal);
        appendPluginRecord(payload.agent.session, 'plugin:kwagent/context', asJson({ roleId, turn: payload.turn, step: payload.step, ...ref, estimatedTokens: tokens(frozen), inputs: payload.messages.map(message => message.id) }));
        const activity = this.activities.current(roleId); if (activity) this.store.link(activity.id, 'context', `${payload.turn}:${payload.step}`, asJson(ref));
        retireStepContexts(payload.agent.session, payload.turn, payload.step);
        return next();
      });
      agentCtx.tools.guard(() => this.admission(roleId) ?? undefined);
      agentCtx.on('agent/turn-stopping', async payload => {
        await this.ctx.sessions.flush(payload.agent.session);
      });
      agentCtx.on('agent/status', ({ status }) => {
        if (this.runtime.get(roleId)?.state === 'error') return;
        this.runtime.set(roleId, { state: this.admission(roleId) ?? (status === 'running' ? 'running' : 'waiting'), error: null, lastActivityAt: now() });
        this.store.changes.emit('change', this.store.revision());
        if (status === 'idle' && this.store.pending(roleId).length) this.enqueue(roleId);
        else if (status === 'idle') this.track(this.consolidateInBackground(roleId), roleId);
      });
      agentCtx.on('agent/error', ({ error }) => { this.store.recoverDeliveries(roleId, [...this.activities.accepted.get(roleId) ?? []]); this.fail(error, roleId); });
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
        if (event.type === 'agent/inbox/spliced') queueMicrotask(() => { if (agent.inbox.nextStep.length || agent.inbox.nextTurn.length) this.stopping.get(roleId)?.abort(); });
        this.activities.event(roleId, role.sessionId, event);
        if (event.type === 'assistant/message') this.store.appendEvent({ id: `assistant:${roleId}:${role.sessionId}:${event.seq}`, accountId: role.accountId, roleId, source: 'system', type: 'internal-activity', occurredAt: new Date(event.time).toISOString(), scene: null, peerId: null, senderId: null, messageSeq: null, self: true, payload: asJson(event.data) });
        if (event.type === 'tool/result') this.track(this.tasks.consume(roleId, String(event.data.message.toolCallId), !event.data.message.isError), roleId);
        if (event.type === 'user/message' && event.data.source.kind === 'kw-event') for (const id of event.data.source.eventIds) {
          const input = this.store.event(id);
          if (input.type === 'background-result' && input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) && typeof input.payload.taskId === 'string') {
            const task = this.tasks.read(roleId, input.payload.taskId);
            if (task.callId) this.track(this.tasks.consume(roleId, task.callId, task.state === 'completed', true), roleId);
          }
        }
        } catch (error) { this.fail(error, roleId); throw error; }
      });
      if (this.store.role(roleId).state === 'active' && !this.maintenance) await this.extensions.restore(roleId, agentCtx);
    };
    const exists = await this.ctx.sessionPersistence.stat(SessionId(role.sessionId));
    const agentOptions = roleModel(role);
    const handle = exists
      ? await this.ctx.agents.resume({ resumeSessionId: SessionId(role.sessionId), agentOptions, setup })
      : await this.ctx.agents.create({ sessionId: SessionId(role.sessionId), meta: { cwd: workspace, agentPreset: 'kwagent' }, agentOptions, setup });
    this.handles.set(roleId, handle);
    const currentRole = this.ctx.kwMind.models.effective(this.store.role(roleId));
    if (currentRole.provider !== role.provider || currentRole.model !== role.model || currentRole.reasoningEffort !== role.reasoningEffort || currentRole.reasoningEffort !== null) handle.agent.model.select(roleModel(currentRole));
    if (currentRole.state !== 'active' || this.maintenance) await this.extensions.suspend(roleId);
    const recovered = await this.ctx.sessionQuery.readSession(SessionId(role.sessionId));
    this.activities.restore(roleId, recovered.events);
    this.store.recoverDeliveries(roleId, [...this.activities.accepted.get(roleId)!]);
    for (const activity of this.store.list('activity', activitySchema, roleId, 200)) if (activity.state === 'running') this.store.put('activity', activity.id, roleId, asJson({ ...activity, state: 'interrupted', endedAt: now(), revision: activity.revision + 1 }), activity.revision, 'system', '恢复未完成活动');
    this.store.setMeta(`activity:${roleId}`, '');
    if (!exists) this.store.appendEvent({ id: `init:${roleId}`, accountId: role.accountId, roleId, source: 'system', type: 'initialize', occurredAt: now(), scene: null, peerId: null, senderId: null, messageSeq: null, self: false, payload: { instruction: '认识当前环境与可用工具，自主决定自己的目标、活动和后续安排。' } });
    return handle;
  }
  private day(): string { return new Intl.DateTimeFormat('en-CA', { timeZone: this.config.timeZone }).format(new Date()); }
  async retryDeferredMemory(roleId: string): Promise<void> {
    const status = this.ctx.kwMind.consolidationStatus(roleId);
    if (!status || status.status !== 'deferred' || (status.retryAt ?? Infinity) > Date.now()) return;
    await this.consolidateInBackground(roleId);
  }
  private consolidateInBackground(roleId: string): Promise<void> {
    const existing = this.backgroundWork.get(roleId); if (existing) return existing;
    const task = this.runBackgroundConsolidation(roleId).finally(() => this.backgroundWork.delete(roleId));
    this.backgroundWork.set(roleId, task); return task;
  }
  private async runBackgroundConsolidation(roleId: string): Promise<void> {
    const status = this.ctx.kwMind.consolidationStatus(roleId);
    const handle = this.handles.get(roleId);
    if (status?.retryAt && status.retryAt > Date.now() || this.admission(roleId) || !handle || handle.agent.status !== 'idle' || this.stopping.has(roleId) || !this.store.unprocessed(roleId, 1).length || this.store.pending(roleId, 1).length || handle.agent.inbox.nextTurn.length || handle.agent.inbox.nextStep.length) return;
    const controller = new AbortController(); this.stopping.set(roleId, controller);
    try { await this.ctx.kwMind.consolidate(handle.agent, roleId, controller.signal); if (!controller.signal.aborted && !this.admission(roleId)) await this.syncContinuity(roleId); }
    catch (error) { if (!controller.signal.aborted) throw error; }
    finally { if (this.stopping.get(roleId) === controller) this.stopping.delete(roleId); }
  }
  admission(roleId: string): string | null {
    if (this.closing || this.maintenance) return 'maintenance';
    if (this.lifecycle.phase(roleId)) return this.lifecycle.phase(roleId)!;
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
    if (['completed', 'accepted', 'queued'].includes(this.store.deliveryStatus(event.id).state)) return;
    for (const plan of this.store.plans(event.roleId)) {
      if (plan.kind !== 'condition' || plan.status !== 'active' || !plan.condition) continue;
      if (plan.condition.eventTypes.length && !plan.condition.eventTypes.includes(event.type)) continue;
      if (plan.condition.peerIds.length && (event.peerId === null || !plan.condition.peerIds.includes(event.peerId))) continue;
      this.store.appendEvent({ id: `condition:${plan.id}:${event.id}`, accountId: event.accountId, roleId: event.roleId, source: 'system', type: 'condition-candidate', occurredAt: now(), scene: event.scene, peerId: event.peerId, senderId: null, messageSeq: null, self: false, payload: { planId: plan.id, sourceEventId: event.id, condition: plan.condition.text, instruction: plan.instruction, context: plan.context, sources: plan.sources } });
    }
    this.enqueue(event.roleId);
  }
  enqueue(roleId: string): void {
    if (this.store.pending(roleId, 1).length) this.stopping.get(roleId)?.abort();
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
      let events = batch.events;
      if (!events.length && this.store.meta(`wake:${roleId}`) === 'pending') {
        const role = this.store.role(roleId);
        events.push(this.store.appendEvent({ accountId: role.accountId, roleId, source: 'system', type: 'resume-activity', occurredAt: now(), scene: null, peerId: null, senderId: null, messageSeq: null, self: false, payload: { instruction: '活动条件已经恢复，请结合已保存的输入与执行记录决定是否继续。' } }).event);
      }
      if (!events.length) return;
      for (let index = events.length - 1; index >= 0; index--) {
        const event = events[index]!;
        if (event.type === 'background-result' && event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) && typeof event.payload.taskId === 'string' && this.tasks.awaitingRead(event.payload.taskId)) { events.splice(index, 1); continue; }
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
      const messageId = batch.messageId ?? `kw-${createHash('sha256').update(events.map(event => event.id).join('\n')).digest('hex')}`;
      const ids = events.map(event => event.id);
      const alreadyInSession = this.activities.accepted.get(roleId)?.has(messageId) || [...handle.agent.inbox.nextTurn, ...handle.agent.inbox.nextStep].some(message => message.id === messageId);
      if (alreadyInSession) { this.store.delivery(ids, messageId, 'delivered'); return; }
      const frame = await preparePerception(this.store, this.ctx.kwMind.payloads, roleId, events, messageId, this.config.budgets.perception, controller.signal);
      this.store.delivery(ids, messageId, 'prepared');
      const attachments = (await Promise.all(events.map(event => event.type === 'background-result' && event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) && typeof event.payload.taskId === 'string' ? this.tasks.deferred(roleId, event.payload.taskId, controller.signal) : Promise.resolve([])))).flat();
      const message: UserMessage = {
          id: MessageId(messageId), role: 'user', source: { kind: 'kw-event', roleId, eventIds: ids },
          content: [{ type: 'text', text: JSON.stringify(frame) }, ...attachments],
      };
      handle.agent.steer(message);
      await this.ctx.sessions.flush(handle.agent.session);
      this.store.delivery(ids, messageId, 'delivered');
      this.store.setMeta(`wake:${roleId}`, 'delivered');
    } catch (error) { if (!controller.signal.aborted) throw error; }
    finally { this.dispatching.delete(roleId); this.dispatchAbort.delete(roleId); if (this.store.pending(roleId, 1).length && !this.admission(roleId)) this.enqueue(roleId); }
  }
  manual(roleId: string, text: string, type = 'manual', details?: { context?: { scene: 'group' | 'private'; peerId: number }; sender?: { id: number; nickname?: string } }): Experience {
    const role = this.store.role(roleId);
    const event = this.store.appendEvent({ accountId: role.accountId, roleId, source: 'manual', type, occurredAt: now(), scene: details?.context?.scene ?? null, peerId: details?.context?.peerId ?? null, senderId: details?.sender?.id ?? null, messageSeq: null, self: false, payload: asJson({ text, ...(details?.sender ? { sender: details.sender } : {}) }) }).event;
    this.enqueue(roleId);
    return event;
  }
  private sceneFor(events: Experience[]): ContinuityScene {
    const taskPeople = events.filter(event => event.source === 'system' && event.type === 'background-result').flatMap(event => z.object({ people: z.array(z.string()).default([]) }).parse(event.payload).people);
    return { eventIds: events.map(event => event.id), people: [...new Set([...taskPeople, ...events.flatMap(event => event.senderId ? [String(event.senderId)] : event.scene === 'private' && event.peerId ? [String(event.peerId)] : [])])], contexts: [...new Map(events.flatMap(event => event.scene && event.peerId && ['group', 'private'].includes(event.scene) ? [[`${event.scene}:${event.peerId}`, { scene: event.scene as 'group' | 'private', peerId: event.peerId }] as const] : [])).values()], planIds: [], recordIds: [], query: events.map(event => JSON.stringify(readable(event.payload))).join('\n').slice(0, 4000) };
  }
  quiesce(): Promise<void> {
    this.maintenance = true;
    this.maintenanceTask ??= this.hold();
    return this.maintenanceTask;
  }
  private async hold(): Promise<void> {
    for (const controller of this.stopping.values()) controller.abort();
    await Promise.all([...this.backgroundWork.values()]);
    await this.operations.drain();
    await this.lifecycle.whenIdle();
    await this.plans.suspend();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const controller of this.dispatchAbort.values()) controller.abort();
    await Promise.allSettled([...this.dispatchWork.values()]);
    for (const role of this.store.roles()) {
      await this.tasks.cancelRole(role.id, '服务器维护');
      for (const job of this.jobs.list(SessionId(role.sessionId))) if (job.owner === role.sessionId && ['running', 'stopping'].includes(job.status)) this.jobs.kill(job.id, SessionId(role.sessionId), '服务器维护');
    }
    for (const [roleId, handle] of this.handles) { if (handle.agent.status === 'running') this.store.setMeta(`wake:${roleId}`, 'pending'); handle.agent.cancel({ kind: 'hook', reason: '服务器维护' }, { keepInbox: true }); }
    await Promise.all([...this.handles.values()].map(async handle => { await handle.agent.whenIdle(); await this.sessions.flush(handle.agent.session); }));
    await this.extensions.close();
  }
  async resume(): Promise<void> { if (this.closing) return; await this.maintenanceTask; this.maintenanceTask = undefined; this.maintenance = false; await this.repairArchivedSessions(); await this.plans.resume(); for (const role of this.store.roles()) if (role.state === 'active') { const handle = await this.ensure(role.id); await this.extensions.restore(role.id, handle.agent.ctx); this.enqueue(role.id); } }
  snapshot(roleId?: string): Json {
    const preview = <T>(items: T[]) => items.slice(0, 50).map(item => summary(item, this.config.budgets.panelBodyBytes));
    const value = { revision: this.store.revision(), rolesGeneration: Number(this.store.meta('roles-generation') ?? 0), version: APP_VERSION, maintenance: this.maintenance, started: this.started, startupError: this.startupError,
      roles: preview(this.store.roles().sort((a, b) => Number(b.id === roleId) - Number(a.id === roleId)).map(role => ({ ...role, memoryStatus: this.ctx.kwMind.consolidationStatus(role.id), runtime: this.runtime.get(role.id) ?? { state: role.state, error: null, lastActivityAt: null }, usage: this.store.usage(role.id, this.day()) }))),
      activities: preview(this.store.list('activity', activitySchema, roleId, 50)), tasks: preview(this.store.list('async-task', taskSchema, roleId, 50)), events: preview(this.store.events(roleId, 50).map(event => ({ ...event, delivery: this.store.deliveryStatus(event.id) }))), memories: preview(roleId ? this.store.memories(roleId, 50) : []), plans: preview(this.store.plans(roleId)), operations: preview(this.store.operations(roleId, 50)),
      extensions: preview(this.store.extensions(roleId)), connections: { mcp: this.ctx.kwLagrange.client.status, events: this.ctx.kwLagrange.events.status }, config: publicConfig(this.config), truncated: false };
    const lists: unknown[][] = [value.roles, value.activities, value.tasks, value.events, value.memories, value.plans, value.operations, value.extensions];
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
export const inject = ['kwMind', 'kwLagrange', 'llm', 'agents', 'agentPresets', 'sessions', 'sessionPersistence', 'sessionQuery', 'tools', 'systemPrompt', 'skills', 'schedule', 'jobs', 'ptcRuntime', 'hmr', 'profileContext', 'pluginPackages', 'workspaceRegistry', 'appReady', 'appExit'];
export async function apply(ctx: Context): Promise<void> {
  const skillPath = fileURLToPath(new URL('../skills/kwagent-life/SKILL.md', import.meta.url));
  ctx.skills.register({ name: 'kwagent-life', description: 'KWAgent 初始化、实时交流、记忆与连续性参数、来源及生活安排。初始化和使用内部工具时读取。', content: await readFile(skillPath, 'utf8'), source: 'runtime', path: skillPath, resourceBase: { kind: 'directory', path: fileURLToPath(new URL('../skills/kwagent-life/', import.meta.url)) } });
  const life = new Life(ctx);
  ctx.kwMind.beforeClose(() => life.close());
  ctx.on('kw-mind/error', (roleId, error) => life.fail(error, roleId));
  ctx.on('llm/stream', async function* (options, next) {
    const role = life.store.roles().find(role => role.sessionId === options.sessionId);
    if (role && isAgentLoopRequest(options)) { const reason = life.admission(role.id); if (reason) throw new Error(`角色活动已经停止：${reason}`); }
    if (role) {
      const resolved = await ctx.llm.resolveModelInfo(options.provider, options.model, options.signal);
      const estimated = (options.system ? tokens(options.system) : 0) + options.messages.reduce((sum, message) => sum + ('id' in message && message.id ? estimateMessage(message) : ROLE_OVERHEAD + estimateContent(message.content)), 0) + estimateToolsTokens({ config: { provider: options.provider, model: options.model }, tools: options.tools });
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
  ctx.on('domain/changed', change => {
    if (!life.started || life.maintenance || change.domain !== 'workspace' || change.table !== '' || change.operation !== 'put') return;
    const archived = workspaceDomainState.parse(change.value).archivedSessionIds;
    for (const role of life.store.roles()) if (!life.lifecycle.phase(role.id) && archived.includes(SessionId(role.sessionId))) life.track(life.lifecycle.archived(role.id, role.sessionId), role.id);
  });
  ctx.on('schedule/resolve-agent', async (sessionId, next) => {
    const id = life.store.roles().find(role => role.sessionId === sessionId)?.id ?? life.store.meta(`session-owner:${sessionId}`);
    if (!id) return next();
    const role = life.store.role(id);
    if (role.sessionId !== sessionId) throw new CapabilityError('原会话的定时唤醒已经失效');
    if (life.admission(id)) throw new CapabilityError('角色当前不接纳定时唤醒');
    if (life.context.workspaceRegistry.archivedSessionIds.includes(SessionId(role.sessionId))) {
      life.track(life.lifecycle.archived(role.id, role.sessionId), role.id);
      throw new CapabilityError('旧会话已归档，角色正在准备新会话');
    }
    return (await life.ensure(role.id)).agent;
  });
  ctx.effect(() => ctx.appReady!.onReady(() => life.track(life.start())), 'kw-life.startup');
}
