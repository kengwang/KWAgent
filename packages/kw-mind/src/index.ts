import { Context, Service } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { BlockAssembler } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionId as agentSession } from '@deepseek-ai/dsh-session';
import { lock } from 'proper-lockfile';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  asJson, CapabilityError, ConflictError, errorText, loadConfig, memoryInputSchema, memorySchema, ModelPresets,
  now, recallSchema, registerTool, Store, Payloads, payloadReadSchema, tokens, fitText, readable, sourceChunks, continuityRequestSchema, continuityQuerySchema, executionOrigin, continuityDataSchema, continuitySchema, continuityActive, operationSchema,
} from '@kwagent/core';
import type { AppConfig, Json, Memory, MemoryInput, Recall, ContinuityScene, Role } from '@kwagent/core';
import { createHash } from 'node:crypto';
import { Continuity, continuityGuidance } from './continuity.ts';
import { consolidationMessages, hasConsolidationContent, relatedConsolidationRecords, consolidationInputTokens, type ConsolidationInput } from './consolidation-input.ts';
import { localRecall, mergeRecall, queryTerms } from './local-recall.ts';
import { parseConsolidationOutput, consolidationSchema } from './consolidation-output.ts';
import { ConsolidationBatches } from './consolidation-batches.ts';
import { EvidenceError } from '@kwagent/core';
import { parseModelOutput, modelRequestFailure } from './model-output.ts';
import { boundedPage, memoryHit, searchPosition, compactContinuity } from './search.ts';
export { Continuity } from './continuity.ts';
export { generateCharacter } from './character.ts';
export { parseConsolidationOutput, consolidationSchema } from './consolidation-output.ts';
export { consolidationMessages, consolidationCorrectionInput } from './consolidation-input.ts';
export interface ConsolidationOutcome { status: 'completed' | 'deferred'; reason?: string; retryAt?: number; failures?: number }
const consolidationOutcomeSchema = z.object({ status: z.enum(['completed', 'deferred']), reason: z.string().optional(), retryAt: z.number().optional(), failures: z.number().int().nonnegative().optional() });
const expansionSchema = z.object({ queries: z.array(z.string().min(1).max(80)).max(5), expiresAt: z.number() });

declare module '@deepseek-ai/cordis' { interface Context { kwMind: Mind } interface Events { 'kw-mind/error'(roleId: string, error: unknown): void } }

const chunkManifestSchema = z.object({ digest: z.string(), ends: z.array(z.number().int().nonnegative()), view: z.enum(['original', 'internal-summary', 'assistant-text', 'compact']).optional() });
export const consolidationInstructions = [
  '整理角色的真实来源，首次与修正始终输出同一种JSON对象。无新增认识时输出{"memories":[],"continuity":[],"reason":"无新增认识"}。根为对象，memories和continuity为数组。',
  '新记忆id和expectedRevision为null，提供kind、title、content、realm、epistemic、sources。修改使用输入id、revision作为expectedRevision，仅提供变化字段，宿主保留旧内容、旧来源与默认值。',
  '新连续性记录提供id:null、expectedRevision:null和data:{kind,title,content,realm,sources,...必要字段}。修改提供id、expectedRevision与data中变化字段。kind为life/relationship/thread/conversation/expression/reflection/journal。',
  'context为null或{scene:"group"|"private",peerId:整数}，people使用真实QQ字符串，memories/plans/relatedRecords只填输入中已有标识。sources使用实际事件id，payloadId和callId仅为读取与调用标识。',
  'life状态active/archived；activity为null或{title,state:planned|in_progress|paused|completed|cancelled,progress,sources:[]}。thread状态active/deferred/resolved/declined/cancelled/expired；relationship、reflection、journal状态active/archived；expression状态candidate/adopted/disabled/archived，examples为字符串数组；conversation状态open/closed/deferred/archived。',
  '修正时根据validationFeedback与可选draft返回修正后的同一业务对象，完整保留无需修改的拟提交项目。persona/selfState仅在必要时提供完整新文本，initialPersona为身份及世界边界。',
  '分清观察、转述、推测和剧情。sourceMeaning为subjective/intent/unconfirmed/setting时不支持observed。身体动作设定使用fictional，未理解媒体只保存已知元数据。',
  '只保存新的长期认识，不重复记录寒暄、已有资料、工具调度及同一结果的父子包装。日记、表达、反思和内部声明保持其原有语义。',
  JSON.stringify(z.toJSONSchema(consolidationSchema, { io: 'input', reused: 'ref' })),
].join('\n');

