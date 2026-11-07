import { z } from 'zod';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export const jsonSchema: z.ZodType<Json> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(jsonSchema), z.record(z.string(), jsonSchema),
]));
export const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const milkyIdSchema = z.union([z.number(), z.string().regex(/^[1-9][0-9]*$/).transform(Number)]).pipe(z.number().int().positive().safe());
export function milkyId(value: unknown): number { return milkyIdSchema.parse(value); }
export function toolConversation(args: Record<string, unknown>, tool?: string) {
  if (tool === 'send_temp_message') return args.user_id !== undefined ? { scene: 'private' as const, peerId: milkyId(args.user_id) } : null;
  if (args.group_id !== undefined) return { scene: 'group' as const, peerId: milkyId(args.group_id) };
  if (args.user_id !== undefined) return { scene: 'private' as const, peerId: milkyId(args.user_id) };
  return null;
}
export const realmSchema = z.enum(['real', 'fictional', 'mixed']);
export const desiredStateSchema = z.enum(['disabled', 'active', 'paused', 'stopped']);
export const roleSchema = z.object({
  id: identifier, accountId: identifier, name: z.string().min(1).max(120),
  initialPersona: z.string().min(1), persona: z.string().min(1),
  selfState: z.string().default(''), worldMode: realmSchema.default('real'),
  expressionExamples: z.array(z.string().min(1)).default([]),
  preinjectSkills: z.array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Skill 名称使用小写字母、数字和连字符')).refine(names => new Set(names).size === names.length, '预注入 Skill 名称不能重复').default([]),
  adminQQs: z.array(z.number().int().positive().safe()).refine(ids => new Set(ids).size === ids.length, '角色管理员 QQ 不能重复').default([]),
  personaSources: z.array(z.string()).default([]),
  provider: z.string().min(1), model: z.string().min(1),
  chatPresetId: z.string().nullable().default(null), visionPresetId: z.string().nullable().default(null), imagePresetId: z.string().nullable().default(null),
  reasoningEffort: z.string().min(1).max(64).nullable().default(null),
  state: desiredStateSchema.default('disabled'), revision: z.number().int().positive().default(1),
  deletedAt: z.string().nullable().default(null),
  sessionId: z.string().min(1), groups: z.array(z.number().int().positive()).default([]),
  contacts: z.array(z.number().int().positive()).default([]),
  globalGroups: z.boolean().default(false), defaultPrivate: z.boolean().default(false),
  memoryTokens: z.number().int().min(256).max(131072).default(8192),
  dailyRequests: z.number().int().positive().nullable().default(null),
  dailyTokens: z.number().int().positive().nullable().default(null),
  activeHours: z.object({ start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }).nullable().default(null),
  createdAt: z.string(), updatedAt: z.string(),
});
export type Role = z.infer<typeof roleSchema>;
export const roleInputSchema = roleSchema.omit({ revision: true, createdAt: true, updatedAt: true, sessionId: true, persona: true, selfState: true, personaSources: true, deletedAt: true })
  .extend({ persona: z.string().optional(), selfState: z.string().optional(), expressionExamples: roleSchema.shape.expressionExamples.optional(), preinjectSkills: roleSchema.shape.preinjectSkills.optional(), adminQQs: roleSchema.shape.adminQQs.optional(), memoryTokens: roleSchema.shape.memoryTokens.optional(), reasoningEffort: roleSchema.shape.reasoningEffort.optional(), chatPresetId: roleSchema.shape.chatPresetId.optional(), visionPresetId: roleSchema.shape.visionPresetId.optional(), imagePresetId: roleSchema.shape.imagePresetId.optional() });
export type RoleInput = z.infer<typeof roleInputSchema>;

/** 局部修改只保留实际提交的字段，创建默认值不进入修改内容。 */
export const rolePatchSchema = z.record(z.string(), z.unknown()).transform((input): Partial<Role> => {
  const parsed = roleSchema.partial().parse(input);
  return Object.fromEntries(Object.entries(parsed).filter(([key]) => Object.hasOwn(input, key))) as Partial<Role>;
});

export const eventSchema = z.object({
  id: z.string(), seq: z.number().int(), accountId: z.string(), roleId: z.string().nullable(),
  source: z.enum(['milky', 'tool', 'schedule', 'manual', 'system', 'media', 'handoff']),
  type: z.string(), occurredAt: z.string(), receivedAt: z.string(),
  scene: z.string().nullable(), peerId: z.number().int().nullable(),
  senderId: z.number().int().nullable(), messageSeq: z.number().int().nullable(),
  self: z.boolean(), payload: jsonSchema, activityId: z.string().nullable(),
});
export type Experience = z.infer<typeof eventSchema>;
export type EventInput = Omit<Experience, 'id' | 'seq' | 'receivedAt' | 'activityId'> & { id?: string };

