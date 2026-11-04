import { randomUUID } from 'node:crypto';
import { EvidenceError } from '@kwagent/core';
import { asJson, ConflictError, continuityActive, continuityQuerySchema, continuityRequestSchema, continuitySchema, now, operationSchema, tokens, type AppConfig, type ContinuityQuery, type ContinuityRecord, type ContinuityRequest, type ContinuityScene, type Json, type MemoryInput, type Payloads, type Store } from '@kwagent/core';

export const continuityGuidance = '生活、关系、话头、会话判断、表达、反思与日记分别保存。关系理解为主观认识，对方当前明确表达优先。表达到两条、反思到两条，实例只供风格参考。可以旁听、简短回应、自然结束，不要求每次提问；新内容与附件仍需感知。主动联系前考虑真实近期发送、对方回复、来源场合、已结束话头和结果未知操作。计划与准备发送不代表已执行。工具失败或结果未知不能完成现实活动。自己的日记、反思、风格及声明不能变成外部事实。使用 continuity_read/revise 保存连续性；life_plan 的 review/contact 只安排重新判断。没有事件与安排时可以休息，不要求每日问候、日记或反思。';

/** 连续性记录的来源、有效性、版本和候选选择集中在此 Module。 */
export class Continuity {
  constructor(readonly store: Store, readonly payloads: Payloads, readonly config: AppConfig) {}
  read(roleId: string, id: string): ContinuityRecord {
    const record = this.store.get('continuity', id, continuitySchema);
    if (!record || record.roleId !== roleId) throw new Error('连续性记录不存在或属于其他角色');
    return record;
  }
  list(roleId: string, request: Partial<ContinuityQuery> = {}) {
    this.store.role(roleId); const input = continuityQuerySchema.parse(request);
    const conditions = ["kind='continuity'", 'role_id=?']; const values: (string | number)[] = [roleId];
    for (const [field, value] of [['kind', input.kind], ['status', input.status]] as const) if (value) { conditions.push(`json_extract(body,'$.data.${field}')=?`); values.push(value); }
    if (input.kinds) { conditions.push("json_extract(body,'$.data.kind') IN (SELECT value FROM json_each(?))"); values.push(JSON.stringify(input.kinds)); }
    if (input.person) { conditions.push("EXISTS(SELECT 1 FROM json_each(body,'$.data.people') WHERE value=?)"); values.push(input.person); }
    if (input.context) { conditions.push("json_extract(body,'$.data.context.scene')=? AND json_extract(body,'$.data.context.peerId')=?"); values.push(input.context.scene, input.context.peerId); }
    if (input.query) { conditions.push("instr(json_extract(body,'$.data.title')||json_extract(body,'$.data.content'),?)>0"); values.push(input.query); }
    if (input.since) { conditions.push('updated_at>=?'); values.push(new Date(input.since).toISOString()); }
    if (input.until) { conditions.push('updated_at<=?'); values.push(new Date(input.until).toISOString()); }
    const rows = this.store.db.prepare(`SELECT body FROM documents WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`).all(...values, input.limit + 1, input.cursor);
    return { items: rows.slice(0, input.limit).map(row => continuitySchema.parse(JSON.parse(String(row.body)))), nextCursor: rows.length > input.limit ? input.cursor + input.limit : null };
  }
  sourceMeaning(roleId: string, id: string, seen = new Set<string>()): string {
    if (seen.has(id)) return 'unconfirmed'; seen.add(id);
    const operation = this.store.get('operation', id, operationSchema);
    if (operation) {
      if (operation.roleId !== roleId) throw new Error('来源属于其他角色');
      if (/^(continuity_|memory_|self_|life_plan|operation_read|capability_read)/.test(operation.tool)) return 'subjective';
      return operation.state === 'succeeded' ? 'observed' : 'unconfirmed';
    }
    if (id === `role:${roleId}`) return 'setting';
    const event = this.store.event(id); if (event.roleId !== roleId) throw new Error('来源属于其他角色');
    if (event.source === 'milky') return 'reported';
    if (event.source === 'manual') return 'reported';
    if (event.source === 'schedule' || ['initialize', 'condition-candidate'].includes(event.type)) return 'intent';
    if (event.source === 'media') return /fail|error/.test(event.type) ? 'unconfirmed' : 'observed';
    if (event.type === 'tool-result') {
      const body = event.payload as Record<string, Json>;
      let result = body.result as Record<string, Json> | null;
      if (body.isError || result?.isError) return 'unconfirmed';
      if (/^(continuity_|memory_|self_|life_plan|operation_read|capability_read|payload_read|verification_mark)/.test(String(body.name))) return 'subjective';
      if (body.name === 'skill') return 'setting';
      if (typeof result?.payloadId === 'string') {
        const saved = this.payloads.valueSync(roleId, result.payloadId);
        if (!saved || typeof saved !== 'object' || Array.isArray(saved) || !saved.result || typeof saved.result !== 'object' || Array.isArray(saved.result)) return 'unconfirmed';
        result = saved.result;
      }
      if (result?.isError) return 'unconfirmed';
      const value = result?.value && typeof result.value === 'object' && !Array.isArray(result.value) ? result.value : {};
      if (value.state === 'unknown' || value.state === 'failed') return 'unconfirmed';
      if (typeof value.operationId === 'string') { const actual = this.store.get('operation', value.operationId, operationSchema); if (actual && (actual.roleId !== roleId || actual.state !== 'succeeded')) return 'unconfirmed'; }
      if (body.name === 'run_code') {
        if (typeof body.executionId !== 'string') return 'unconfirmed';
        const children = this.store.db.prepare("SELECT id FROM events WHERE role_id=? AND type='tool-result' AND json_extract(payload,'$.parentExecutionId')=?").all(roleId, body.executionId);
        return children.some(child => this.sourceMeaning(roleId, String(child.id), seen) === 'observed') ? 'observed' : 'unconfirmed';
      }
      if (result?.payloadId) return 'unconfirmed';
      return 'observed';
    }
    return 'subjective';
  }
  assertMemory(memory: MemoryInput): void {
    if (memory.epistemic !== 'observed') return;
    if (!memory.sources.some(source => ['observed', 'reported'].includes(this.sourceMeaning(memory.roleId, source)))) throw new EvidenceError(`内部想法、设定与未确认执行不能作为亲历事实：${memory.title}；来源 ${memory.sources.join(',')}。请保留来源并使用inferred，或根据真实子调用来源判断。`);
  }
  revise(roleId: string, request: ContinuityRequest, actor = roleId, clock = now()): ContinuityRecord {
    const input = continuityRequestSchema.parse(request); const role = this.store.role(roleId);
    const id = input.id ?? (input.data.kind === 'life' ? `life:${roleId}` : randomUUID());
    const previous = this.store.get('continuity', id, continuitySchema);
    if (previous && previous.roleId !== roleId) throw new Error('连续性记录属于其他角色');
    if (previous && previous.data.kind !== input.data.kind) throw new Error('记录类型不能通过修订改变');
    if (input.data.kind === 'life' && id !== `life:${roleId}`) throw new Error('当前生活记录使用角色的固定标识');
    if ((previous?.revision ?? null) !== input.expectedRevision) throw new ConflictError(previous ? asJson(previous) : null);
    return this.store.transaction(() => {
      const data = input.data; const suppliedSources = [...data.sources];
      if (data.applicableAt) data.applicableAt = new Date(data.applicableAt).toISOString();
      if (data.expiresAt) data.expiresAt = new Date(data.expiresAt).toISOString();
      if ('reviewAt' in data && data.reviewAt) data.reviewAt = new Date(data.reviewAt).toISOString();
      if (data.kind === 'thread' && data.expectedAt) data.expectedAt = new Date(data.expectedAt).toISOString();
      const declaration = this.store.startOperation(role.accountId, roleId, 'continuity_revise', asJson({ id, kind: data.kind, actor, reason: input.reason, meaning: '声明或主观认识，不证明外部执行成功' }));
      if (!data.sources.length && actor === 'consolidator') throw new Error('自动整理必须提供真实来源');
      data.sources = [...new Set([...data.sources, declaration.id])];
      this.store.validateSources(roleId, data.sources, false);
      for (const memoryId of data.memories) if (this.store.memory(memoryId).roleId !== roleId) throw new Error('关联记忆属于其他角色');
      for (const planId of data.plans) if (this.store.plan(planId).roleId !== roleId) throw new Error('关联计划属于其他角色');
      for (const other of data.relatedRecords) { if (other === id) throw new Error('记录不能关联自身'); this.read(roleId, other); }
      if (role.worldMode === 'real' && data.realm !== 'real') throw new Error('现实角色的生活记录需要使用现实情境');
      if (data.applicableAt && data.expiresAt && Date.parse(data.applicableAt) >= Date.parse(data.expiresAt)) throw new Error('失效时间需要晚于适用时间');
      if ('reviewAt' in data && data.reviewAt && data.applicableAt && Date.parse(data.reviewAt) < Date.parse(data.applicableAt)) throw new Error('复核时间不能早于适用时间');
      if (data.kind === 'life') {
        if (data.activity) {
          this.store.validateSources(roleId, data.activity.sources.length ? data.activity.sources : data.sources, false);
          if (data.realm === 'real' && ['in_progress', 'completed'].includes(data.activity.state) && !(data.activity.sources.length ? data.activity.sources : data.sources).some(source => this.sourceMeaning(roleId, source) === 'observed')) throw new EvidenceError('现实活动进展需要已观察的执行依据，不能引用PTC父结果或内部声明替代实际子调用');
        }
        data.emotions = data.emotions.map(emotion => ({ ...emotion, formedAt: new Date(emotion.formedAt).toISOString(), expiresAt: emotion.expiresAt ? new Date(emotion.expiresAt).toISOString() : new Date(Date.parse(emotion.formedAt) + 86400000).toISOString() }));
        if (data.emotions.some(emotion => Date.parse(emotion.expiresAt!) <= Date.parse(emotion.formedAt))) throw new Error('情绪失效时间需要晚于形成时间');
      }
      if (data.kind === 'reflection' && data.expiresAt === null) data.expiresAt = new Date(Date.parse(clock) + 7 * 86400000).toISOString();
      if (data.kind === 'expression' && !data.sources.some(source => this.sourceMeaning(roleId, source) !== 'subjective')) throw new Error('表达实例需要实际交流来源');
      if (data.kind === 'relationship' && !data.people.length) throw new Error('关系理解需要实际账号标识');
      if (data.kind === 'conversation' && !data.context) throw new Error('会话判断需要会话情境');
      if (data.kind === 'thread') {
        const seen = new Set<string>();
        for (const followup of data.followups) {
          if (seen.has(followup.operationId)) throw new Error('同一回执不能重复计入承接记录'); seen.add(followup.operationId);
          const operation = this.store.get('operation', followup.operationId, operationSchema);
          if (!operation || operation.roleId !== roleId || !/^send_(group|private|temp)_message$/.test(operation.tool)) throw new Error('承接记录需要当前角色的消息操作');
          if (operation.state === 'failed' || operation.state === 'started') throw new Error('承接操作尚未取得有效回执');
          const raw = operation.arguments && typeof operation.arguments === 'object' && !Array.isArray(operation.arguments) ? operation.arguments : {};
          const target = operation.context ?? (typeof raw.group_id === 'number' ? { scene: 'group', peerId: raw.group_id } : typeof raw.user_id === 'number' ? { scene: 'private', peerId: raw.user_id } : null);
          if (data.context && target && (data.context.scene !== target.scene || data.context.peerId !== target.peerId)) throw new Error('承接回执与话头会话不一致');
          if (!target && !followup.pending) throw new Error('回执会话未记录，需要明确以pending=true保存待核实关联');
          if (operation.state === 'unknown') followup.pending = true;
        }
        if (previous?.data.kind === 'thread' && ['resolved', 'declined', 'cancelled', 'expired'].includes(previous.data.status) && ['active', 'deferred'].includes(data.status) && !suppliedSources.some(source => !previous.data.sources.includes(source))) throw new Error('重新开启话头需要新的来源');
      }
      const activityId = this.store.meta(`activity:${roleId}`) || null;
      const record = continuitySchema.parse({ id, roleId, data, revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? clock, updatedAt: clock, actor, reason: input.reason, activityId });
      this.store.put('continuity', id, roleId, asJson(record), input.expectedRevision, actor, input.reason);
      this.store.db.prepare('DELETE FROM continuity_sources WHERE record_id=?').run(id);
      for (const source of data.sources) this.store.db.prepare('INSERT INTO continuity_sources VALUES(?,?)').run(id, source);
      if (activityId) this.store.link(activityId, 'continuity', id, { revision: record.revision, kind: data.kind });
      this.store.finishOperation(declaration.id, 'succeeded', { recordId: id, revision: record.revision, meaning: '内部连续性修订' });
      return record;
    });
  }
  select(roleId: string, scene: ContinuityScene, budget: number, at = now()): Json {
    const role = this.store.role(roleId);
    const terms = [...new Set([...new Intl.Segmenter('zh', { granularity: 'word' }).segment(`${scene.query}\n${role.selfState}`)].filter(item => item.isWordLike && item.segment.length >= 2 && !/^\d+$/.test(item.segment)).map(item => item.segment.toLowerCase()))].slice(0, 100);
    const rows = this.store.db.prepare("SELECT body FROM documents WHERE kind='continuity' AND role_id=? ORDER BY updated_at DESC,id").all(roleId).map(row => continuitySchema.parse(JSON.parse(String(row.body))));
    const candidates = rows.filter(record => {
      const closingContext = record.data.kind === 'conversation' && record.data.status === 'closed' && (!record.data.applicableAt || Date.parse(record.data.applicableAt) <= Date.parse(at)) && (!record.data.expiresAt || Date.parse(record.data.expiresAt) > Date.parse(at));
      if ((!continuityActive(record, at) && !closingContext) || record.data.kind === 'journal') return false;
      const data = record.data;
      if (data.context && !scene.contexts.some(context => context.scene === data.context!.scene && context.peerId === data.context!.peerId)) return false;
      if (data.people.length && !data.people.some(person => scene.people.includes(person)) && !scene.recordIds.includes(record.id)) return false;
      return true;
    }).map(record => { const text = `${record.data.title}\n${record.data.content}\n${'situations' in record.data ? record.data.situations.join('\n') : ''}`.toLowerCase(); return { record, score: (scene.recordIds.includes(record.id) ? 100 : 0) + (record.data.context ? 30 : 0) + (record.data.people.some(person => scene.people.includes(person)) ? 20 : 0) + (record.data.kind === 'life' ? 10 : 0) + Math.min(16, terms.filter(term => text.includes(term)).length * 2), lastUsed: record.data.kind === 'expression' ? this.store.meta(`expression-used:${roleId}:${record.id}`) ?? '' : '' }; }).sort((a, b) => b.score - a.score || a.lastUsed.localeCompare(b.lastUsed) || b.record.updatedAt.localeCompare(a.record.updatedAt));
    const selected: Json[] = []; const omitted: Json[] = []; let omittedCount = 0; let expressions = 0, reflections = 0;
    if (tokens(JSON.stringify({ selectedAt: at, records: [], omitted: [], omittedCount: 0 })) > budget) throw new Error('连续性必要读取信息超过上下文预算');
    for (const { record } of candidates) {
      const kind = record.data.kind; if (kind === 'expression' && expressions >= 2 || kind === 'reflection' && reflections >= 2) continue;
      const data = record.data.kind === 'life' ? { ...record.data, emotions: record.data.emotions.filter(emotion => Date.parse(emotion.expiresAt!) > Date.parse(at)) } : record.data;
      const item = asJson({ ...record, data, elapsedSeconds: Math.max(0, Math.floor((Date.parse(at) - Date.parse(record.updatedAt)) / 1000)), meaning: kind === 'expression' ? '风格资料' : kind === 'reflection' ? '短期行为提醒' : kind === 'life' || kind === 'relationship' ? '活动与主观认识' : '持续事项和交流判断' });
      if (tokens(JSON.stringify({ selectedAt: at, records: [...selected, item], omitted, omittedCount })) + 32 > budget) { omittedCount++; const ref = { id: record.id, kind, read: 'continuity_read' }; if (omitted.length < 10 && tokens(JSON.stringify({ selectedAt: at, records: selected, omitted: [...omitted, ref], omittedCount })) + 16 <= budget) omitted.push(ref); continue; }
      selected.push(item); if (kind === 'expression') { expressions++; this.store.setMeta(`expression-used:${roleId}:${record.id}`, at); } if (kind === 'reflection') reflections++;
    }
    return { selectedAt: at, records: selected, omitted, omittedCount };
  }
}