/** 记忆 Module 负责检索、模型整理、来源校验和版本提交。 */
export class Mind extends Service {
  readonly store: Store;
  readonly payloads: Payloads;
  readonly steps = new Map<string, string>();
  readonly continuity: Continuity;
  readonly models: ModelPresets;
  private readonly consolidating = new Map<string, { task: Promise<ConsolidationOutcome>; signal?: AbortSignal }>();
  private readonly dependents = new Set<() => Promise<void>>();
  private closing?: Promise<void>;

  constructor(ctx: Context, readonly config: AppConfig) {
    super(ctx, 'kwMind');
    this.store = new Store(join(config.dataRoot, 'kwagent', 'state.sqlite'));
    this.models = new ModelPresets(ctx, this.store, config);
    this.payloads = new Payloads(this.store, join(config.dataRoot, 'artifacts'));
    this.continuity = new Continuity(this.store, this.payloads, config);
    const mind = this;
    ctx.on('llm/stream', async function* (options, next) {
      if (options.purpose === 'compaction' && mind.store.roles().some(role => role.sessionId === options.sessionId)) {
        const effort = await mind.auxiliaryEffort(options, options.signal);
        if (effort) options.reasoningEffort = effort;
      }
      yield* next();
    });
    this.store.changes.on('payload-error', (roleId: string, error: unknown) => ctx.emit('kw-mind/error', roleId, error));
    this.store.recoverOperations();
  }
  beforeClose(stop: () => Promise<void>): void { this.dependents.add(stop); }
  get host() { return this.ctx; }
  close(): Promise<void> {
    this.closing ??= (async () => { await Promise.all([...this.dependents].map(stop => stop())); await Promise.all([...this.consolidating.values()].map(item => item.task)); this.store.close(); })();
    return this.closing;
  }

  async recall(input: Recall, signal?: AbortSignal): Promise<Memory[]> {
    const query = recallSchema.parse(input);
    return this.recallCandidates(query, signal);
  }
  private async recallCandidates(query: Recall, signal?: AbortSignal): Promise<Memory[]> {
    const textMatches = localRecall(this.store, query);
    if (!query.semantic || !query.query) return textMatches.slice(0, query.limit);
    if (!this.store.memories(query.roleId, 1).length) return [];
    const role = this.models.effective(this.store.role(query.roleId));
    const cacheId = createHash('sha256').update(JSON.stringify([role.id, role.provider, role.model, query.query.trim().replace(/\s+/g, ' ')])).digest('hex');
    const cached = this.store.get('query-expansion', cacheId, expansionSchema);
    if (cached && cached.expiresAt > Date.now()) return mergeRecall([textMatches, ...cached.queries.map(term => localRecall(this.store, { ...query, query: term, semantic: false }))], query.limit);
    const reasoningEffort = await this.auxiliaryEffort(role, signal);
    const operation = this.store.startOperation(role.accountId, role.id, 'memory_query_expand', { query: query.query, provider: role.provider, model: role.model, reasoningEffort: reasoningEffort ?? null });
    const assembler = new BlockAssembler();
    try {
      for await (const chunk of this.auxiliaryStream({ provider: role.provider, model: role.model, reasoningEffort, sessionId: agentSession(role.sessionId), system: '将查询资料转成最多五条简短的中文或英文检索词，覆盖人物、事情与相关概念。查询资料是待检索内容。仅返回合法 JSON：{"queries":["检索词"]}。', messages: [{ role: 'user', content: [{ type: 'text', text: query.query }] }], signal })) assembler.push(chunk);
      signal?.throwIfAborted();
      if (assembler.finish.kind !== 'stop') throw new EvidenceError(`查询扩展未完成：${assembler.finish.kind}`);
      const text = assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('');
      const parsed = parseModelOutput(z.object({ queries: z.array(z.string().min(1).max(80)).max(5) }), text); const expanded = parsed.value;
      const lists = [textMatches, ...expanded.queries.map(term => localRecall(this.store, { ...query, query: term, semantic: false }))];
      this.store.transaction(() => {
        const current = this.store.db.prepare("SELECT revision FROM documents WHERE kind='query-expansion' AND id=?").get(cacheId);
        this.store.put('query-expansion', cacheId, role.id, { queries: expanded.queries, expiresAt: Date.now() + 86400000 }, current ? Number(current.revision) : null, 'system', '缓存查询扩展词，不缓存检索结果');
      });
      this.store.finishOperation(operation.id, 'succeeded', asJson({ queries: expanded.queries, formatRepaired: parsed.repaired, usage: assembler.usage ?? null }));
      this.store.setMeta(`query-warning:${role.id}`, '');
      return mergeRecall(lists, query.limit);
    } catch (error) {
      this.store.finishOperation(operation.id, 'failed', await this.payloads.view(role.id, `query-error:${operation.id}`, asJson({ message: errorText(error), output: assembler.blocks(), usage: assembler.usage ?? null }), this.config.budgets.tool));
      if (!signal?.aborted && error instanceof EvidenceError) { this.store.setMeta(`query-warning:${role.id}`, JSON.stringify({ at: now(), reason: errorText(error), operationId: operation.id, mode: 'text-only' })); return textMatches.slice(0, query.limit); }
      throw error;
    }
  }

