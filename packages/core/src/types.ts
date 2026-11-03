import { z } from 'zod';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export const jsonSchema: z.ZodType<Json> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(jsonSchema), z.record(z.string(), jsonSchema),
]));
export const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
export const realmSchema = z.enum(['real', 'fictional', 'mixed']);
export const desiredStateSchema = z.enum(['disabled', 'active', 'paused', 'stopped']);
export const roleSchema = z.object({
  id: identifier, accountId: identifier, name: z.string().min(1).max(120),
  initialPersona: z.string().min(1), persona: z.string().min(1),
  selfState: z.string().default(''), worldMode: realmSchema.default('real'),
  provider: z.string().min(1), model: z.string().min(1),
  state: desiredStateSchema.default('disabled'), revision: z.number().int().positive().default(1),
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
export const roleInputSchema = roleSchema.omit({ revision: true, createdAt: true, updatedAt: true, sessionId: true, persona: true, selfState: true })
  .extend({ persona: z.string().optional(), selfState: z.string().optional(), memoryTokens: roleSchema.shape.memoryTokens.optional() });
export type RoleInput = z.infer<typeof roleInputSchema>;

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
  status: z.enum(['pending', 'active', 'paused', 'completed', 'cancelled', 'error']),
  revision: z.number().int().positive(), error: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(),
});
export type LifePlan = z.infer<typeof planSchema>;
export const operationSchema = z.object({
  id: z.string(), roleId: z.string().nullable(), accountId: z.string(), tool: z.string(),
  arguments: jsonSchema, state: z.enum(['started', 'succeeded', 'failed', 'unknown']),
  result: jsonSchema.nullable(), startedAt: z.string(), endedAt: z.string().nullable(),
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
