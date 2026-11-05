import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import { ScheduleId } from '@deepseek-ai/dsh-schedule';
import type { ScheduleCreateRequest, ScheduleRecord } from '@deepseek-ai/dsh-schedule';
import rrule from 'rrule';
import { z } from 'zod';
import { asJson, ConflictError, jsonSchema, now, planSchema, continuitySchema, continuityActive } from '@kwagent/core';
import type { Json, LifePlan, Store } from '@kwagent/core';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/);
export const timingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('after'), after_seconds: z.number().int().positive() }),
  z.object({ kind: z.literal('at'), at: z.string().datetime({ offset: true }) }),
  z.object({ kind: z.literal('every'), every_seconds: z.number().int().min(60) }),
  z.object({ kind: z.literal('daily'), daily: z.object({ time, time_zone: z.string().default('Asia/Shanghai') }) }),
  z.object({ kind: z.literal('weekly'), weekly: z.object({ time, time_zone: z.string().default('Asia/Shanghai'), weekdays: z.array(z.number().int().min(1).max(7)).min(1) }) }),
  z.object({ kind: z.literal('cron'), cron: z.object({ expression: z.string().min(1), time_zone: z.string().default('Asia/Shanghai') }) }),
  z.object({ kind: z.literal('rrule'), rrule: z.string().min(1) }),
]);
export const planRequestSchema = z.object({
  action: z.enum(['list', 'create', 'update', 'complete', 'cancel']), id: z.string().optional(),
  expectedRevision: z.number().int().positive().optional(), kind: z.enum(['goal', 'condition', 'time']).optional(),
  title: z.string().min(1).max(120).optional(), instruction: z.string().min(1).optional(),
  timing: timingSchema.optional(), condition: planSchema.shape.condition.optional(),
  context: planSchema.shape.context.optional(), sources: z.array(z.string()).optional(),
  purpose: planSchema.shape.purpose.optional(), relatedRecords: planSchema.shape.relatedRecords.optional(),
});
export type PlanRequest = z.infer<typeof planRequestSchema>;
export const noticeSchema = z.object({ prompt: z.string(), occurrence: z.string() });
export type ScheduleNotice = z.infer<typeof noticeSchema>;