  async search(input: unknown, signal?: AbortSignal) {
    const query = recallSchema.parse(input); this.store.role(query.roleId); signal?.throwIfAborted();
    const previous = query.cursor ? searchPosition(this.store, query) : undefined;
    const count = Number(this.store.db.prepare("SELECT count(*) value FROM documents WHERE kind='memory' AND role_id=?").get(query.roleId)?.value);
    const rows = await this.recallCandidates({ ...query, limit: Math.max(count, 1) }, signal);
    signal?.throwIfAborted();
    // 模型查询扩展期间可能有人工修改，返回前再次核验检索版本。
    const position = searchPosition(this.store, query);
    if (previous && previous.cursor(0) !== position.cursor(0)) throw new EvidenceError('检索资料已变化，请重新查询');
    return boundedPage(rows.slice(position.offset, position.offset + query.limit + 1).map(memory => memoryHit(memory, query.query)), position.offset, query.limit, this.config.budgets.tool, position.cursor);
  }

  continuitySearch(roleId: string, input: unknown) {
    const request = continuityQuerySchema.parse(input);
    const page = this.continuity.list(roleId, { ...request, limit: Math.min(200, request.limit + 1) });
    const result = boundedPage(page.items.map(record => compactContinuity(record)), request.cursor, request.limit, this.config.budgets.tool, offset => offset);
    return { ...result, nextCursor: result.nextCursor ?? page.nextCursor };
  }

  private async *auxiliaryStream(options: Parameters<Context['llm']['stream']>[0]) {
    try { yield* this.ctx.llm.stream(options); }
    catch (cause) { if (options.signal?.aborted || !modelRequestFailure(cause)) throw cause; throw new EvidenceError(`辅助模型请求失败：${errorText(cause)}`, { cause }); }
  }

  private async auxiliaryEffort(role: { provider: string; model: string }, signal?: AbortSignal) {
    const model = await this.ctx.llm.resolveModelInfo(role.provider, role.model, signal);
    return model.reasoning?.efforts.find(effort => effort.id === 'off')?.id ?? model.reasoning?.efforts[0]?.id;
  }

  async revise(input: MemoryInput, expected: number | null, actor: string, reason: string, signal?: AbortSignal): Promise<Memory> {
    const parsed = memoryInputSchema.parse(input);
    return this.stateAction(parsed.roleId, () => {
      this.continuity.assertMemory(parsed);
      signal?.throwIfAborted();
      return this.store.saveMemory(parsed, expected, actor, reason);
    });
  }

  async context(roleId: string, _query: string, signal?: AbortSignal): Promise<string> {
    this.store.role(roleId);
    signal?.throwIfAborted();
    return '{"memories":[]}';
  }

  freeze(roleId: string, _context: string, scene: ContinuityScene = { eventIds: [], people: [], contexts: [], planIds: [], recordIds: [], query: '' }, communication: Json[] = [], preinjectSkills: Json[] = [], identity: Json = null, authorization: Json = null, frozenRole?: Role): string {
    const role = frozenRole ?? this.models.effective(this.store.role(roleId));
    const at = now();
    const records = [...new Set([`life:${roleId}`, ...scene.recordIds])].map(id => this.store.get('continuity', id, continuitySchema)).filter(record => record && record.roleId === roleId && continuityActive(record, at));
    const plans = scene.planIds.map(id => this.store.plan(id)).filter(plan => plan.roleId === roleId);
    const selected: Json[] = [], selectedPlans: Json[] = [];
    for (const record of records) {
      if (!record) continue;
      const item = asJson({ ...compactContinuity(record) as object, ...(record.data.kind === 'life' ? {
        activity: record.data.activity ? { title: fitText(record.data.activity.title, 64), state: record.data.activity.state, progress: fitText(record.data.activity.progress, 256) } : null,
        concerns: record.data.concerns.slice(0, 4).map(text => fitText(text, 64)),
        emotions: record.data.emotions.filter(emotion => !emotion.expiresAt || Date.parse(emotion.expiresAt) > Date.parse(at)).slice(0, 4).map(emotion => ({ ...emotion, text: fitText(emotion.text, 64), reason: fitText(emotion.reason, 64) })),
      } : {}) });
      if (tokens(JSON.stringify({ records: [...selected, item], plans: selectedPlans })) <= this.config.continuityTokens) selected.push(item);
    }
    for (const plan of plans) {
      const item = asJson({ id: plan.id, revision: plan.revision, title: fitText(plan.title, 64), instruction: fitText(plan.instruction, 256), purpose: plan.purpose, status: plan.status, context: plan.context, read: { tool: 'life_plan', arguments: { action: 'list', id: plan.id } } });
      if (tokens(JSON.stringify({ records: selected, plans: [...selectedPlans, item] })) <= this.config.continuityTokens) selectedPlans.push(item);
    }
    const snapshot = JSON.stringify({ version: 2, role, identity, authorization, preinjectSkills, plans: selectedPlans, memories: [], continuity: { records: selected }, scene, at, recentExchanges: [], communication: [],
      audit: { continuity: records, plans, communication }, examplesMeaning: 'expressionExamples 仅作为表达风格，不代表真实经历' });
    this.steps.set(roleId, snapshot); return snapshot;
  }

