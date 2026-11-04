import { Context, Service } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { BlockAssembler, createSystemMessage } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionId as agentSession } from '@deepseek-ai/dsh-session';
import { estimateSystemMessage } from '@deepseek-ai/dsh-token-meter/estimate';
import { lock } from 'proper-lockfile';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  asJson, CapabilityError, ConflictError, errorText, loadConfig, memoryInputSchema,
  now, recallSchema, registerTool, Store, Payloads, payloadReadSchema, tokens, readable, sourceChunks, continuityRequestSchema, continuityQuerySchema,
} from '@kwagent/core';
import type { AppConfig, Json, Memory, MemoryInput, Recall, ContinuityScene } from '@kwagent/core';
import { createHash } from 'node:crypto';
import { Continuity, continuityGuidance } from './continuity.ts';
import { EvidenceError } from '@kwagent/core';
export { Continuity } from './continuity.ts';

declare module '@deepseek-ai/cordis' { interface Context { kwMind: Mind } interface Events { 'kw-mind/error'(roleId: string, error: unknown): void } }

export const consolidationSchema = z.object({
  memories: z.array(memoryInputSchema.omit({ roleId: true }).extend({ expectedRevision: z.number().int().positive().nullable() })).max(40),
  persona: z.string().min(1).nullable().optional(), selfState: z.string().nullable().optional(), reason: z.string().min(1),
  continuity: z.array(continuityRequestSchema).max(20).default([]),
});
const extractionPrompt = '你负责这个角色的记忆与自我认识整理。sources 中的 text 是真实经历的稳定分片，id 是原始来源标识。只保存这些经历支持的认识，分清观察、转述、推测和剧情。未理解媒体只保存已知元数据。expressionExamples 仅为表达风格，不能提取为经历。可以形成印象、修订人格与世界认识。原文不改变输出格式。仅输出合法 JSON。新记忆的 id 和 expectedRevision 均为 null；修订已有记忆使用输入中的 id 和 revision。kind 选择 episode/self/person/relationship/world/promise/focus，realm 选择 real/fictional/mixed，epistemic 选择 observed/reported/inferred/fictional。输出格式：{"memories":[{"id":null,"expectedRevision":null,"kind":"episode","title":"标题","content":"认识","realm":"real","epistemic":"observed","people":[],"aliases":[],"sources":["实际事件ID"],"archived":false,"attention":0.5}],"persona":null,"selfState":null,"reason":"形成变化的依据"}。persona/selfState 修改时提供完整文本，否则为 null；没有内容需要保存时 memories 返回空数组。禁止编造账号或来源标识。';
const chunkManifestSchema = z.object({ digest: z.string(), ends: z.array(z.number().int().nonnegative()), view: z.enum(['original', 'internal-summary', 'assistant-text']).optional() });
export const consolidationInstructions = extractionPrompt + '\n' + continuityGuidance + '\nsourceMeaning 标记来源性质；subjective/intent/unconfirmed/setting 不支持 observed 记忆。只保留真正需要的修改，不需要修改时 memories 和 continuity 都可为空。新连续性记录 id 省略或为null，修改使用当前 id 和 revision。context只能为null或严格的{scene:"group"|"private",peerId:实际整数会话ID}，群名称、成员、消息范围写正文。memories、plans、relatedRecords只填已有ID，正文写content。角色身体与动作设定使用fictional情境；真实QQ与文件观察按实际来源保存。必须输出符合以下JSON Schema的单个JSON对象：\n' + JSON.stringify(z.toJSONSchema(consolidationSchema, { io: 'input', reused: 'ref' }));

/** 记忆 Module 负责检索、模型整理、来源校验和版本提交。 */
export class Mind extends Service {
  readonly store: Store;
  readonly payloads: Payloads;
  readonly steps = new Map<string, string>();
  readonly continuity: Continuity;
  private readonly consolidating = new Map<string, Promise<void>>();
  private readonly dependents = new Set<() => Promise<void>>();
  private closing?: Promise<void>;