/** 计划保存原始规则，已发布 Harness Schedule 承担实际时间投递。 */
export class Plans {
  private queue: Promise<void> = Promise.resolve();
  private suspended = false;
  private readonly schedule: Context['schedule'];
  constructor(readonly ctx: Context, readonly store: Store) { this.schedule = ctx.schedule; }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await action(); } finally { release(); }
  }
  mutate(roleId: string, request: PlanRequest, authority: Json = null): Promise<LifePlan[] | LifePlan> { return this.exclusive(() => {
    if (this.store.meta(`lifecycle:${roleId}`)) throw new Error('角色正在管理会话，暂时不能修改计划');
    return this.change(roleId, planRequestSchema.parse(request), authority);
  }); }
  private async change(roleId: string, input: PlanRequest, authority: Json): Promise<LifePlan[] | LifePlan> {
    if (input.action === 'list') return this.store.plans(roleId);
    const role = this.store.role(roleId);
    const previous = input.id ? this.store.plan(input.id) : undefined;
    if (previous && previous.roleId !== roleId) throw new Error('计划属于其他角色');
    if (input.action !== 'create' && !previous) throw new Error('需要已有计划 id');
    if (previous && previous.revision !== input.expectedRevision) throw new ConflictError(asJson(previous));
    const stamp = now();
    const kind = input.kind ?? previous?.kind;
    const timing = input.timing ? normalizeTiming(input.timing) : previous?.timing ?? null;
    const plan = planSchema.parse({
      id: previous?.id ?? randomUUID(), roleId, kind,
      title: input.title ?? previous?.title, instruction: input.instruction ?? previous?.instruction,
      condition: kind === 'condition' ? input.condition === undefined ? previous?.condition ?? null : input.condition : null,
      timing: kind === 'time' ? timing : null,
      context: input.context === undefined ? previous?.context ?? null : input.context, sources: input.sources ?? previous?.sources ?? [],
      purpose: input.purpose ?? previous?.purpose ?? 'internal', relatedRecords: input.relatedRecords ?? previous?.relatedRecords ?? [],
      scheduleId: previous?.scheduleId ?? null, status: input.action === 'cancel' ? 'cancelled' : input.action === 'complete' ? 'completed' : 'pending',
      revision: (previous?.revision ?? 0) + 1, error: null, createdAt: previous?.createdAt ?? stamp, updatedAt: stamp,
    });
    if (plan.kind === 'time' && !plan.timing) throw new Error('时间事项需要 timing');
    if (plan.kind === 'condition' && !plan.condition) throw new Error('条件事项需要 condition');
    if (plan.sources.length) this.store.validateSources(roleId, plan.sources);
    for (const id of plan.relatedRecords) { const record = this.store.get('continuity', id, continuitySchema); if (!record || record.roleId !== roleId) throw new Error('关联连续性记录不存在或属于其他角色'); }
    this.store.transaction(() => { this.store.savePlan(plan, previous?.revision ?? null, roleId); this.store.setMeta(`plan-authority:${plan.id}`, authority === null ? '' : JSON.stringify(authority)); });
    await this.reconcile(roleId);
    return this.store.plan(plan.id);
  }
  private decodePrompt(record: ScheduleRecord): { planId: string; revision: number } | undefined {
    return planMarker(record.prompt);
  }
  noticePlan(roleId: string, notice: ScheduleNotice, inputId: string): string | undefined {
    const marker = planMarker(notice.prompt); if (!marker) return;
    const plan = this.store.get('plan', marker.planId, planSchema);
    if (!plan || plan.roleId !== roleId || plan.kind !== 'time' || plan.status === 'cancelled') return;
    const key = `schedule-input:${roleId}:${inputId}`;
    const saved = this.store.meta(key);
    if (saved && z.array(noticeSchema).parse(JSON.parse(saved)).some(item => item.prompt === notice.prompt && item.occurrence === notice.occurrence)) { const versions = JSON.parse(this.store.meta(`${key}:versions`) ?? '{}') as Record<string, number>; if (versions[plan.id] === plan.revision) return plan.id; }
    if (plan.status !== 'active' || plan.revision !== marker.revision) return;
    const timing = timingSchema.parse(plan.timing);
    if (this.store.meta(`occurrence:${plan.id}:${timing.kind === 'at' ? timing.at : notice.occurrence}`)) return;
    if (plan.purpose !== 'internal' && plan.relatedRecords.length && !this.validRelated(roleId, plan.relatedRecords)) return;
    return plan.id;
  }
  reconcileRole(roleId: string): Promise<void> { return this.exclusive(() => this.reconcile(roleId)); }
  private async reconcile(roleId: string): Promise<void> {
    const role = this.store.role(roleId);
    const sessionId = SessionId(role.sessionId);
    const tasks = await this.schedule.list({ sessionId });
    for (const plan of this.store.plans(roleId)) {
      if (plan.purpose !== 'internal' && plan.relatedRecords.length && !this.validRelated(roleId, plan.relatedRecords, true)) {
        for (const task of tasks.filter(task => this.decodePrompt(task)?.planId === plan.id)) await this.schedule.delete({ sessionId, id: task.id });
        if (!['cancelled', 'completed'].includes(plan.status)) this.store.savePlan({ ...plan, status: 'cancelled', scheduleId: null, revision: plan.revision + 1, updatedAt: now() }, plan.revision, 'system');
        continue;
      }
      if (plan.kind !== 'time') {
        for (const task of tasks.filter(task => this.decodePrompt(task)?.planId === plan.id)) await this.schedule.delete({ sessionId, id: task.id });
        if (plan.status === 'pending') this.store.savePlan({ ...plan, status: 'active', scheduleId: null, revision: plan.revision + 1, updatedAt: now() }, plan.revision, roleId);
        continue;
      }
      const matching = tasks.filter(task => this.decodePrompt(task)?.planId === plan.id);
      const active = !this.suspended && role.state === 'active' && ['pending', 'active', 'paused'].includes(plan.status);
      for (const task of matching) {
        const marker = this.decodePrompt(task)!;
        if (!active || marker.revision !== plan.revision || matching.length > 1) await this.schedule.delete({ sessionId, id: task.id });
      }
      if (!active) {
        if (plan.status === 'active' || plan.status === 'pending') this.store.savePlan({ ...plan, status: 'paused', scheduleId: null, revision: plan.revision + 1, updatedAt: now() }, plan.revision, 'system');
        continue;
      }
      const valid = matching.length === 1 && this.decodePrompt(matching[0]!)?.revision === plan.revision;
      if (valid) continue;
      const selector = timingSchema.parse(plan.timing);
      const request: ScheduleCreateRequest = { title: plan.title, prompt: `KWAGENT_PLAN\n${JSON.stringify({ planId: plan.id, revision: plan.revision + 1, instruction: plan.instruction, context: plan.context, sources: plan.sources, purpose: plan.purpose, relatedRecords: plan.relatedRecords })}` };
      if (selector.kind === 'rrule') {
        const next = rrule.rrulestr(selector.rrule).after(new Date());
        if (!next) { this.store.savePlan({ ...plan, status: 'completed', revision: plan.revision + 1, updatedAt: now() }, plan.revision, 'system'); continue; }
        request.at = next.toISOString();
      } else if (selector.kind === 'at' && Date.parse(selector.at) <= Date.now()) {
        request.after_seconds = 1;
      } else {
        const { kind, ...fields } = selector;
        Object.assign(request, fields);
      }
      const task = await this.schedule.create(sessionId, request);
      this.store.savePlan({ ...plan, scheduleId: task.id, status: 'active', revision: plan.revision + 1, updatedAt: now() }, plan.revision, 'system');
    }
  }
  async pause(roleId: string): Promise<void> { await this.reconcileRole(roleId); }
  detachSession(roleId: string, id: string): Promise<void> {
    return this.exclusive(async () => {
      const sessionId = SessionId(id);
      for (const task of await this.schedule.list({ sessionId })) await this.schedule.delete({ sessionId, id: task.id });
      for (const plan of this.store.plans(roleId)) if (plan.kind === 'time' && ['active', 'pending'].includes(plan.status)) this.store.savePlan({ ...plan, status: 'paused', scheduleId: null, revision: plan.revision + 1, updatedAt: now() }, plan.revision, 'system');
    });
  }
  cancelRole(roleId: string): Promise<void> {
    return this.exclusive(async () => { for (const plan of this.store.plans(roleId)) if (!['cancelled', 'completed'].includes(plan.status)) this.store.savePlan({ ...plan, status: 'cancelled', scheduleId: null, revision: plan.revision + 1, updatedAt: now() }, plan.revision, 'owner'); });
  }
  suspend(): Promise<void> { return this.exclusive(async () => { this.suspended = true; for (const role of this.store.roles()) await this.reconcile(role.id); }); }
  resume(): Promise<void> { return this.exclusive(async () => { this.suspended = false; for (const role of this.store.roles()) await this.reconcile(role.id); }); }
  filterNotices(roleId: string, notices: ScheduleNotice[], inputId: string): Promise<ScheduleNotice[]> {
    return this.exclusive(async () => {
      const key = `schedule-input:${roleId}:${inputId}`;
      const saved = this.store.meta(key);
      const versions = JSON.parse(this.store.meta(`${key}:versions`) ?? '{}') as Record<string, number>;
      if (saved) return z.array(noticeSchema).parse(JSON.parse(saved)).filter(notice => {
        if (!notice.prompt.startsWith('KWAGENT_PLAN\n')) return true;
        const marker = planMarker(notice.prompt); if (!marker) return false;
        const plan = this.store.get('plan', marker.planId, planSchema); if (!plan || plan.kind !== 'time') return false;
        const originalRevision = marker.revision;
        const expected = versions[plan.id] ?? originalRevision + (plan.status === 'completed' ? 1 : 0);
        return plan.roleId === roleId && plan.revision === expected && plan.status !== 'cancelled' && (plan.purpose === 'internal' || !plan.relatedRecords.length || this.validRelated(roleId, plan.relatedRecords));
      });
      const admitted = this.store.transaction(() => {
        const selected = notices.filter(notice => this.admitOccurrence(roleId, notice.prompt, notice.occurrence));
        this.store.setMeta(key, JSON.stringify(selected));
        this.saveNoticeVersions(key, selected);
        return selected;
      });
      if (this.store.plans(roleId).some(plan => plan.kind === 'time' && plan.status === 'pending' && timingSchema.parse(plan.timing).kind === 'rrule')) await this.reconcile(roleId);
      this.saveNoticeVersions(key, admitted);
      return admitted;
    });
  }
  private admitOccurrence(roleId: string, prompt: string, occurrence: string): boolean {
    if (!prompt.startsWith('KWAGENT_PLAN\n')) return true;
    const marker = planMarker(prompt); if (!marker) return false;
    const plan = this.store.get('plan', marker.planId, planSchema); if (!plan || plan.kind !== 'time') return false;
    if (plan.roleId !== roleId || plan.revision !== marker.revision || ['completed', 'cancelled'].includes(plan.status)) return false;
    if (plan.purpose !== 'internal' && plan.relatedRecords.length && !this.validRelated(roleId, plan.relatedRecords)) return false;
    const timing = timingSchema.parse(plan.timing);
    const key = `occurrence:${plan.id}:${timing.kind === 'at' ? timing.at : occurrence}`;
    if (this.store.meta(key)) return false;
    this.store.transaction(() => {
      this.store.setMeta(key, now());
      if (['after', 'at', 'rrule'].includes(timing.kind)) this.store.savePlan({ ...plan, status: timing.kind === 'rrule' ? 'pending' : 'completed', scheduleId: null, revision: plan.revision + 1, updatedAt: now() }, plan.revision, roleId);
    });
    return true;
  }
  private validRelated(roleId: string, ids: string[], scheduled = false): boolean {
    return ids.some(id => { const record = this.store.get('continuity', id, continuitySchema); return record?.roleId === roleId && continuityActive({ ...record, data: { ...record.data, applicableAt: scheduled ? null : record.data.applicableAt } }, now()); });
  }
  private saveNoticeVersions(key: string, notices: ScheduleNotice[]): void {
    const versions: Record<string, number> = {};
    for (const notice of notices) { const marker = planMarker(notice.prompt); if (marker) versions[marker.planId] = this.store.plan(marker.planId).revision; }
    this.store.setMeta(`${key}:versions`, JSON.stringify(versions));
  }
}

