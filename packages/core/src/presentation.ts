import { z } from 'zod';
import { fitBytes, readable } from './budget.ts';
import { asJson, type Json } from './types.ts';

/** 列表只携带身份与有界正文；详情通过对应读取动作获取。 */
export function summary<T>(value: T, bytes: number): T {
  const object = asJson(value);
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error('摘要需要记录对象');
  const bodyKeys = new Set(['payload', 'arguments', 'result', 'value', 'body', 'data', 'analysis', 'condition', 'timing']);
  const result: Record<string, Json> = {};
  for (const [key, item] of Object.entries(object)) {
    if (bodyKeys.has(key)) {
      const text = JSON.stringify(readable(item)); result[key] = Buffer.byteLength(text) > bytes ? { preview: fitBytes(text, Math.max(0, bytes - 128)), truncated: true, read: 'source.read' } : readable(item);
    } else if (typeof item === 'string') result[key] = fitBytes(item, bytes);
    else if (Array.isArray(item)) result[key] = item.slice(0, 50).map(entry => typeof entry === 'string' ? fitBytes(entry, bytes) : entry);
    else result[key] = item;
  }
  return result as T;
}
export const pageSchemaFields = { limit: z.number().int().min(1).max(200).default(50), cursor: z.number().int().nonnegative().default(0) };
