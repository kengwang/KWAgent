import { createHash } from 'node:crypto';
import { z } from 'zod';
import { asJson, now, type Json, type Store } from '@kwagent/core';
import type { SessionEvent } from '@deepseek-ai/dsh-session';

export const activitySchema = z.object({ id: z.string(), roleId: z.string(), sessionId: z.string(), turn: z.number(), startSeq: z.number(), startedAt: z.string(), endedAt: z.string().nullable(), state: z.string(), revision: z.number(), accepted: z.number(), steps: z.number(), sends: z.object({ succeeded: z.number(), failed: z.number(), unknown: z.number() }) });
export type Activity = z.infer<typeof activitySchema>;
function stable(value: Json): Json { return Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key]!)])) : value; }

export class Activities {
  readonly accepted = new Map<string, Set<string>>();
  private readonly awaiting = new Map<string, Set<string>>();
  private readonly repeated = new Map<string, { signature: string; result: string; count: number; warned: boolean }>();
  private readonly nestedRoots = new Set<string>();
  private readonly responded = new Map<string, string>();
  constructor(readonly store: Store) {}
  release(roleId: string): void {
    const activity = this.current(roleId); if (activity?.state === 'running') this.save({ ...activity, state: 'interrupted', endedAt: now() });
    this.store.setMeta(`activity:${roleId}`, ''); this.accepted.delete(roleId); this.awaiting.delete(roleId);
    this.responded.delete(roleId);
    for (const key of this.repeated.keys()) if (key.startsWith(`${roleId}:`)) this.repeated.delete(key);
    for (const key of this.nestedRoots) if (key.startsWith(`${roleId}:`)) this.nestedRoots.delete(key);
  }
  current(roleId: string): Activity | undefined { const id = this.store.meta(`activity:${roleId}`); return id ? this.store.get('activity', id, activitySchema) : undefined; }
  restore(roleId: string, events: readonly SessionEvent[]): void {
    const accepted = new Set<string>(); let responded: string | undefined; let completed = 0;
    for (const event of events) {
      if (event.type === 'user/message') accepted.add(event.data.id);
      else if (event.type === 'assistant/message' && !event.data.interrupted) responded = `${event.data.turn}:${event.data.step}`;
      else if (event.type === 'step/end' && responded === `${event.data.turn}:${event.data.step}`) { completed = accepted.size; responded = undefined; }
    }
    this.accepted.set(roleId, accepted);
    if (completed) this.store.completeDelivered(roleId, [...accepted].slice(0, completed));
    this.awaiting.set(roleId, new Set([...accepted].slice(completed)));
  }
  complete(roleId: string): void {
    const awaiting = this.awaiting.get(roleId); if (!awaiting?.size) return;
    this.store.completeDelivered(roleId, [...awaiting]); awaiting.clear();
  }
  private save(value: Activity): void { this.store.put('activity', value.id, value.roleId, asJson({ ...value, revision: value.revision + 1 }), value.revision, 'system', '活动状态变化'); }
  event(roleId: string, sessionId: string, event: SessionEvent): void {
    if (event.type === 'assistant/message' && !event.data.interrupted) this.responded.set(roleId, `${event.data.turn}:${event.data.step}`);
    if (event.type === 'step/end' && this.responded.get(roleId) === `${event.data.turn}:${event.data.step}`) { this.complete(roleId); this.responded.delete(roleId); }
    if (event.type === 'turn/start') {
      const id = `activity-${createHash('sha256').update(`${sessionId}:${event.seq}`).digest('hex')}`;
      const value: Activity = { id, roleId, sessionId, turn: event.data.turn, startSeq: event.seq, startedAt: new Date(event.time).toISOString(), endedAt: null, state: 'running', accepted: 0, steps: 0, sends: { succeeded: 0, failed: 0, unknown: 0 }, revision: 1 };
      if (!this.store.get('activity', id, activitySchema)) this.store.put('activity', id, roleId, asJson(value), null, 'system', '开始活动');
      this.store.setMeta(`activity:${roleId}`, id); for (const key of this.repeated.keys()) if (key.startsWith(`${roleId}:`)) this.repeated.delete(key);
    }
    const activity = this.current(roleId);
    if (event.type === 'user/message') {
      const accepted = this.accepted.get(roleId) ?? new Set<string>(); accepted.add(event.data.id); this.accepted.set(roleId, accepted);
      const awaiting = this.awaiting.get(roleId) ?? new Set<string>(); awaiting.add(event.data.id); this.awaiting.set(roleId, awaiting);
      if (String(event.data.source.kind) === 'runtime-context') return;
      if (!activity) return;
      this.store.link(activity.id, 'input', event.data.id, { seq: event.seq, source: asJson(event.data.source), state: 'accepted', time: event.time });
      if (event.data.source.kind === 'kw-event') {
        this.store.link(activity.id, 'perception', event.data.id, { seq: event.seq });
        for (const id of event.data.source.eventIds) {
          this.store.db.prepare('UPDATE events SET activity_id=? WHERE id=? AND role_id=?').run(activity.id, id, roleId);
          this.store.link(activity.id, 'source', id);
        }
      } else {
        const wake = this.store.appendEvent({ id: `wake:${roleId}:${event.data.id}`, accountId: this.store.role(roleId).accountId, roleId, source: String(event.data.source.kind) === 'schedule' ? 'schedule' : 'system', type: 'accepted-wake', occurredAt: new Date(event.time).toISOString(), scene: null, peerId: null, senderId: null, messageSeq: null, self: true, payload: asJson({ messageId: event.data.id, source: event.data.source }) }).event;
        this.store.link(activity.id, 'source', wake.id);
      }
      this.save({ ...activity, accepted: activity.accepted + 1 });
    } else if (activity && event.type === 'step/start') {
      this.store.link(activity.id, 'step', String(event.data.step), { seq: event.seq, startedAt: event.time });
      this.save({ ...activity, steps: activity.steps + 1 });
    } else if (activity && event.type === 'step/end') {
      this.store.link(activity.id, 'step-end', String(event.data.step), { seq: event.seq, endedAt: event.time });
    } else if (activity && event.type === 'turn/end') {
      this.save({ ...activity, endedAt: new Date(event.time).toISOString(), state: event.data.reason.kind });
      this.store.setMeta(`activity:${roleId}`, '');
    } else if (activity && (event.type.startsWith('assistant/') || event.type.startsWith('request/'))) {
      this.store.link(activity.id, 'session', String(event.seq), { seq: event.seq, type: event.type, time: event.time });
    }
  }
  tool(roleId: string, executionId: string, callId: string, rootCallId: string, name: string, result: Json): void {
    const activity = this.current(roleId); if (!activity) return;
    this.store.link(activity.id, 'tool', executionId, { callId, rootCallId, name, at: now(), result });
    const operations = this.store.db.prepare("SELECT body FROM documents WHERE kind='operation' AND role_id=? AND json_extract(body,'$.executionId')=?").all(roleId, executionId);
    for (const row of operations) {
      const operation = JSON.parse(String(row.body)); this.store.link(activity.id, 'receipt', operation.id, { callId, state: operation.state, tool: operation.tool });
      if (/^send_(group|private|temp)_message$/.test(operation.tool) && ['succeeded', 'failed', 'unknown'].includes(operation.state)) {
        const sends = { ...activity.sends }; sends[operation.state as keyof typeof sends]++; this.save({ ...activity, sends });
      }
    }
  }
  noProgress(roleId: string, name: string, args: Json, result: Json, correlation?: { callId: string; rootCallId: string }): boolean {
    const root = correlation ? `${roleId}:${correlation.rootCallId}` : '';
    if (correlation && correlation.callId !== correlation.rootCallId) this.nestedRoots.add(root);
    if (correlation && correlation.callId === correlation.rootCallId && this.nestedRoots.delete(root)) return false;
    const key = `${roleId}:${name}`; const signature = JSON.stringify(stable({ name, args })); const output = JSON.stringify(stable(result)); const previous = this.repeated.get(key);
    const state = previous?.signature === signature && previous.result === output ? { ...previous, count: previous.count + 1 } : { signature, result: output, count: 1, warned: false };
    const warn = state.count >= 3 && !state.warned; if (warn) state.warned = true; this.repeated.set(key, state); return warn;
  }
}
