import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EvidenceError, fitText, tokens, type Memory, type MemoryHit, type Recall, type Store, type Json } from '@kwagent/core';
import { queryTerms } from './local-recall.ts';

const cursorSchema = z.object({ query: z.string(), revision: z.number().int().nonnegative(), offset: z.number().int().nonnegative() }).strict();
export function searchPosition(store: Store, query: Recall) {
  const { cursor, ...filters } = query;
  const key = createHash('sha256').update(JSON.stringify(filters)).digest('hex');
  const revision = Number(store.db.prepare("SELECT coalesce(max(r.seq),0) value FROM revisions r JOIN documents d ON d.kind=r.entity AND d.id=r.id WHERE r.entity IN ('memory','query-expansion') AND d.role_id=?").get(query.roleId)?.value);
  let offset = 0;
  if (cursor) {
    let value: z.infer<typeof cursorSchema>;
    try { value = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))); }
    catch (cause) { throw new EvidenceError('检索游标无效，请重新查询', { cause }); }
    if (value.query !== key || value.revision !== revision) throw new EvidenceError('检索资料或条件已变化，游标已失效，请重新查询；此前结果仍可按标识读取');
    offset = value.offset;
  }
  return { offset, cursor: (next: number) => Buffer.from(JSON.stringify({ query: key, revision, offset: next })).toString('base64url') };
}

export function memoryHit(memory: Memory, query: string): MemoryHit {
  const terms = queryTerms(query);
  const lower = memory.content.toLowerCase();
  const position = terms.map(term => lower.indexOf(term)).filter(index => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const snippet = fitText(memory.content.slice(Math.max(0, position - 100)), 256);
  return { id: memory.id, roleId: memory.roleId, revision: memory.revision, kind: memory.kind, title: fitText(memory.title, 64),
    realm: memory.realm, epistemic: memory.epistemic, createdAt: memory.createdAt, updatedAt: memory.updatedAt,
    people: memory.people.slice(0, 10), peopleCount: memory.people.length, snippet, sourceCount: memory.sources.length,
    read: { tool: 'memory_read', arguments: { id: memory.id } } };
}

/** 页大小同时服从条目数和实际序列化预算，游标只跨过已返回条目。 */
export function boundedPage<T, C extends string | number>(rows: T[], offset: number, limit: number, budget: number, cursor: (offset: number) => C) {
  const items: T[] = [];
  for (const row of rows.slice(0, limit)) {
    const nextCursor = rows.length > items.length + 1 ? cursor(offset + items.length + 1) : null;
    if (tokens(JSON.stringify([{ type: 'text', text: JSON.stringify({ items: [...items, row], nextCursor }) }])) > budget) break;
    items.push(row);
  }
  if (rows.length && !items.length) throw new EvidenceError('单条查询摘要超过工具预览预算，请缩小筛选条件或提高工具预览预算');
  return { items, nextCursor: rows.length > items.length ? cursor(offset + items.length) : null };
}

export function compactContinuity(record: { id: string; roleId: string; revision: number; createdAt: string; updatedAt: string; data: Record<string, unknown> }): Json {
  const data = record.data;
  const people = Array.isArray(data.people) ? data.people as string[] : [];
  return { id: record.id, roleId: record.roleId, revision: record.revision, createdAt: record.createdAt, updatedAt: record.updatedAt,
    kind: String(data.kind), title: fitText(String(data.title), 64), status: String(data.status), content: fitText(String(data.content), 256),
    realm: String(data.realm), context: (data.context ?? null) as Json, expiresAt: (data.expiresAt ?? null) as Json,
    people: people.slice(0, 10), peopleCount: people.length, sourceCount: Array.isArray(data.sources) ? data.sources.length : 0,
    read: { tool: 'continuity_read', arguments: { id: record.id } } };
}