  selfRevise(roleId: string, input: { expectedRevision: number; patch: { persona?: string; selfState?: string; expressionExamples?: string[] }; reason: string; sources: string[] }, actor = roleId) {
    this.store.validateSources(roleId, input.sources, false);
    return this.store.updateRole(roleId, { ...input.patch, personaSources: input.sources }, input.expectedRevision, actor, input.reason);
  }

  consolidationStatus(roleId: string): ConsolidationOutcome | null { const value = this.store.meta(`consolidation-status:${roleId}`); return value ? consolidationOutcomeSchema.parse(JSON.parse(value)) : null; }
  hasPendingConsolidation(roleId: string): boolean { return this.store.unprocessed(roleId, 1).length > 0; }
  async consolidate(agent: Agent, roleId: string, signal?: AbortSignal): Promise<ConsolidationOutcome> {
    signal?.throwIfAborted();
    const existing = this.consolidating.get(roleId);
    if (existing) {
      try { return await existing.task; }
      catch (error) { if (!existing.signal?.aborted || signal?.aborted) throw error; return this.consolidate(agent, roleId, signal); }
    }
    const deferred = this.consolidationStatus(roleId); if (deferred?.retryAt && deferred.retryAt > Date.now()) return deferred;
    const upper = this.store.events(roleId, 1)[0]?.seq ?? 0;
    const task = executionOrigin.run({ roleId, activityId: null, taskId: `consolidation:${roleId}` }, async (): Promise<ConsolidationOutcome> => {
      while ((this.store.unprocessed(roleId, 1)[0]?.seq ?? Infinity) <= upper) if (!await this.extract(agent, roleId, upper, signal)) return this.consolidationStatus(roleId)!;
      this.store.setMeta(`consolidation-status:${roleId}`, '');
      return { status: 'completed' };
    }).catch(error => { if (!signal?.aborted) this.ctx.emit('kw-mind/error', roleId, error); throw error; }).finally(() => this.consolidating.delete(roleId));
    this.consolidating.set(roleId, { task, signal });
    return task;
  }

