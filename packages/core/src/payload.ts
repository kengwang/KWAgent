import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { isUtf8 } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Store } from './store.ts';
import { now, asJson, roleSchema, toolConversation, type Json, type Operation } from './types.ts';
import { fitText, readable, tokens } from './budget.ts';

export const payloadReadSchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(4).max(65536).default(4096) }).strict();
export interface PayloadRef { payloadId: string; bytes: number; mime: string; source: string }

/** 对象先完成原子落盘，数据库引用随后提交；内容以 SHA-256 寻址。 */
export class Payloads {
  constructor(readonly store: Store, readonly directory: string) {}
  private path(id: string): string { return join(this.directory, id.slice(0, 2), id); }
  references(roleId: string, value: Json): PayloadRef[] {
    const refs = new Map<string, PayloadRef>();
    const visit = (item: Json): void => {
      if (!item || typeof item !== 'object') return;
      if (!Array.isArray(item) && typeof item.payloadId === 'string' && /^[a-f0-9]{64}$/.test(item.payloadId)) {
        const row = this.store.db.prepare('SELECT bytes,mime,source FROM payloads WHERE id=? AND role_id=? LIMIT 1').get(item.payloadId, roleId);
        if (row) refs.set(item.payloadId, { payloadId: item.payloadId, bytes: Number(row.bytes), mime: String(row.mime), source: String(row.source) });
      }
      for (const child of Object.values(item)) visit(child);
    };
    visit(value); return [...refs.values()];
  }
  private authorizedPath(roleId: string, id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id) || !this.store.db.prepare('SELECT 1 FROM payloads WHERE id=? AND role_id=? LIMIT 1').get(id, roleId)) throw new Error('负载不存在或属于其他角色');
    return this.path(id);
  }
  private decode(id: string, bytes: Buffer): Json {
    if (createHash('sha256').update(bytes).digest('hex') !== id) throw new Error('负载校验和不一致');
    return asJson(JSON.parse(bytes.toString('utf8')));
  }
  async value(roleId: string, id: string, signal?: AbortSignal): Promise<Json> {
    return this.decode(id, await readFile(this.authorizedPath(roleId, id), { signal }));
  }
  valueSync(roleId: string, id: string): Json {
    return this.decode(id, readFileSync(this.authorizedPath(roleId, id)));
  }
  operationContext(operation: Operation) {
    if (operation.context && (operation.tool !== 'send_temp_message' || operation.context.scene === 'private')) return operation.context;
    let value = operation.arguments;
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.payloadId === 'string') {
      if (!operation.roleId) throw new Error('操作负载缺少角色归属');
      value = this.valueSync(operation.roleId, value.payloadId);
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? toolConversation(value, operation.tool) : null;
  }
  async put(roleId: string, source: string, value: Json, signal?: AbortSignal): Promise<PayloadRef> {
    try {
    if (!this.store.get('role', roleId, roleSchema)) throw new Error('负载所属角色不存在');
    signal?.throwIfAborted();
    const body = JSON.stringify(value); const bytes = Buffer.byteLength(body); const id = createHash('sha256').update(body).digest('hex');
    const path = this.path(id); await mkdir(join(this.directory, id.slice(0, 2)), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.partial`;
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(body, { encoding: 'utf8', signal }); await file.sync(); } finally { await file.close(); }
    try { await rename(temporary, path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      if (createHash('sha256').update(await readFile(path)).digest('hex') !== id) throw error;
      await unlink(temporary);
    }
    if (process.platform !== 'win32') { const directory = await open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
    signal?.throwIfAborted();
    this.store.db.prepare('INSERT OR IGNORE INTO payloads VALUES(?,?,?,?,?,?)').run(id, roleId, bytes, 'application/json', source, now());
    return { payloadId: id, bytes, mime: 'application/json', source };
    } catch (error) { if (!signal?.aborted) this.store.changes.emit('payload-error', roleId, error); throw error; }
  }
  async view(roleId: string, source: string, value: Json, budget: number, signal?: AbortSignal): Promise<Json> {
    const cleaned = readable(value); const text = JSON.stringify(cleaned);
    if (tokens(text) <= budget && JSON.stringify(value) === text) return value;
    const ref = await this.put(roleId, source, value, signal);
    const overhead = tokens(JSON.stringify({ ...ref, preview: '', truncated: true, read: 'payload_read' })) + 32;
    if (overhead >= budget) throw new Error('负载预览预算不足以容纳读取引用');
    let preview = fitText(text, budget - overhead);
    while (tokens(JSON.stringify({ ...ref, preview, truncated: true, read: 'payload_read' })) > budget) preview = fitText(preview, Math.max(0, tokens(preview) - Math.max(16, Math.ceil(tokens(preview) / 10))));
    return { ...ref, preview, truncated: true, read: 'payload_read' };
  }
  async read(roleId: string, input: z.input<typeof payloadReadSchema>, signal?: AbortSignal): Promise<Json> {
    const query = payloadReadSchema.parse(input); signal?.throwIfAborted();
    const row = this.store.db.prepare('SELECT bytes,mime FROM payloads WHERE id=? AND role_id=? LIMIT 1').get(query.id, roleId);
    if (!row) throw new Error('负载不存在或属于其他角色');
    if (query.offset > Number(row.bytes)) throw new Error('负载读取位置超过正文');
    const file = await open(this.path(query.id), 'r');
    try {
      if ((await file.stat()).size !== Number(row.bytes)) throw new Error('负载文件长度与登记记录不一致');
      const buffer = Buffer.alloc(query.limit); const { bytesRead } = await file.read(buffer, 0, buffer.length, query.offset); signal?.throwIfAborted();
      let end = bytesRead; while (end > Math.max(0, bytesRead - 3) && !isUtf8(buffer.subarray(0, end))) end--;
      if ((bytesRead > 0 && end === 0) || !isUtf8(buffer.subarray(0, end))) throw new Error('读取位置必须位于 UTF-8 字符边界');
      const next = query.offset + end;
      return { id: query.id, offset: query.offset, text: buffer.subarray(0, end).toString('utf8'), bytes: Number(row.bytes), nextCursor: next < Number(row.bytes) ? next : null };
    } finally { await file.close(); }
  }
}
