import { jsonrepair } from 'jsonrepair';
import { z } from 'zod';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { EvidenceError, PersistenceError } from '@kwagent/core';

/** 只修复 JSON 表达，语义和字段继续由 Schema 与实际来源校验。 */
export function parseModelOutput<T>(schema: z.ZodType<T>, text: string): { value: T; repaired: boolean } {
  let value: unknown;
  let repaired = false;
  try { value = JSON.parse(text); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    try { value = JSON.parse(jsonrepair(text)); repaired = true; }
    catch (cause) { throw new EvidenceError(`模型输出无法解析为 JSON：${cause instanceof Error ? cause.message : String(cause)}`, { cause }); }
  }
  try { return { value: schema.parse(value), repaired }; }
  catch (cause) { if (cause instanceof z.ZodError) throw new EvidenceError(`模型输出字段不符合要求：${cause.message}`, { cause }); throw cause; }
}

export function modelRequestFailure(error: unknown): boolean {
  const seen = new Set<unknown>(); const pending = [error]; let network = false;
  while (pending.length) {
    const current = pending.pop(); if (!current || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof PersistenceError) return false;
    if (current && typeof current === 'object' && 'code' in current) {
      const code = String(current.code);
      if (code.startsWith('ERR_SQLITE') || 'path' in current && ['EIO', 'ENOSPC', 'EROFS', 'EACCES', 'EPERM', 'ENOENT'].includes(code)) return false;
      if (['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code)) network = true;
    }
    if (current instanceof AggregateError) pending.push(...current.errors);
    if (current instanceof Error) pending.push(current.cause);
  }
  return error instanceof LlmError || network;
}
