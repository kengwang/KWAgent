import { z } from 'zod';
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session';
import { asJson, operationSchema, type Json } from '@kwagent/core';
import type { Life } from './index.ts';

const requestSchema = z.object({ roleId: z.string().optional(), since: z.string().datetime({ offset: true }), until: z.string().datetime({ offset: true }).optional() }).strict();
interface UsageGroup { provider: string; model: string; category: string; requests: number; failedRequests: number; requestsWithoutUsage: number; inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number }
const object = (value: Json | undefined): Record<string, Json> => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const text = (value: Json | undefined) => typeof value === 'string' ? value : 'unknown';

/** 通过公开 Session 查询读取用量事件，不扫描原生日志或估算供应商账单。 */
export async function usageReport(life: Life, value: Json) {
  const input = requestSchema.parse(value);
  const from = Date.parse(input.since), until = input.until ?? new Date().toISOString(), to = Date.parse(until);
  if (to < from) throw new Error('用量报告结束时间早于开始时间');
  const groups = new Map<string, UsageGroup>();
  const add = (provider: string, model: string, category: string, usage: Record<string, unknown> | null, failed = false) => {
    const key = JSON.stringify([provider, model, category]);
    const group = groups.get(key) ?? { provider, model, category, requests: 0, failedRequests: 0, requestsWithoutUsage: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
    group.requests++; if (failed) group.failedRequests++;
    if (!usage) group.requestsWithoutUsage++;
    else for (const field of ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'] as const) group[field] += typeof usage[field] === 'number' ? usage[field] : 0;
    groups.set(key, group);
  };
  const roles = life.store.roles().filter(role => !input.roleId || role.id === input.roleId);
  if (input.roleId && !roles.length) throw new Error('角色不存在');
  for (const role of roles) {
    const sessions = new Set([role.sessionId]);
    for (const row of life.store.db.prepare("SELECT DISTINCT json_extract(body,'$.sessionId') id FROM revisions WHERE entity='role' AND id=? UNION SELECT DISTINCT json_extract(body,'$.sessionId') FROM documents WHERE kind='activity' AND role_id=?").all(role.id, role.id)) if (row.id) sessions.add(String(row.id));
    for (const id of sessions) {
      const events = await life.context.sessionQuery.listEvents(SessionId(id));
      const headers = events.filter(event => event.type === 'request/header');
      const bodies = new Map<number, Record<string, Json>>();
      const body = async (seq: number) => { if (!bodies.has(seq)) bodies.set(seq, object(asJson((await life.context.sessionQuery.readEvent({ sessionId: SessionId(id), seq: SessionSeq(seq), before: 0, after: 0 })).target.data))); return bodies.get(seq)!; };
      for (const event of events) {
        if (event.time < from || event.time > to || !['assistant/message', 'assistant/attempt', 'compaction/summary'].includes(event.type)) continue;
        const detail = await body(event.seq);
        const header = headers.findLast(header => header.seq < event.seq);
        const config = header ? object(object((await body(header.seq)).header).config) : {};
        const source = object(object(detail.message).source);
        add(text(event.type === 'compaction/summary' ? detail.provider : source.provider ?? config.provider), text(event.type === 'compaction/summary' ? detail.model : source.model ?? config.model), event.type === 'compaction/summary' ? 'compaction' : 'main', detail.usage ? object(detail.usage) : null, event.type === 'assistant/attempt' || Boolean(detail.interrupted));
      }
    }
  }
  for (const row of life.store.db.prepare("SELECT body FROM documents WHERE kind='operation' AND json_extract(body,'$.tool') IN ('memory_consolidate','memory_query_expand','role_generate') AND julianday(json_extract(body,'$.startedAt')) BETWEEN julianday(?) AND julianday(?) AND (? IS NULL OR role_id=?)").all(input.since, until, input.roleId ?? null, input.roleId ?? null)) {
    const operation = operationSchema.parse(JSON.parse(String(row.body))), args = object(operation.arguments);
    let result = object(operation.result);
    if (typeof result.payloadId === 'string' && operation.roleId) result = object(await life.context.kwMind.payloads.value(operation.roleId, result.payloadId));
    let provider = args.provider, model = args.model;
    const inputRef = object(args.inputRef);
    if ((!provider || !model) && typeof inputRef.payloadId === 'string' && operation.roleId) {
      const saved = object(await life.context.kwMind.payloads.value(operation.roleId, inputRef.payloadId));
      const role = object(object(saved.input).role);
      provider ??= role.provider; model ??= role.model;
    }
    add(text(provider), text(model), operation.tool, result.usage ? object(result.usage) : null, operation.state === 'failed');
  }
  return asJson({ since: input.since, until, items: [...groups.values()].map(group => ({ ...group, totalTokens: group.inputTokens + group.cacheReadTokens + group.cacheWriteTokens + group.outputTokens })), fee: '实际费用以供应商账单为准，缺失用量不作推算' });
}