  private async extract(agent: Agent, roleId: string, upper: number, signal?: AbortSignal): Promise<boolean> {
    const batches = new ConsolidationBatches(this.store, this.payloads);
    let batch = batches.current(roleId);
    if (batch?.status === 'deferred') {
      if ((batch.retryAt ?? 0) > Date.now()) return false;
      batch = { ...batch, status: 'pending', attempts: 0, round: batch.round + 1, retryAt: null }; batches.save(roleId, batch);
    }
    let input = batch ? await batches.input(roleId, batch, signal) : undefined;
    const defer = (reason: string) => {
      const failures = (this.consolidationStatus(roleId)?.failures ?? 0) + 1;
      const retryAt = Date.now() + Math.min(3600000, 60000 * 4 ** Math.min(failures - 1, 3));
      if (!batch) throw new Error('整理退避缺少持久批次');
      batches.save(roleId, { ...batch, status: 'deferred', feedback: reason, retryAt });
      this.store.setMeta(`consolidation-status:${roleId}`, JSON.stringify({ status: 'deferred', reason, failures, retryAt })); return false;
    };
    if (batch && batch.attempts >= 2 && !batch.responseRef) return defer(batch.feedback || '上次整理执行中断，等待后续重试');
    for (let attempt = 0; attempt < 2; attempt++) {
      const events = batch ? [] : this.store.unprocessed(roleId, 50).filter(event => event.seq <= upper);
      if (!events.length && !batch) return true;
      const role = input?.role ?? this.models.effective(this.store.role(roleId));
      const instructions = consolidationInstructions;
      input ??= { role, validationFeedback: '', sources: [], memories: [], continuity: [] };
      let advanced = false;
      const promptTokens = tokens(instructions) + 16;
      if (!batch) {
      for (const event of events) {
        const { activityId, ...original } = event;
        if (['tool', 'media'].includes(event.source) && original.payload && typeof original.payload === 'object' && !Array.isArray(original.payload)) {
          const result = original.payload.result;
          if (result && typeof result === 'object' && !Array.isArray(result) && typeof result.payloadId === 'string') original.payload = { ...original.payload, result: await this.payloads.value(roleId, result.payloadId, signal) };
        }
        let manifest = this.store.get('consolidation', event.id, chunkManifestSchema);
        const body = original.payload && typeof original.payload === 'object' && !Array.isArray(original.payload) ? original.payload : {};
        const internalTool = event.type === 'tool-result' && /^(continuity_|memory_|self_|life_plan|operation_read|capability_read|run_code$)/.test(String(body.name));
        const view = manifest ? manifest.view ?? 'original' : internalTool ? 'internal-summary' : event.type === 'internal-activity' ? 'assistant-text' : 'compact';
        if (!manifest && !hasConsolidationContent(event)) { this.store.markConsolidated([event.id]); advanced = true; continue; }
        const message = body.message && typeof body.message === 'object' && !Array.isArray(body.message) ? body.message : {};
        const sourceView = view === 'internal-summary' ? { id: original.id, type: original.type, source: original.source, occurredAt: original.occurredAt, tool: body.name, meaning: '内部资料读取或修订。内容与来源保存在相应记录及完整负载中，不作为新的外部经历反复提取。', isError: body.isError ?? false } : view === 'assistant-text' ? { id: original.id, type: original.type, occurredAt: original.occurredAt, meaning: '角色内部文字，不代表对外发送或外部事实', content: Array.isArray(message.content) ? message.content.filter(block => block && typeof block === 'object' && !Array.isArray(block) && block.type === 'text') : [] } : view === 'compact' ? { id: original.id, type: original.type, source: original.source, occurredAt: original.occurredAt, scene: original.scene, peerId: original.peerId, senderId: original.senderId, self: original.self, payload: original.payload } : original;
        const text = JSON.stringify(readable(asJson(sourceView))); const digest = createHash('sha256').update(text).digest('hex');
        if (!manifest) {
          let end = 0; const ends = sourceChunks(text, Math.max(128, Math.floor(this.config.budgets.consolidation / 3))).map(part => end += part.length);
          manifest = { digest, ends, view }; this.store.put('consolidation', event.id, roleId, asJson(manifest), null, 'system', '固定整理分片位置');
        }
        if (manifest.digest !== digest) throw new Error('整理来源与固定分片不一致');
        const parts = manifest.ends.map((end, index) => text.slice(index ? manifest!.ends[index - 1]! : 0, end));
        const pending: number[] = [];
        parts.forEach((part, index) => { if (!this.store.chunk(event.id, index, parts.length, digest)) pending.push(index); });
        if (!pending.length) { this.store.markConsolidated([event.id]); advanced = true; continue; }
        const ref = await this.payloads.put(roleId, event.id, asJson(event), signal);
        for (const part of pending) {
          const candidate = { id: event.id, part, total: parts.length, payloadId: ref.payloadId, text: parts[part]!, sourceMeaning: this.continuity.sourceMeaning(roleId, event.id) };
          const sourceLimit = input.sources.length ? Math.floor(this.config.budgets.consolidation * 0.65) : this.config.budgets.consolidation - 128;
          if (consolidationInputTokens({ ...input, sources: [...input.sources, candidate] }) + promptTokens > sourceLimit) break;
          input.sources.push(candidate);
        }
        if (input.sources.length && tokens(JSON.stringify(input)) > this.config.budgets.consolidation / 2) break;
      }
      if (!input.sources.length) { if (advanced) return true; if (this.store.unprocessed(roleId, 1).some(event => event.seq <= upper)) throw new Error('人格与必需来源超过记忆整理输入预算'); return true; }
      const sourceQuery = queryTerms(input.sources.map(source => source.text).join('\n')).join(' ');
      const candidates = localRecall(this.store, recallSchema.parse({ roleId, query: sourceQuery, limit: 50 }));
      const related = relatedConsolidationRecords(input, candidates, this.continuity.list(roleId, { limit: 200 }).items);
      for (const record of related.continuity) if (consolidationInputTokens({ ...input, continuity: [...input.continuity, record] }) + promptTokens <= this.config.budgets.consolidation * 0.85) input.continuity.push(record);
      for (const memory of related.memories) {
        if (consolidationInputTokens({ ...input, memories: [...input.memories, memory] }) + promptTokens <= this.config.budgets.consolidation * 0.85) input.memories.push(memory);
      }
      batch = await batches.create(roleId, input, signal);
      }
      const correction = Boolean(batch.feedback);
      const messages = consolidationMessages({ ...input, validationFeedback: '' });
      if (correction) {
        const baseTokens = messages.reduce((sum, message) => sum + tokens(message.content[0]!.text) + 8, promptTokens);
        const feedback = { validationFeedback: fitText(batch.feedback, Math.max(0, this.config.budgets.consolidation - baseTokens - 64)) };
        const withDraft = { ...feedback, draft: batch.draft };
        messages.push({ role: 'user', content: [{ type: 'text', text: JSON.stringify(baseTokens + tokens(JSON.stringify(withDraft)) + 8 <= this.config.budgets.consolidation ? withDraft : feedback) }] });
      }
      const inputRef = await this.payloads.put(roleId, `consolidation:${batch.id}:${batch.operations.length}`, asJson({ system: instructions, input, messages, protocol: 2, batchId: batch.id, mode: correction ? 'correction' : 'extraction' }), signal);
      const routedRole = this.models.effective(this.store.role(roleId));
      const reasoningEffort = batch.responseRef ? undefined : await this.auxiliaryEffort(routedRole, signal);
      if (messages.reduce((sum, message) => sum + tokens(message.content[0]!.text) + 8, promptTokens) > this.config.budgets.consolidation) return defer('整理必要输入超过预览预算，请检查角色设定或涉及记录');
      if (!batch.responseRef && batch.operationId) {
        const interrupted = this.store.get('operation', batch.operationId, operationSchema);
        if (interrupted?.state === 'started') this.store.finishOperation(interrupted.id, 'unknown', { message: '整理请求在进程中断前未保存完整结果，用量未知' });
      }
      const operation = batch.responseRef ? this.store.get('operation', batch.operationId!, operationSchema)! : this.store.startOperation(role.accountId, roleId, 'memory_consolidate', asJson({ sources: input.sources.map(({ text, ...source }) => source), batchId: batch.id, protocol: 2, provider: routedRole.provider, model: routedRole.model, roleRevision: role.revision, inputRef, mode: correction ? 'correction' : 'extraction', estimatedTokens: messages.reduce((sum, message) => sum + tokens(message.content[0]!.text) + 8, promptTokens), reasoningEffort: reasoningEffort ?? null }));
      if (!operation) throw new Error('整理批次对应的请求记录不存在');
      if (!batch.responseRef) { batch.attempts++; batch.operationId = operation.id; batch.operations.push(operation.id); batches.save(roleId, batch); }
      const assembler = new BlockAssembler();
      let usage: Json = null;
      try {
        let text: string;
        if (batch.responseRef) {
          const response = z.object({ text: z.string(), usage: z.unknown() }).parse(await this.payloads.value(roleId, batch.responseRef.payloadId, signal));
          text = response.text; usage = asJson(response.usage);
        } else {
        for await (const chunk of this.auxiliaryStream({
          provider: routedRole.provider, model: routedRole.model, sessionId: agent.session.id,
          reasoningEffort,
          system: instructions,
          messages, signal,
        })) assembler.push(chunk);
        signal?.throwIfAborted();
        if (assembler.finish.kind !== 'stop') throw new EvidenceError(`记忆整理未完成：${assembler.finish.kind}`);
        text = assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('');
        usage = asJson(assembler.usage ?? null);
        await batches.response(roleId, batch, { text, usage }, signal);
        }
        const generated = parseModelOutput(z.unknown(), text);
        batch.draft = generated.value;
        const parsed = parseConsolidationOutput(consolidationSchema, text, input); const result = parsed.value;
        const currentInput = input;
        signal?.throwIfAborted();
        this.store.transaction(() => {
          const current = this.store.role(roleId);
          if (['initialPersona', 'persona', 'selfState', 'worldMode'].some(key => current[key as keyof Role] !== role[key as keyof Role])) throw new ConflictError(asJson(current));
          result.memories.forEach((memory, index) => {
            const { expectedRevision, ...value } = memory;
            const candidate = { ...value, roleId };
            this.continuity.assertMemory(candidate);
            if (expectedRevision !== null && value.id) {
              const previous = this.store.memory(value.id);
              if (previous.revision !== expectedRevision) throw new ConflictError(asJson(previous));
              if (JSON.stringify(memoryInputSchema.parse(previous)) === JSON.stringify(memoryInputSchema.parse(candidate))) return;
            }
            this.store.saveMemory(candidate, expectedRevision, roleId, result.reason);
          });
          const persona = result.persona != null && result.persona !== role.persona ? result.persona : null;
          const selfState = result.selfState != null && result.selfState !== role.selfState ? result.selfState : null;
          if (persona !== null || selfState !== null) this.selfRevise(roleId, { patch: { ...(persona === null ? {} : { persona }), ...(selfState === null ? {} : { selfState }) }, expectedRevision: current.revision, reason: result.reason, sources: [...new Set(currentInput.sources.map(source => source.id))] });
          for (const change of result.continuity) {
            if (change.id && change.expectedRevision !== null) {
              const previous = this.continuity.read(roleId, change.id);
              if (previous.revision !== change.expectedRevision) throw new ConflictError(asJson(previous));
              if (JSON.stringify(continuityDataSchema.parse(previous.data)) === JSON.stringify(change.data)) continue;
            }
            this.continuity.revise(roleId, change, 'consolidator');
          }
          for (const source of currentInput.sources) this.store.completeChunk(source.id, source.part);
          this.store.finishOperation(operation.id, 'succeeded', asJson({ sources: currentInput.sources.map(({ text, ...source }) => source), output: result, formatRepaired: parsed.repaired || generated.repaired, usage }));
          batches.complete(roleId, batch!);
        });
        return true;
      } catch (error) {
        const failure = await this.payloads.view(roleId, `consolidation-error:${operation.id}`, asJson({ message: errorText(error), output: batch.responseRef ?? assembler.blocks(), usage: usage ?? assembler.usage ?? null }), this.config.budgets.tool);
        this.store.finishOperation(operation.id, 'failed', failure);
        batch.responseRef = null; batch.feedback = fitText(errorText(error), 512); batches.save(roleId, batch);
        if (!signal?.aborted && (error instanceof ConflictError || error instanceof EvidenceError)) {
          if (error instanceof ConflictError) {
            batch.draft = undefined;
            input = { ...input, role: this.models.effective(this.store.role(roleId)), memories: input.memories.map(memory => this.store.memory(memory.id)), continuity: input.continuity.map(record => this.continuity.read(roleId, record.id)) };
            batch.inputRef = await this.payloads.put(roleId, `consolidation-batch-input:${batch.id}:${batch.operations.length}`, asJson(input), signal); batches.save(roleId, batch);
          }
          if (batch.attempts < 2) continue;
          return defer(batch.feedback);
        }
        throw error;
      }
    }
    throw new Error('记忆整理重试没有产生明确结果');
  }

