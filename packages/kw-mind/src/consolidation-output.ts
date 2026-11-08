import { z } from 'zod';
import jsonPatch from 'fast-json-patch';
import { EvidenceError } from '@kwagent/core';
import { parseModelOutput } from './model-output.ts';
import type { ConsolidationInput } from './consolidation-input.ts';

const correctionSchema = z.array(z.discriminatedUnion('op', [
  z.object({ op: z.literal('remove'), path: z.string() }).strict(),
  z.object({ op: z.enum(['add', 'replace']), path: z.string(), value: z.unknown() }).strict(),
])).max(100);

export function correctConsolidationOutput(draft: unknown, text: string): unknown {
  const parsed = parseModelOutput(correctionSchema, text);
  try { return jsonPatch.applyPatch(structuredClone(draft) as object, parsed.value as jsonPatch.Operation[], true, false, true).newDocument; }
  catch (cause) { throw new EvidenceError(`整理修正无效：${cause instanceof Error ? cause.message : String(cause)}`, { cause }); }
}

/** 补全宿主已经知道的格式与版本信息，来源、内容和语义仍须严格校验。 */
export function parseConsolidationOutput<T>(schema: z.ZodType<T>, text: string, input: ConsolidationInput) {
  const parsed = parseModelOutput(z.unknown(), text);
  const value = parsed.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return parseModelOutput(schema, text);
  const result = value as Record<string, unknown>;
  if (result.memories === null) result.memories = [];
  if (result.continuity === null) result.continuity = [];
  result.reason ??= '根据本批真实来源整理';
  if (Array.isArray(result.memories)) for (const memory of result.memories) {
    if (!memory || typeof memory !== 'object' || Array.isArray(memory)) continue;
    const previous = input.memories.find(item => item.id === memory.id);
    if (memory.expectedRevision === undefined && (!memory.id || previous)) memory.expectedRevision = previous?.revision ?? null;
    if (!previous && memory.expectedRevision === null) memory.id = null;
  }
  if (Array.isArray(result.continuity)) for (const change of result.continuity) {
    if (!change || typeof change !== 'object' || Array.isArray(change)) continue;
    const previous = input.continuity.find(item => item.id === change.id);
    if (change.expectedRevision === undefined && (!change.id || previous || change.id === `life:${input.role.id}`)) change.expectedRevision = previous?.revision ?? null;
    if (previous && change.revision === previous.revision) delete change.revision;
    if (change.reason === undefined) change.reason = result.reason;
  }
  const normalized = parseModelOutput(schema, JSON.stringify(result));
  return { value: normalized.value, repaired: parsed.repaired || JSON.stringify(value) !== text };
}
