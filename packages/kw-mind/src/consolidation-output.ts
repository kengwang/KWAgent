import { z } from 'zod';
import { EvidenceError, memoryInputSchema, continuityRequestSchema } from '@kwagent/core';
import { parseModelOutput } from './model-output.ts';
import type { ConsolidationInput } from './consolidation-input.ts';

export const consolidationSchema = z.object({
  memories: z.array(memoryInputSchema.omit({ roleId: true }).partial().extend({ expectedRevision: z.number().int().positive().nullish() }).strict()).max(40).default([]),
  continuity: z.array(z.object({ id: z.string().nullish(), expectedRevision: z.number().int().positive().nullish(), data: z.record(z.string(), z.unknown()), reason: z.string().optional() }).strict()).max(20).default([]),
  persona: z.string().min(1).nullable().optional(), selfState: z.string().nullable().optional(), reason: z.string().min(1).default('根据本批真实来源整理'),
}).strict();
const resultSchema = z.object({
  memories: z.array(memoryInputSchema.omit({ roleId: true }).extend({ expectedRevision: z.number().int().positive().nullable() })),
  continuity: z.array(continuityRequestSchema), persona: z.string().min(1).nullable().optional(), selfState: z.string().nullable().optional(), reason: z.string().min(1),
});

/** 首次提取和修正始终使用同一种业务对象；只合并宿主已核实的旧记录。 */
export function parseConsolidationOutput(_schema: typeof consolidationSchema, text: string, input: ConsolidationInput) {
  const decoded = parseModelOutput(z.unknown(), text);
  let value = decoded.value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    value = { ...object, ...(object.memories === null ? { memories: [] } : {}), ...(object.continuity === null ? { continuity: [] } : {}) };
  }
  const parsed = parseModelOutput(consolidationSchema, JSON.stringify(value));
  const changes = parsed.value;
  const memories = changes.memories.map(change => {
    const previous = change.id ? input.memories.find(item => item.id === change.id) : undefined;
    if (change.id && !previous) throw new EvidenceError(`整理目标记忆不存在于本批输入：${change.id}`);
    if (!previous && change.expectedRevision != null) throw new EvidenceError('创建记忆的expectedRevision必须为null');
    const sources = change.sources ? [...new Set([...(previous?.sources ?? []), ...change.sources])] : previous?.sources;
    const { roleId: _roleId, revision: _revision, createdAt: _created, updatedAt: _updated, ...body } = previous ?? {};
    return { ...body, ...change, id: previous?.id ?? null, expectedRevision: change.expectedRevision ?? previous?.revision ?? null, sources };
  });
  const continuity = changes.continuity.map(change => {
    const previous = change.id ? input.continuity.find(item => item.id === change.id) : undefined;
    if (change.id && !previous && change.id !== `life:${input.role.id}`) throw new EvidenceError(`整理目标连续性记录不存在于本批输入：${change.id}`);
    if (!previous && change.expectedRevision != null) throw new EvidenceError('创建连续性记录的expectedRevision必须为null');
    if (previous && change.data.kind !== undefined && change.data.kind !== previous.data.kind) throw new EvidenceError('整理不能改变已有连续性记录类型');
    const sources = Array.isArray(change.data.sources) ? [...new Set([...(previous?.data.sources ?? []), ...change.data.sources])] : previous?.data.sources;
    return { id: previous?.id ?? change.id ?? null, expectedRevision: change.expectedRevision ?? previous?.revision ?? null,
      reason: change.reason ?? changes.reason, data: { ...previous?.data, ...change.data, ...sources ? { sources } : {} } };
  });
  const result = parseModelOutput(resultSchema, JSON.stringify({ ...changes, memories, continuity }));
  return { value: result.value, repaired: decoded.repaired || parsed.repaired || JSON.stringify(result.value) !== text };
}