  async reindex(signal?: AbortSignal): Promise<{ count: number }> {
    signal?.throwIfAborted();
    return this.store.rebuildSearch();
  }
  private async stateAction<T>(roleId: string, action: () => T | Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) { if (!(error instanceof EvidenceError) && !(error instanceof ConflictError) && !(error instanceof Error && error.name === 'AbortError')) this.ctx.emit('kw-mind/error', roleId, error); throw error; }
  }

  attach(ctx: Context, roleId: string): void {
    registerTool(ctx, 'continuity_read', '查询连续性：列表返回摘要和nextCursor；id读取正文，history读取修订，大正文提供payload_read入口。', continuityQuerySchema, (input, exec) => this.stateAction(roleId, async () => {
      exec.signal.throwIfAborted();
      if (!input.id) return this.continuitySearch(roleId, input);
      const record = this.continuity.read(roleId, input.id); if (!input.history) return this.payloads.view(roleId, `continuity:${record.id}:${record.revision}`, asJson(record), this.config.budgets.tool, exec.signal);
      const rows = this.store.history('continuity', input.id, input.limit + 1, input.cursor || undefined);
      return { items: rows.slice(0, input.limit), nextCursor: rows.length > input.limit ? rows[input.limit - 1]!.revision : null };
    }));
    registerTool(ctx, 'continuity_revise', '创建或修订连续性完整资料。创建expectedRevision=null，修改需要当前revision。生活固定id=life:角色标识。thread可结束或重新开启，expression采用时status=adopted。来源与实际发送分开；followups只引用真实消息操作。reviewAt安排复核，不直接发送。', continuityRequestSchema, async (input, exec) => { exec.signal.throwIfAborted(); return this.stateAction(roleId, () => this.continuity.revise(roleId, input)); });
    ctx.systemPrompt.section({ name: 'deployment:continuity', order: 10210, interpolate: false, text: continuityGuidance });
    registerTool(ctx, 'payload_read', '按字节游标分页读取当前角色的完整负载，nextCursor 为 null 表示结束。', payloadReadSchema, (input, exec) => this.stateAction(roleId, () => this.payloads.read(roleId, input, exec.signal)));
    registerTool(ctx, 'self_revise', '依据实际经历修订人格、自我状态或表达示例。表达示例只用于风格。', z.object({ expectedRevision: z.number().int().positive(), patch: z.object({ persona: z.string().min(1).optional(), selfState: z.string().optional(), expressionExamples: z.array(z.string().min(1)).optional() }).strict(), reason: z.string().min(1), sources: z.array(z.string()).min(1) }).strict(), async (input, exec) => { exec.signal.throwIfAborted(); return this.stateAction(roleId, () => this.selfRevise(roleId, input)); });
    registerTool(ctx, 'memory_recall', '按需查询长期记忆，返回{items,nextCursor}，items为摘要及真实id、revision、读取入口。支持关键词、人物QQ、场合、时间与类型。默认本地检索10条，最多50条；下一页保持原条件并传cursor。确需模型扩展检索词时设置semantic=true。', recallSchema.omit({ roleId: true }), (input, exec) => this.stateAction(roleId, () => this.search({ ...input, roleId }, exec.signal)));
    registerTool(ctx, 'memory_read', '读取记忆正文、原始经历、修订历史或来源列表。大正文返回payload_read入口；history和sources使用cursor分页。', z.object({ id: z.string(), source: z.enum(['memory', 'event', 'history', 'sources']).default('memory'), cursor: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(50).default(10) }), async (input, exec) => this.stateAction(roleId, async () => {
      if (input.source === 'event') { const event = this.store.event(input.id); if (event.roleId !== roleId) throw new EvidenceError('经历属于其他角色'); return this.payloads.view(roleId, `event:${event.id}`, asJson(event), this.config.budgets.tool, exec.signal); }
      const memory = this.store.memory(input.id);
      if (memory.roleId !== roleId) throw new EvidenceError('记忆属于其他角色');
      if (input.source === 'sources') return boundedPage(memory.sources.slice(input.cursor).map(id => ({ id, read: this.store.db.prepare('SELECT 1 FROM events WHERE id=? AND role_id=?').get(id, roleId) ? { tool: 'memory_read', arguments: { id, source: 'event' } } : { tool: 'operation_read', arguments: { id } } })), input.cursor, input.limit, this.config.budgets.tool, offset => offset);
      if (input.source === 'history') { const rows = this.store.history('memory', input.id, input.limit + 1, input.cursor || undefined); return this.payloads.view(roleId, `memory-history:${input.id}:${input.cursor}`, asJson({ items: rows.slice(0, input.limit), nextCursor: rows.length > input.limit ? rows[input.limit - 1]!.revision : null }), this.config.budgets.tool, exec.signal); }
      return this.payloads.view(roleId, `memory:${memory.id}:${memory.revision}`, asJson(memory), this.config.budgets.tool, exec.signal);
    }));
    registerTool(ctx, 'memory_revise', '保存完整长期记忆，顶层为 {memory,expectedRevision,reason}。创建 expectedRevision=null、memory.id省略；修改先读取原记忆并提交其id和正整数revision。memory.kind为episode/self/person/relationship/world/promise/focus；sources取真实sourceId或operation_read返回的操作id，people使用QQ账号字符串。完整示例见kwagent-life/references/records.md。', z.object({ memory: memoryInputSchema.omit({ roleId: true }), expectedRevision: z.number().int().positive().nullable().describe('创建为 null；修改为读取到的当前正整数 revision'), reason: z.string().min(1) }), (input, exec) => this.revise({ ...input.memory, roleId }, input.expectedRevision, roleId, input.reason, exec.signal));
    ctx.systemPrompt.section({ name: 'deployment:persona-prefix', order: 0, interpolate: false, text: () => { const frozen = this.steps.get(roleId); return frozen ? JSON.parse(frozen).role.persona : this.store.role(roleId).persona; } });
    ctx.systemPrompt.section({ name: 'deployment:persona-suffix', order: 10200, interpolate: false, text: '你有自己的兴趣、关系和持续目标，自主决定关注、行动和休息。群聊与私聊是你经历的事件。对外交流通过 Lagrange 工具完成，内部活动可以保持安静。使用 life_plan 管理目标和下一次活动。工具执行结果需要实际核实。认识他人和世界时区分事实、转述、推测和剧情。' });
  }
}

export const name = 'kw-mind';
export const inject = ['llm', 'tools', 'systemPrompt', 'credentials', 'settings'];
export async function apply(ctx: Context): Promise<void> {
  const config = loadConfig();
  await mkdir(join(config.dataRoot, 'kwagent'), { recursive: true });
  const release = await lock(join(config.dataRoot, 'kwagent'), { realpath: true, stale: 30000, update: 5000, retries: 0 });
  const mind = new Mind(ctx, config);
  ctx.effect(() => async () => { await mind.close(); await release(); }, 'kw-mind.database');
}