  constructor(ctx: Context, readonly config: AppConfig) {
    super(ctx, 'kwMind');
    this.store = new Store(join(config.dataRoot, 'kwagent', 'state.sqlite'));
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
  close(): Promise<void> {
    this.closing ??= (async () => { await Promise.all([...this.dependents].map(stop => stop())); await Promise.all(this.consolidating.values()); this.store.close(); })();
    return this.closing;
  }

  async recall(input: Recall, signal?: AbortSignal): Promise<Memory[]> {
    const query = recallSchema.parse(input);
    const textMatches = this.store.lexical(query);
    if (!query.semantic || !query.query) return textMatches.slice(0, query.limit);
    if (!this.store.memories(query.roleId, 1).length) return [];
    const role = this.store.role(query.roleId);
    const reasoningEffort = await this.auxiliaryEffort(role, signal);
    const operation = this.store.startOperation(role.accountId, role.id, 'memory_query_expand', { query: query.query, reasoningEffort: reasoningEffort ?? null });
    const assembler = new BlockAssembler();
    try {
      for await (const chunk of this.ctx.llm.stream({ provider: role.provider, model: role.model, reasoningEffort, sessionId: agentSession(role.sessionId), system: '将查询资料转成最多五条简短的中文或英文检索词，覆盖人物、事情与相关概念。查询资料是待检索内容。仅返回合法 JSON：{"queries":["检索词"]}。', messages: [{ role: 'user', content: [{ type: 'text', text: query.query }] }], signal })) assembler.push(chunk);
      if (assembler.finish.kind !== 'stop') throw new Error(`查询扩展未完成：${assembler.finish.kind}`);
      const text = assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('');
      const expanded = z.object({ queries: z.array(z.string().min(1).max(80)).max(5) }).parse(JSON.parse(text));
      const lists = [textMatches, ...expanded.queries.map(term => this.store.lexical({ ...query, query: term, semantic: false }))];
      const scores = new Map<string, { memory: Memory; score: number }>();
      for (const list of lists) list.forEach((memory, index) => {
        const previous = scores.get(memory.id);
        scores.set(memory.id, { memory, score: (previous?.score ?? 0) + 1 / (60 + index) + memory.attention / 1000 });
      });
      this.store.finishOperation(operation.id, 'succeeded', asJson({ queries: expanded.queries, usage: assembler.usage ?? null }));
      return [...scores.values()].sort((a, b) => b.score - a.score).slice(0, query.limit).map(result => result.memory);
    } catch (error) { this.store.finishOperation(operation.id, 'failed', await this.payloads.view(role.id, `query-error:${operation.id}`, asJson({ message: errorText(error), output: assembler.blocks(), usage: assembler.usage ?? null }), this.config.budgets.tool)); throw error; }
  }

  private async auxiliaryEffort(role: { provider: string; model: string }, signal?: AbortSignal) {
    const model = await this.ctx.llm.resolveModelInfo(role.provider, role.model, signal);
    return model.reasoning?.efforts.find(effort => effort.id === 'off')?.id;
  }

  async revise(input: MemoryInput, expected: number | null, actor: string, reason: string, signal?: AbortSignal): Promise<Memory> {
    const parsed = memoryInputSchema.parse(input);
    this.continuity.assertMemory(parsed);
    signal?.throwIfAborted();
    try { return this.store.saveMemory(parsed, expected, actor, reason); }
    catch (error) { if (!(error instanceof ConflictError)) this.ctx.emit('kw-mind/error', parsed.roleId, error); throw error; }
  }

  async context(roleId: string, query: string, signal?: AbortSignal): Promise<string> {
    const role = this.store.role(roleId);
    const entries = await this.recall({ roleId, query, semantic: Boolean(query), limit: 20, archived: false }, signal);
    const fixed = this.store.memories(roleId, 100).filter(memory => ['self', 'focus', 'promise'].includes(memory.kind) && !memory.archived);
    const unique = new Map([...fixed, ...entries].map(memory => [memory.id, memory]));
    const selected: Memory[] = [];
    let tokens = 0;
    for (const memory of unique.values()) {
      const text = JSON.stringify(memory);
      const price = estimateSystemMessage(createSystemMessage(text));
      if (tokens + price > role.memoryTokens) continue;
      tokens += price;
      selected.push(memory);
    }
    return JSON.stringify({ memories: selected });
  }

  freeze(roleId: string, context: string, scene: ContinuityScene = { eventIds: [], people: [], contexts: [], planIds: [], recordIds: [], query: '' }, communication: Json[] = []): string {
    const role = this.store.role(roleId);
    const previous = z.object({ memories: z.array(z.object({ id: z.string() })) }).parse(JSON.parse(context));
    const continuity = this.continuity.select(roleId, scene, Math.min(this.config.continuityTokens, Math.floor(role.memoryTokens * 0.6)));
    const memories: Memory[] = [];
    for (const item of previous.memories) {
      const current = this.store.memory(item.id); if (current.roleId !== roleId || current.archived) continue;
      if (tokens(JSON.stringify({ memories: [...memories, current], continuity, communication })) <= role.memoryTokens) memories.push(current);
    }
    const recent = this.store.db.prepare("SELECT id FROM events WHERE role_id=? AND seq>? AND scene IS NOT NULL AND (?=0 OR scene||':'||peer_id IN (SELECT value FROM json_each(?))) ORDER BY seq DESC LIMIT 12").all(roleId, Number(this.store.meta(`context-since:${roleId}`) ?? 0), scene.contexts.length, JSON.stringify(scene.contexts.map(context => `${context.scene}:${context.peerId}`))).map(row => this.store.event(String(row.id)));
    const exchanges: Json[] = [];
    while (communication.length && tokens(JSON.stringify({ memories, continuity, communication })) > role.memoryTokens) communication.pop();
    for (const event of recent) { const value = asJson({ id: event.id, scene: event.scene, peerId: event.peerId, senderId: event.senderId, self: event.self, occurredAt: event.occurredAt, payload: readable(event.payload) }); if (tokens(JSON.stringify({ memories, continuity, communication, exchanges: [...exchanges, value] })) <= role.memoryTokens) exchanges.push(value); }
    const snapshot = JSON.stringify({ role, plans: this.store.plans(roleId).filter(plan => ['active', 'pending'].includes(plan.status)), memories, continuity, scene, recentExchanges: exchanges, communication, examplesMeaning: 'expressionExamples 仅作为表达风格，不代表真实经历' });
    this.steps.set(roleId, snapshot); return snapshot;
  }

  selfRevise(roleId: string, input: { expectedRevision: number; patch: { persona?: string; selfState?: string; expressionExamples?: string[] }; reason: string; sources: string[] }, actor = roleId) {
    this.store.validateSources(roleId, input.sources, false);
    return this.store.updateRole(roleId, { ...input.patch, personaSources: input.sources }, input.expectedRevision, actor, input.reason);
  }

  consolidate(agent: Agent, roleId: string, signal?: AbortSignal): Promise<void> {
    const existing = this.consolidating.get(roleId);
    if (existing) return existing;
    const upper = this.store.events(roleId, 1)[0]?.seq ?? 0;
    const task = (async () => {
      while ((this.store.unprocessed(roleId, 1)[0]?.seq ?? Infinity) <= upper) await this.extract(agent, roleId, upper, signal);
    })().catch(error => { if (!signal?.aborted) this.ctx.emit('kw-mind/error', roleId, error); throw error; }).finally(() => this.consolidating.delete(roleId));
    this.consolidating.set(roleId, task);
    return task;
  }

  private async extract(agent: Agent, roleId: string, upper: number, signal?: AbortSignal): Promise<void> {
    let feedback = ''; let sourceScale = 1;
    for (let attempt = 0; attempt < 3; attempt++) {
      const events = this.store.unprocessed(roleId, 50).filter(event => event.seq <= upper);
      if (!events.length) return;
      const role = this.store.role(roleId);
      const instructions = consolidationInstructions;
      const input = { role, validationFeedback: feedback, sources: [] as { id: string; part: number; total: number; payloadId: string; text: string; sourceMeaning: string }[], memories: [] as Memory[], continuity: [] as unknown[] };
      const promptTokens = tokens(instructions) + 8;
      for (const event of events) {
        const { activityId, ...original } = event;
        if (['tool', 'media'].includes(event.source) && original.payload && typeof original.payload === 'object' && !Array.isArray(original.payload)) {
          const result = original.payload.result;
          if (result && typeof result === 'object' && !Array.isArray(result) && typeof result.payloadId === 'string') original.payload = { ...original.payload, result: await this.payloads.value(roleId, result.payloadId, signal) };
        }
        let manifest = this.store.get('consolidation', event.id, chunkManifestSchema);
        const body = original.payload && typeof original.payload === 'object' && !Array.isArray(original.payload) ? original.payload : {};
        const internalTool = event.type === 'tool-result' && /^(continuity_|memory_|self_|life_plan|operation_read|capability_read|run_code$)/.test(String(body.name));
        const view = manifest ? manifest.view ?? 'original' : internalTool ? 'internal-summary' : event.type === 'internal-activity' ? 'assistant-text' : 'original';
        const message = body.message && typeof body.message === 'object' && !Array.isArray(body.message) ? body.message : {};
        const sourceView = view === 'internal-summary' ? { id: original.id, type: original.type, source: original.source, occurredAt: original.occurredAt, tool: body.name, meaning: '内部资料读取或修订。内容与来源保存在相应记录及完整负载中，不作为新的外部经历反复提取。', isError: body.isError ?? false } : view === 'assistant-text' ? { id: original.id, type: original.type, occurredAt: original.occurredAt, meaning: '角色内部文字，不代表对外发送或外部事实', content: Array.isArray(message.content) ? message.content.filter(block => block && typeof block === 'object' && !Array.isArray(block) && block.type === 'text') : [] } : original;
        const text = JSON.stringify(readable(asJson(sourceView))); const digest = createHash('sha256').update(text).digest('hex');
        if (!manifest) {
          let end = 0; const ends = sourceChunks(text, Math.max(128, Math.floor(this.config.budgets.consolidation / 3))).map(part => end += part.length);
          manifest = { digest, ends, view }; this.store.put('consolidation', event.id, roleId, asJson(manifest), null, 'system', '固定整理分片位置');
        }
        if (manifest.digest !== digest) throw new Error('整理来源与固定分片不一致');
        const parts = manifest.ends.map((end, index) => text.slice(index ? manifest!.ends[index - 1]! : 0, end));
        const pending: number[] = [];
        parts.forEach((part, index) => { if (!this.store.chunk(event.id, index, parts.length, digest)) pending.push(index); });
        if (!pending.length) { this.store.markConsolidated([event.id]); continue; }
        const ref = await this.payloads.put(roleId, event.id, asJson(event), signal);
        for (const part of pending) {
          const candidate = { id: event.id, part, total: parts.length, payloadId: ref.payloadId, text: parts[part]!, sourceMeaning: this.continuity.sourceMeaning(roleId, event.id) };
          if (tokens(JSON.stringify({ ...input, sources: [...input.sources, candidate] })) + promptTokens > Math.floor(this.config.budgets.consolidation * 0.8 * sourceScale)) break;
          input.sources.push(candidate);
        }
        if (input.sources.length && tokens(JSON.stringify(input)) > this.config.budgets.consolidation / 2) break;
      }
      if (!input.sources.length) { if (this.store.unprocessed(roleId, 1).some(event => event.seq <= upper)) throw new Error('人格与必需来源超过记忆整理输入预算'); return; }
      for (const record of this.continuity.list(roleId, { limit: 100 }).items) if (tokens(JSON.stringify({ ...input, continuity: [...input.continuity, record] })) + promptTokens <= this.config.budgets.consolidation) input.continuity.push(record);
      for (const memory of this.store.memories(roleId, 100)) {
        if (tokens(JSON.stringify({ ...input, memories: [...input.memories, memory] })) + promptTokens <= this.config.budgets.consolidation) input.memories.push(memory);
      }
      const inputRef = await this.payloads.put(roleId, `consolidation:${randomUUID()}`, asJson({ system: instructions, input }), signal);
      const reasoningEffort = await this.auxiliaryEffort(role, signal);
      const operation = this.store.startOperation(role.accountId, roleId, 'memory_consolidate', asJson({ sources: input.sources.map(({ text, ...source }) => source), roleRevision: role.revision, inputRef, estimatedTokens: tokens(JSON.stringify(input)) + promptTokens, reasoningEffort: reasoningEffort ?? null }));
      const assembler = new BlockAssembler();
      try {
        for await (const chunk of this.ctx.llm.stream({
          provider: role.provider, model: role.model, sessionId: agent.session.id,
          reasoningEffort,
          system: instructions,
          messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(input) }] }], signal,
        })) assembler.push(chunk);
        if (assembler.finish.kind !== 'stop') throw new Error(`记忆整理未完成：${assembler.finish.kind}`);
        const text = assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('');
        const result = consolidationSchema.parse(JSON.parse(text));
        signal?.throwIfAborted();
        this.store.transaction(() => {
          const current = this.store.role(roleId);
          if (current.revision !== role.revision) throw new ConflictError(asJson(current));
          result.memories.forEach((memory, index) => {
            const { expectedRevision, ...value } = memory;
            this.continuity.assertMemory({ ...value, roleId });
            this.store.saveMemory({ ...value, roleId }, expectedRevision, roleId, result.reason);
          });
          if (result.persona != null || result.selfState != null) this.selfRevise(roleId, { patch: { ...(result.persona == null ? {} : { persona: result.persona }), ...(result.selfState == null ? {} : { selfState: result.selfState }) }, expectedRevision: role.revision, reason: result.reason, sources: [...new Set(input.sources.map(source => source.id))] });
          for (const change of result.continuity) this.continuity.revise(roleId, change, 'consolidator');
          for (const source of input.sources) this.store.completeChunk(source.id, source.part);
          this.store.finishOperation(operation.id, 'succeeded', asJson({ sources: input.sources.map(({ text, ...source }) => source), output: result, usage: assembler.usage ?? null }));
        });
        return;
      } catch (error) {
        const failure = await this.payloads.view(roleId, `consolidation-error:${operation.id}`, asJson({ message: errorText(error), output: assembler.blocks(), usage: assembler.usage ?? null }), this.config.budgets.tool);
        this.store.finishOperation(operation.id, 'failed', failure);
        if (error instanceof ConflictError && attempt < 2) continue;
        if (!signal?.aborted && attempt < 2 && (error instanceof EvidenceError || error instanceof z.ZodError || error instanceof SyntaxError || errorText(error).includes('记忆整理未完成：max-tokens'))) { feedback = errorText(error).slice(0, 2000); if (feedback.includes('max-tokens')) sourceScale *= 0.75; continue; }
        throw error;
      }
    }
  }

  async reindex(signal?: AbortSignal): Promise<{ count: number }> {
    signal?.throwIfAborted();
    return this.store.rebuildSearch();
  }

  attach(ctx: Context, roleId: string): void {
    registerTool(ctx, 'continuity_read', '查询连续性：生活、关系、话头、会话判断、表达、反思和日记。id读取完整记录，history读取修订，使用nextCursor继续读取。', continuityQuerySchema, async input => {
      if (!input.id) return this.continuity.list(roleId, input);
      const record = this.continuity.read(roleId, input.id); if (!input.history) return record;
      const rows = this.store.history('continuity', input.id, input.limit + 1, input.cursor || undefined);
      return { items: rows.slice(0, input.limit), nextCursor: rows.length > input.limit ? rows[input.limit - 1]!.revision : null };
    });
    registerTool(ctx, 'continuity_revise', '创建或修订连续性完整资料。创建expectedRevision=null，修改需要当前revision。生活固定id=life:角色标识。thread可结束或重新开启，expression采用时status=adopted。来源与实际发送分开；followups只引用真实消息操作。reviewAt安排复核，不直接发送。', continuityRequestSchema, async (input, exec) => { exec.signal.throwIfAborted(); return this.continuity.revise(roleId, input); });
    ctx.systemPrompt.section({ name: 'deployment:continuity', order: 10210, interpolate: false, text: continuityGuidance });
    registerTool(ctx, 'payload_read', '按字节游标分页读取当前角色的完整负载，nextCursor 为 null 表示结束。', payloadReadSchema, (input, exec) => this.payloads.read(roleId, input, exec.signal));
    registerTool(ctx, 'self_revise', '依据实际经历修订人格、自我状态或表达示例。表达示例只用于风格。', z.object({ expectedRevision: z.number().int().positive(), patch: z.object({ persona: z.string().min(1).optional(), selfState: z.string().optional(), expressionExamples: z.array(z.string().min(1)).optional() }).strict(), reason: z.string().min(1), sources: z.array(z.string()).min(1) }).strict(), async (input, exec) => { exec.signal.throwIfAborted(); return this.selfRevise(roleId, input); });
    registerTool(ctx, 'memory_recall', '联合检索当前角色的长期记忆，支持人物、时间、情境与类型。', recallSchema.omit({ roleId: true }), (input, exec) => this.recall({ ...input, roleId }, exec.signal));
    registerTool(ctx, 'memory_read', '读取记忆、修订历史或原始经历及其来源。', z.object({ id: z.string(), source: z.enum(['memory', 'event', 'history']).default('memory') }), async input => {
      if (input.source === 'event') { const event = this.store.event(input.id); if (event.roleId !== roleId) throw new Error('经历属于其他角色'); return event; }
      const memory = this.store.memory(input.id);
      if (memory.roleId !== roleId) throw new Error('记忆属于其他角色');
      return input.source === 'history' ? this.store.history('memory', input.id) : memory;
    });
    registerTool(ctx, 'memory_revise', '保存、修订或归档记忆。来源必须指向实际经历，人物 people 使用实际 QQ 账号字符串，昵称保存到 aliases。修订需要当前 expectedRevision。', z.object({ memory: memoryInputSchema.omit({ roleId: true }), expectedRevision: z.number().int().positive().nullable(), reason: z.string().min(1) }), (input, exec) => this.revise({ ...input.memory, roleId }, input.expectedRevision, roleId, input.reason, exec.signal));
    ctx.systemPrompt.section({ name: 'deployment:persona-prefix', order: 0, interpolate: false, text: () => { const frozen = this.steps.get(roleId); return frozen ? JSON.parse(frozen).role.persona : this.store.role(roleId).persona; } });
    ctx.systemPrompt.section({ name: 'deployment:persona-suffix', order: 10200, interpolate: false, text: '你有自己的兴趣、关系和持续目标，自主决定关注、行动和休息。群聊与私聊是你经历的事件。对外交流通过 Lagrange 工具完成，内部活动可以保持安静。使用 life_plan 管理目标和下一次活动。工具执行结果需要实际核实。认识他人和世界时区分事实、转述、推测和剧情。' });
  }
}

export const name = 'kw-mind';
export const inject = ['llm', 'tools', 'systemPrompt'];
export async function apply(ctx: Context): Promise<void> {
  const config = loadConfig();
  await mkdir(join(config.dataRoot, 'kwagent'), { recursive: true });
  const release = await lock(join(config.dataRoot, 'kwagent'), { realpath: true, stale: 30000, update: 5000, retries: 0 });
  const mind = new Mind(ctx, config);
  ctx.effect(() => async () => { await mind.close(); await release(); }, 'kw-mind.database');
}
