import { z } from 'zod';
import { asJson, now, type Experience, type Store } from '@kwagent/core';

const outcome = z.enum(['started', 'succeeded', 'failed', 'unknown']);
export const reactionProgressSchema = z.object({ id: z.string(), roleId: z.string(), eventId: z.string(), activityId: z.string(), groupId: z.number(), messageSeq: z.number(), phase: z.enum(['processing', 'completed']), actions: z.object({ processing: outcome.optional(), clear: outcome.optional(), complete: outcome.optional() }), workNeeded: z.boolean(), error: z.string().nullable(), revision: z.number(), updatedAt: z.string() });
type Progress = z.infer<typeof reactionProgressSchema>;
type Action = keyof Progress['actions'];
export type ReactionRequest = { group_id: number; message_seq: number; reaction: string; reaction_type: 'face'; is_add: boolean };

/** 原消息的处理标识独立排队，回执写入后才推进后续表情操作。 */
export class MessageReactions {
  private readonly work = new Map<string, Promise<void>>();
  constructor(readonly store: Store, readonly execute: (roleId: string, args: ReactionRequest, callId: string) => Promise<{ isError: boolean; state?: 'unknown'; error?: unknown }>) {
    store.db.exec("CREATE INDEX IF NOT EXISTS message_reaction_work ON documents(role_id,json_extract(body,'$.workNeeded'),updated_at,id) WHERE kind='message-reaction'");
  }
  private save(record: Progress): Progress {
    const workNeeded = record.phase === 'processing' ? !record.actions.processing : !record.actions.clear || record.actions.clear === 'succeeded' && !record.actions.complete;
    const next = { ...record, workNeeded, revision: record.revision + 1, updatedAt: now() };
    this.store.put('message-reaction', record.id, record.roleId, asJson(next), record.revision, 'system', '更新消息处理表情'); return next;
  }
  observe(event: Experience): void {
    if (!event.roleId || !event.self || event.type !== 'group_message_reaction' || !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) return;
    if (!['424', '282'].includes(String(event.payload.face_id)) || !Number.isSafeInteger(event.payload.message_seq)) return;
    const source = this.store.db.prepare("SELECT id FROM events WHERE account_id=? AND scene='group' AND peer_id=? AND message_seq=? AND role_id=? AND type='message_receive' LIMIT 1").get(event.accountId, event.peerId, event.payload.message_seq as number, event.roleId);
    if (source && this.store.get('message-reaction', `reaction:${String(source.id)}`, reactionProgressSchema)) this.store.markConsolidated([event.id]);
  }
  begin(roleId: string, activityId: string, eventIds: string[]): Promise<void> {
    for (const id of eventIds) {
      const event = this.store.event(id);
      if (event.roleId !== roleId || event.source !== 'milky' || event.type !== 'message_receive' || event.scene !== 'group' || event.self || event.peerId === null || event.messageSeq === null) continue;
      const key = `reaction:${id}`; const existing = this.store.get('message-reaction', key, reactionProgressSchema);
      if (existing) { if (existing.phase === 'processing' && existing.activityId !== activityId) this.save({ ...existing, activityId }); continue; }
      this.store.put('message-reaction', key, roleId, asJson({ id: key, roleId, eventId: id, activityId, groupId: event.peerId, messageSeq: event.messageSeq, phase: 'processing', actions: {}, workNeeded: true, error: null, revision: 1, updatedAt: now() }), null, 'system', '开始处理原始消息');
    }
    return this.enqueue(roleId);
  }
  finish(roleId: string, activityId: string, completed: boolean): Promise<void> {
    if (!completed) return Promise.resolve();
    for (const row of this.store.db.prepare("SELECT id FROM documents WHERE kind='message-reaction' AND role_id=? AND json_extract(body,'$.activityId')=? AND json_extract(body,'$.phase')='processing'").all(roleId, activityId)) {
      const record = this.store.get('message-reaction', String(row.id), reactionProgressSchema)!; this.save({ ...record, phase: 'completed' });
    }
    return this.enqueue(roleId);
  }
  recover(roleId: string): Promise<void> {
    for (const record of this.pending(roleId, true)) {
      const actions = { ...record.actions }; let changed = false;
      for (const key of Object.keys(actions) as Action[]) if (actions[key] === 'started') { actions[key] = 'unknown'; changed = true; }
      const activity = this.store.get('activity', record.activityId, z.object({ state: z.string(), sends: z.object({ succeeded: z.number(), failed: z.number(), unknown: z.number() }) }));
      const phase = activity?.state === 'completed' && !activity.sends.unknown && (!activity.sends.failed || activity.sends.succeeded > 0) ? 'completed' : record.phase;
      if (changed || phase !== record.phase) this.save({ ...record, phase, actions, error: changed ? '重启前的表情操作结果未知，保留原回执，不自动重复调用。' : record.error });
    }
    return this.enqueue(roleId);
  }
  private pending(roleId: string, recovery = false): Progress[] {
    const condition = recovery ? "(json_extract(body,'$.workNeeded')=1 OR json_extract(body,'$.phase')='processing' OR EXISTS(SELECT 1 FROM json_each(body,'$.actions') WHERE value='started'))" : "json_extract(body,'$.workNeeded')=1";
    return this.store.db.prepare(`SELECT id FROM documents WHERE kind='message-reaction' AND role_id=? AND ${condition} ORDER BY updated_at,id${recovery ? '' : ' LIMIT 1'}`).all(roleId).map(row => this.store.get('message-reaction', String(row.id), reactionProgressSchema)!);
  }
  private enqueue(roleId: string): Promise<void> {
    const previous = this.work.get(roleId) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => this.run(roleId)); this.work.set(roleId, task);
    void task.finally(() => { if (this.work.get(roleId) === task) this.work.delete(roleId); }).catch(() => {});
    return task;
  }
  private async run(roleId: string): Promise<void> {
    for (;;) {
      const record = this.pending(roleId)[0]; if (!record) return;
      let action: Action;
      if (record.phase === 'processing' && !record.actions.processing) action = 'processing';
      else if (record.phase === 'completed' && !record.actions.clear) action = 'clear';
      else if (record.phase === 'completed' && record.actions.clear === 'succeeded' && !record.actions.complete) action = 'complete';
      else return;
      this.save({ ...record, actions: { ...record.actions, [action]: 'started' } });
      const args: ReactionRequest = { group_id: record.groupId, message_seq: record.messageSeq, reaction: action === 'complete' ? '282' : '424', reaction_type: 'face', is_add: action !== 'clear' };
      const result = await this.execute(roleId, args, `progress:${record.eventId}:${action}`);
      const latest = this.store.get('message-reaction', record.id, reactionProgressSchema)!;
      this.save({ ...latest, actions: { ...latest.actions, [action]: result.isError ? result.state ?? 'failed' : 'succeeded' }, error: result.isError ? JSON.stringify(result.error ?? '表情操作失败') : null });
    }
  }
  async drain(roleId?: string): Promise<void> { await Promise.all(roleId ? [this.work.get(roleId)] : [...this.work.values()]); }
}
