import { z } from 'zod';
import { realmSchema } from './types.ts';

export const sceneSchema = z.object({ scene: z.enum(['group', 'private']), peerId: z.number().int().positive() }).strict();
const time = z.string().datetime({ offset: true });
const base = z.object({
  title: z.string().min(1).max(240), content: z.string().min(1), realm: realmSchema.default('real'),
  people: z.array(z.string().regex(/^[1-9][0-9]*$/)).default([]), context: sceneSchema.nullable().default(null),
  sources: z.array(z.string()).describe('真实原始事件或操作ID；payloadId和callId不属于来源ID').default([]), memories: z.array(z.string()).describe('已有记忆ID，正文写content，没有关联时为空数组').default([]), plans: z.array(z.string()).describe('已有计划ID，不能填写计划正文；没有关联时为空数组').default([]),
  relatedRecords: z.array(z.string()).describe('其他已有连续性记录ID').default([]), applicableAt: time.nullable().default(null), expiresAt: time.nullable().default(null),
});
export const continuityDataSchema = z.discriminatedUnion('kind', [
  base.extend({ kind: z.literal('life'), status: z.enum(['active', 'archived']).default('active'),
    activity: z.object({ title: z.string().min(1), state: z.enum(['planned', 'in_progress', 'paused', 'completed', 'cancelled']), progress: z.string(), sources: z.array(z.string()).default([]) }).strict().nullable().default(null),
    concerns: z.array(z.string()).default([]), emotions: z.array(z.object({ text: z.string().min(1), reason: z.string().min(1), formedAt: time, expiresAt: time.optional() }).strict()).default([]),
  }).strict(),
  base.extend({ kind: z.literal('relationship'), status: z.enum(['active', 'archived']).default('active'), uncertainty: z.string().default(''), basis: z.enum(['reported', 'inferred']).default('inferred') }).strict(),
  base.extend({ kind: z.literal('thread'), status: z.enum(['active', 'deferred', 'resolved', 'declined', 'cancelled', 'expired']).default('active'),
    expectedAt: time.nullable().default(null), reviewAt: time.nullable().default(null), answer: z.string().default(''),
    followups: z.array(z.object({ operationId: z.string(), note: z.string(), pending: z.boolean().default(false) }).strict()).default([]),
  }).strict(),
  base.extend({ kind: z.literal('conversation'), status: z.enum(['open', 'closed', 'deferred', 'archived']).default('open'), decision: z.enum(['share', 'ask', 'invite', 'defer', 'skip', 'internal']).default('internal'), reviewAt: time.nullable().default(null) }).strict(),
  base.extend({ kind: z.literal('expression'), status: z.enum(['candidate', 'adopted', 'disabled', 'archived']).default('candidate'), examples: z.array(z.string().min(1)).min(1), situations: z.array(z.string()).default([]) }).strict(),
  base.extend({ kind: z.literal('reflection'), status: z.enum(['active', 'archived']).default('active'), situations: z.array(z.string()).default([]) }).strict(),
  base.extend({ kind: z.literal('journal'), status: z.enum(['active', 'archived']).default('active') }).strict(),
]);
export type ContinuityData = z.infer<typeof continuityDataSchema>;
export const continuitySchema = z.object({ id: z.string(), roleId: z.string(), data: continuityDataSchema, revision: z.number().int().positive(), createdAt: time, updatedAt: time, actor: z.string(), reason: z.string().min(1), activityId: z.string().nullable() }).strict();
export type ContinuityRecord = z.infer<typeof continuitySchema>;
export const continuityRequestSchema = z.object({ id: z.string().optional(), expectedRevision: z.number().int().positive().nullable(), data: continuityDataSchema, reason: z.string().min(1) }).strict();
export type ContinuityRequest = z.infer<typeof continuityRequestSchema>;
export const continuityKindSchema = z.enum(['life', 'relationship', 'thread', 'conversation', 'expression', 'reflection', 'journal']);
export const continuityQuerySchema = z.object({ id: z.string().optional(), history: z.boolean().default(false), kind: continuityKindSchema.optional(), kinds: z.array(continuityKindSchema).optional(), person: z.string().optional(), context: sceneSchema.optional(), status: z.string().optional(), query: z.string().default(''), since: time.optional(), until: time.optional(), cursor: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(200).default(50) }).strict();
export type ContinuityQuery = z.infer<typeof continuityQuerySchema>;
export interface ContinuityScene { eventIds: string[]; people: string[]; contexts: z.infer<typeof sceneSchema>[]; planIds: string[]; recordIds: string[]; query: string }
export function continuityActive(record: ContinuityRecord, at: string): boolean {
  const data = record.data;
  return !['archived', 'resolved', 'declined', 'cancelled', 'expired', 'disabled', 'candidate', 'closed'].includes(data.status)
    && (!data.applicableAt || Date.parse(data.applicableAt) <= Date.parse(at)) && (!data.expiresAt || Date.parse(data.expiresAt) > Date.parse(at));
}
