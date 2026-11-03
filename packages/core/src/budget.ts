import { createSystemMessage } from '@deepseek-ai/dsh-llm';
import { estimateSystemMessage } from '@deepseek-ai/dsh-token-meter/estimate';
import type { Json } from './types.ts';

export function tokens(text: string): number { return estimateSystemMessage(createSystemMessage(text)); }
export function fitText(text: string, budget: number): string {
  if (tokens(text) <= budget) return text;
  let low = 0, high = text.length;
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (tokens(text.slice(0, middle)) <= budget) low = middle; else high = middle - 1; }
  if (low && /[\uD800-\uDBFF]/.test(text[low - 1]!)) low--;
  return text.slice(0, low);
}
export function fitBytes(text: string, bytes: number): string {
  let low = 0, high = text.length;
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (Buffer.byteLength(text.slice(0, middle)) <= bytes) low = middle; else high = middle - 1; }
  if (low && /[\uD800-\uDBFF]/.test(text[low - 1]!)) low--;
  return text.slice(0, low);
}
/** 字节内容只提供元数据；原始对象由负载存储保存。 */
export function readable(value: Json, key = ''): Json {
  if (typeof value === 'string') {
    if (/^(data:.*;base64,|base64:\/\/)/i.test(value) || /^(base64|bytes|audio_data|video_data|image_data)$/i.test(key) || (key === 'data' && value.length > 512 && /^[A-Za-z0-9+/=\r\n]+$/.test(value))) return { encoding: 'binary', characters: value.length, state: '未读取字节内容' };
    return value;
  }
  if (Array.isArray(value)) return value.map(item => readable(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, readable(item, name)]));
  return value;
}
export function sourceChunks(text: string, budget: number): string[] {
  const chunks: string[] = [];
  while (text.length) { const part = fitText(text, budget); if (!part) throw new Error('整理预算不足以容纳一个字符'); chunks.push(part); text = text.slice(part.length); }
  return chunks.length ? chunks : [''];
}