export const perceptionFrameSchema = z.object({
  id: z.string(), roleId: z.string(), messageId: z.string(), normalizerVersion: z.number().int().positive(),
  eventIds: z.array(z.string()).readonly(),
  contentRef: z.object({ payloadId: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative(), mime: z.string(), source: z.string() }).readonly(),
  budget: z.object({ limit: z.number().int().positive(), estimatedTokens: z.number().int().nonnegative() }).readonly(),
  omitted: z.number().int().nonnegative(), instruction: z.string(), content: z.array(jsonSchema).readonly(),
}).readonly();
export type PerceptionFrame = z.infer<typeof perceptionFrameSchema>;
export function freezeJson<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freezeJson(item); Object.freeze(value); }
  return value;
}

export const memorySchema = z.object({
  id: z.string(), roleId: z.string(), kind: z.enum(['episode', 'self', 'person', 'relationship', 'world', 'promise', 'focus']),
  title: z.string().min(1).max(240), content: z.string().min(1), realm: realmSchema,
  epistemic: z.enum(['observed', 'reported', 'inferred', 'fictional']),
  people: z.array(z.string()).default([]), aliases: z.array(z.string()).default([]),
  sources: z.array(z.string()).min(1), archived: z.boolean().default(false),
  attention: z.number().min(0).max(1).default(0.5), revision: z.number().int().positive(),
  createdAt: z.string(), updatedAt: z.string(),
});
export type Memory = z.infer<typeof memorySchema>;
export const memoryInputSchema = memorySchema.omit({ id: true, revision: true, createdAt: true, updatedAt: true }).extend({ id: z.string().nullable().optional() });
export type MemoryInput = z.infer<typeof memoryInputSchema>;
export const recallSchema = z.object({
  roleId: z.string(), query: z.string().default(''), kind: memorySchema.shape.kind.optional(),
  realm: realmSchema.optional(), person: z.string().optional(), since: z.string().optional(),
  until: z.string().optional(), limit: z.number().int().min(1).max(100).default(20),
  scene: z.enum(['group', 'private']).optional(), peerId: z.number().int().positive().optional(),
  semantic: z.boolean().default(true), archived: z.boolean().default(false),
});
export type Recall = z.infer<typeof recallSchema>;

export const planSchema = z.object({
  id: z.string(), roleId: z.string(), kind: z.enum(['goal', 'condition', 'time']),
  title: z.string().min(1).max(120), instruction: z.string().min(1),
  condition: z.object({ eventTypes: z.array(z.string()), peerIds: z.array(z.number().int()), text: z.string() }).nullable(),
  timing: jsonSchema.nullable(), scheduleId: z.string().nullable(),
  context: z.object({ scene: z.enum(['group', 'private']), peerId: z.number().int().positive() }).nullable().default(null),
  purpose: z.enum(['internal', 'review', 'contact']).default('internal'), relatedRecords: z.array(z.string()).default([]),
  sources: z.array(z.string()).default([]),
  status: z.enum(['pending', 'active', 'paused', 'completed', 'cancelled', 'error']),
  revision: z.number().int().positive(), error: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(),
});
export type LifePlan = z.infer<typeof planSchema>;
export const operationSchema = z.object({
  id: z.string(), roleId: z.string().nullable(), accountId: z.string(), tool: z.string(),
  arguments: jsonSchema, state: z.enum(['started', 'succeeded', 'failed', 'unknown']),
  result: jsonSchema.nullable(), startedAt: z.string(), endedAt: z.string().nullable(),
  callId: z.string().nullable().default(null), rootCallId: z.string().nullable().default(null),
  executionId: z.string().nullable().default(null),
  context: z.object({ scene: z.enum(['group', 'private']), peerId: z.number().int().positive() }).nullable().default(null),
});
export type Operation = z.infer<typeof operationSchema>;
export const mediaSchema = z.object({
  id: z.string(), roleId: z.string(), eventId: z.string().nullable(), name: z.string(),
  path: z.string(), mime: z.string(), bytes: z.number().int(), sha256: z.string(),
  createdAt: z.string(), analysis: jsonSchema.nullable(),
});
export type Media = z.infer<typeof mediaSchema>;
export const extensionSchema = z.object({
  id: identifier, roleId: z.string(), packageName: z.string(), spec: z.string(), directory: z.string(),
  entry: z.string(), client: z.boolean(), enabled: z.boolean(), revision: z.number().int(),
  state: z.enum(['installed', 'enabled', 'disabled', 'pending-restart', 'error']),
  error: z.string().nullable(), updatedAt: z.string(),
});
export type Extension = z.infer<typeof extensionSchema>;
export interface Revision { entity: string; id: string; revision: number; actor: string; reason: string; value: Json; time: string }
export class ConflictError extends Error {
  readonly code = 'revision_conflict';
  constructor(readonly current: Json) { super('内容已经更新，请读取当前版本后重新提交'); }
}
export class CapabilityError extends Error {
  readonly code = 'capability_unavailable';
}
export class EvidenceError extends Error {}
export class PersistenceError extends Error { readonly code = 'persistence_failure'; }
export function now(): string { return new Date().toISOString(); }
export function asJson(value: unknown): Json { return jsonSchema.parse(value); }
export function errorText(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  while (error !== undefined && !seen.has(error)) {
    seen.add(error); messages.push(error instanceof Error ? error.message : String(error));
    error = error instanceof Error ? error.cause : undefined;
  }
  return messages.join('：');
}