export function planMarker(prompt: string): { planId: string; revision: number } | undefined {
  if (!prompt.startsWith('KWAGENT_PLAN\n')) return;
  let value: unknown; try { value = JSON.parse(prompt.slice('KWAGENT_PLAN\n'.length)); } catch (error) { if (error instanceof SyntaxError) return; throw error; }
  const parsed = z.object({ planId: z.string(), revision: z.number().int() }).passthrough().safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function normalizeTiming(input: z.infer<typeof timingSchema>, clock = Date.now()): Json {
  const timing = timingSchema.parse(input);
  if (timing.kind === 'after') return { kind: 'at', at: new Date(clock + timing.after_seconds * 1000).toISOString() };
  if (timing.kind === 'rrule') return { kind: 'rrule', rrule: rrule.rrulestr(timing.rrule, { dtstart: new Date(clock) }).toString() };
  return asJson(timing);
}

export function scheduleNotices(text: string): ScheduleNotice[] {
  const batch = /^reminders_json: (.+)$/m.exec(text);
  if (batch) return z.array(z.object({ reminder_prompt: z.string(), occurrence_at: z.string() }).passthrough()).parse(JSON.parse(batch[1]!)).map(item => ({ prompt: item.reminder_prompt, occurrence: item.occurrence_at }));
  const prompt = /^reminder_prompt_json: (.+)$/m.exec(text);
  const occurrence = /^occurrence_at: (.+)$/m.exec(text);
  if (!prompt || !occurrence) return [];
  return [{ prompt: z.string().parse(JSON.parse(prompt[1]!)), occurrence: occurrence[1]! }];
}
