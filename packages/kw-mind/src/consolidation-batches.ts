import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { asJson, roleSchema, memorySchema, continuitySchema, PersistenceError, type Store, type Payloads, type Json } from '@kwagent/core';
import type { ConsolidationInput } from './consolidation-input.ts';

const refSchema = z.object({ payloadId: z.string(), bytes: z.number(), mime: z.string(), source: z.string() });
export const batchInputSchema = z.object({ role: roleSchema, validationFeedback: z.string(), sources: z.array(z.object({ id: z.string(), part: z.number(), total: z.number(), payloadId: z.string(), text: z.string(), sourceMeaning: z.string() })), memories: z.array(memorySchema), continuity: z.array(continuitySchema) });
const batchSchema = z.object({ id: z.string(), protocol: z.literal(2), inputRef: refSchema, attempts: z.number().int().nonnegative(), round: z.number().int().positive(),
  feedback: z.string(), draft: z.unknown().optional(), responseRef: refSchema.nullable(), operationId: z.string().nullable(), status: z.enum(['pending', 'deferred', 'completed']), retryAt: z.number().nullable(), operations: z.array(z.string()) });
export type ConsolidationBatch = z.infer<typeof batchSchema>;

/** 同一批次始终引用固定来源；草稿、请求和提交状态随备份一起保存。 */
export class ConsolidationBatches {
  constructor(readonly store: Store, readonly payloads: Payloads) {}
  current(roleId: string): ConsolidationBatch | undefined {
    const id = this.store.meta(`consolidation-batch:${roleId}`);
    if (!id) return undefined;
    const batch = this.store.get('consolidation-batch', id, batchSchema);
    const owner = this.store.db.prepare("SELECT role_id FROM documents WHERE kind='consolidation-batch' AND id=?").get(id);
    if (!batch || owner?.role_id !== roleId || batch.status === 'completed') throw new PersistenceError('整理批次指针缺失、归属错误或状态不一致');
    return batch;
  }
  async create(roleId: string, input: ConsolidationInput, signal?: AbortSignal) {
    const inputRef = await this.payloads.put(roleId, 'consolidation-batch-input', asJson(input), signal);
    const batch: ConsolidationBatch = { id: randomUUID(), protocol: 2, inputRef, attempts: 0, round: 1, feedback: '', responseRef: null, operationId: null, status: 'pending', retryAt: null, operations: [] };
    this.store.transaction(() => { this.save(roleId, batch); this.store.setMeta(`consolidation-batch:${roleId}`, batch.id); });
    return batch;
  }
  async input(roleId: string, batch: ConsolidationBatch, signal?: AbortSignal): Promise<ConsolidationInput> { return batchInputSchema.parse(await this.payloads.value(roleId, batch.inputRef.payloadId, signal)); }
  save(roleId: string, batch: ConsolidationBatch): void {
    const row = this.store.db.prepare("SELECT revision FROM documents WHERE kind='consolidation-batch' AND id=?").get(batch.id);
    this.store.put('consolidation-batch', batch.id, roleId, asJson(batchSchema.parse(batch)), row ? Number(row.revision) : null, 'system', '保存整理批次进度');
  }
  complete(roleId: string, batch: ConsolidationBatch): void {
    this.save(roleId, { ...batch, status: 'completed', responseRef: null, retryAt: null });
    this.store.setMeta(`consolidation-batch:${roleId}`, '');
  }
  async response(roleId: string, batch: ConsolidationBatch, value: Json, signal?: AbortSignal) {
    batch.responseRef = await this.payloads.put(roleId, `consolidation-response:${batch.id}:${batch.operations.length}`, value, signal);
    this.save(roleId, batch);
  }
}
