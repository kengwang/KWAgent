import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdir, cp, readFile, writeFile, readdir, stat, unlink, chmod, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { check } from 'proper-lockfile';
import { z } from 'zod';
import { asJson, errorText, memoryInputSchema, now, recallSchema, roleInputSchema, roleSchema, redact, SCHEMA_VERSION, summary, continuityRequestSchema } from '@kwagent/core';
import type { Json } from '@kwagent/core';
import type { Life } from './index.ts';
import { planRequestSchema } from './plans.ts';
import { extensionRequestSchema } from './extensions.ts';
import { query, readActions } from './queries.ts';
import { APP_VERSION } from '@kwagent/core';

export function adminSocket(dataRoot: string): string {
  return process.platform === 'win32' ? String.raw`\\.\pipe\kwagent-${createHash('sha256').update(resolve(dataRoot)).digest('hex').slice(0, 16)}` : join(dataRoot, 'run', 'admin.sock');
}
export interface SnapshotFrame { revision: number; payload: string }

/** Panel 和服务器命令共用的管理入口。 */
export class Operations {
  private server?: Server;
  private timer?: ReturnType<typeof setInterval>;
  private backingUp = false;
  private readonly mutations = new Set<Promise<Json>>();
  private barrier: Promise<unknown> = Promise.resolve();
  constructor(readonly life: Life) {}

  async invoke(action: string, value: Json = null): Promise<Json> {
    if (['quiesce', 'resume', 'shutdown', 'backup', 'reindex'].includes(action)) {
      const task = this.barrier.then(() => this.execute(action, value));
      this.barrier = task.catch(() => undefined);
      return task;
    }
    const task = this.execute(action, value);
    if (readActions.has(action)) return task;
    this.mutations.add(task);
    try { return await task; } finally { this.mutations.delete(task); }
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.mutations]); }
  private async execute(action: string, value: Json): Promise<Json> {
    const life = this.life;
    if (life.maintenance && !readActions.has(action) && !['resume', 'backup', 'quiesce', 'shutdown'].includes(action)) throw new Error('应用正在维护，管理修改暂时停止');
    const result = await query(life, action, value); if (result !== undefined) return result;
    switch (action) {
      case 'status': return life.snapshot(typeof value === 'object' && value !== null && 'roleId' in value && typeof value.roleId === 'string' ? value.roleId : undefined);
      case 'doctor': return asJson({ node: process.versions.node, bunRuntime: Boolean(process.versions.bun), database: life.store.integrity(), schema: life.store.db.prepare('PRAGMA user_version').get(), started: life.started, error: life.startupError, mcp: life.context.kwLagrange.client.status, events: life.context.kwLagrange.events.status, visionConfigured: Boolean(life.config.vision.model && life.config.vision.baseUrl) });
      case 'role.create': return asJson(life.create(roleInputSchema.parse(value)));
      case 'role.prepare': { const input = z.object({ id: z.string() }).parse(value); const handle = await life.ensure(input.id); return { prepared: true, sessionId: handle.agent.session.id }; }
      case 'role.compact': { const input = z.object({ id: z.string() }).parse(value); const handle = await life.ensure(input.id); const engine = life.context.agentPresets.serviceFor(handle.agent, 'compaction'); if (!engine) throw new Error('角色缺少压缩能力'); return asJson(await engine.compactNow(handle.agent, AbortSignal.timeout(180000))); }
      case 'role.update': {
        const input = z.object({ id: z.string(), expectedRevision: z.number().int(), patch: roleSchema.partial() }).parse(value);
        return asJson(await life.update(input.id, input.patch, input.expectedRevision));
      }
      case 'role.control': {
        const input = z.object({ id: z.string(), state: roleSchema.shape.state }).parse(value);
        return asJson(await life.control(input.id, input.state));
      }
      case 'event': { const input = z.object({ roleId: z.string(), text: z.string().min(1) }).parse(value); return asJson(life.manual(input.roleId, input.text)); }
      case 'continuity.revise': { const input = continuityRequestSchema.extend({ roleId: z.string() }).strict().parse(value); const { roleId, ...request } = input; const record = life.context.kwMind.continuity.revise(roleId, request, 'owner'); await life.syncContinuity(roleId); return asJson(record); }
      case 'events.transfer': { const input = z.object({ ids: z.array(z.string()).min(1).max(500), targetRoleId: z.string() }).parse(value); life.store.migrateEvents(input.ids, input.targetRoleId); return { transferred: input.ids.length }; }
      case 'self.revise': { const input = z.object({ roleId: z.string(), expectedRevision: z.number().int().positive(), patch: z.object({ persona: z.string().min(1).optional(), selfState: z.string().optional(), expressionExamples: z.array(z.string().min(1)).optional() }).strict(), reason: z.string().min(1), sources: z.array(z.string()).min(1) }).strict().parse(value); return asJson(life.context.kwMind.selfRevise(input.roleId, input, 'owner')); }
      case 'memory.recall': return asJson((await life.context.kwMind.recall(recallSchema.parse(value))).map(memory => summary(memory, life.config.budgets.panelBodyBytes)));
      case 'memory.consolidate': {
        const input = z.object({ roleId: z.string() }).parse(value);
        const handle = await life.ensure(input.roleId);
        await life.context.kwMind.consolidate(handle.agent, input.roleId, AbortSignal.timeout(120000));
        return { consolidated: true, memories: life.store.memories(input.roleId).length };
      }
      case 'memory.revise': {
        const input = z.object({ memory: memoryInputSchema, expectedRevision: z.number().int().positive().nullable(), reason: z.string().min(1) }).parse(value);
        return asJson(await life.context.kwMind.revise(input.memory, input.expectedRevision, 'owner', input.reason));
      }
      case 'plan': { const input = z.object({ roleId: z.string(), request: planRequestSchema }).parse(value); return asJson(await life.plans.mutate(input.roleId, input.request)); }
      case 'extension': { const input = z.object({ roleId: z.string(), request: extensionRequestSchema }).parse(value); const handle = input.request.action === 'enable' ? await life.ensure(input.roleId) : life.handles.get(input.roleId); return asJson(await life.extensions.manage(input.roleId, input.request, handle?.agent.ctx)); }
      case 'quiesce': await life.quiesce(); return { maintenance: true };
      case 'resume': await life.resume(); return { maintenance: false };
      case 'shutdown': await life.quiesce(); setTimeout(() => life.context.appExit?.(0), 100); return { shutdown: true };
      case 'backup': return asJson(await this.backup());
      case 'reindex': await life.quiesce(); try { return asJson(await life.context.kwMind.reindex()); } finally { await life.resume(); }
      case 'deployment.record': {
        const input = z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/), image: z.string().min(1), imageId: z.string().min(1), deployedAt: z.string().datetime() }).parse(value);
        life.store.setMeta('deployment', JSON.stringify(input)); return asJson(input);
      }
      default: throw new Error(`未知管理操作：${action}`);
    }
  }

  async *follow(roleId: string | undefined, signal: AbortSignal): AsyncIterable<SnapshotFrame> {
    let dirty = true;
    let wake: (() => void) | undefined;
    const changed = () => { dirty = true; wake?.(); };
    const abort = () => wake?.();
    this.life.store.changes.on('change', changed);
    signal.addEventListener('abort', abort, { once: true });
    try {
      while (!signal.aborted) {
        if (dirty) { dirty = false; yield { revision: this.life.store.revision(), payload: JSON.stringify(this.life.snapshot(roleId)) }; }
        await new Promise<void>(resolve => { wake = resolve; if (dirty || signal.aborted) resolve(); });
      }
    } finally { this.life.store.changes.off('change', changed); signal.removeEventListener('abort', abort); }
  }

  async start(): Promise<void> {
    if (this.server) return;
    const root = this.life.config.dataRoot;
    for (const name of ['run', 'backups', 'tmp', 'workspaces', 'extensions', 'cache', 'media', 'artifacts']) await mkdir(join(root, name), { recursive: true, mode: 0o700 });
    const socket = adminSocket(root);
    if (process.platform !== 'win32') await unlink(socket).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    this.server = createServer((request, response) => {
      void (async () => {
        if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
        let bytes = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of request) { bytes += chunk.length; if (bytes > 1024 * 1024) throw new Error('管理请求超过容量'); chunks.push(Buffer.from(chunk)); }
        const input = chunks.length ? asJson(JSON.parse(Buffer.concat(chunks).toString('utf8'))) : null;
        const result = await this.invoke(decodeURIComponent((request.url ?? '/status').slice(1)), input);
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ok: true, result }));
      })().catch(error => {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: redact(errorText(error), this.life.config), ...error && typeof error === 'object' && 'current' in error ? { current: error.current } : {} }));
      });
    });
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(socket, resolve); });
    if (process.platform !== 'win32') await chmod(socket, 0o600);
    this.timer = setInterval(() => { if (!this.life.started && !this.life.maintenance) this.life.track(this.life.start()); this.life.track(this.checkBackup()); for (const role of this.life.store.roles()) if (role.state === 'active') this.life.enqueue(role.id); }, 60000);
    this.timer.unref();
  }
  private async checkBackup(): Promise<void> {
    const config = this.life.config;
    if (!config.backup.enabled || this.backingUp || this.life.maintenance) return;
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone }).format(new Date());
    const clock = new Intl.DateTimeFormat('en-GB', { timeZone: config.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
    if (clock >= config.backup.time && this.life.store.meta('last-backup-day') !== date) {
      await this.invoke('backup'); this.life.store.setMeta('last-backup-day', date);
    }
  }
  async backup(): Promise<{ directory: string; files: number }> {
    if (this.backingUp) throw new Error('备份已经在执行');
    this.backingUp = true;
    const wasMaintaining = this.life.maintenance;
    const root = this.life.config.dataRoot;
    const directory = join(root, 'backups', `backup-${Date.now()}-${randomUUID()}`);
    try {
      await this.life.quiesce();
      await mkdir(join(directory, 'kwagent'), { recursive: true, mode: 0o700 });
      await this.life.store.backup(join(directory, 'kwagent', 'state.sqlite'));
      for (const name of ['dsh', 'workspaces', 'extensions', 'media', 'artifacts']) {
        const source = name === 'dsh' ? process.env.DSH_HOME ?? join(root, name) : join(root, name);
        if (await exists(source)) await cp(source, join(directory, name), { recursive: true, dereference: false, filter: path => !path.endsWith('.lock') && !path.includes(`${sep}node_modules${sep}.cache`) });
      }
      const files = await checksums(directory);
      const manifest = { version: 1, createdAt: now(), appVersion: APP_VERSION, harnessVersion: '0.2.2-alpha.2', schema: SCHEMA_VERSION, commit: process.env.KW_COMMIT ?? null, image: process.env.KW_IMAGE ?? null, files };
      await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
      this.life.store.setMeta('last-backup', JSON.stringify({ directory, ...manifest, files: files.length }));
      const cutoff = Date.now() - this.life.config.backup.keepDays * 86400000;
      for (const entry of await readdir(join(root, 'backups'), { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^backup-\d+-[a-f0-9-]+$/.test(entry.name)) continue;
        const path = join(root, 'backups', entry.name);
        if ((await stat(path)).mtimeMs < cutoff && await exists(join(path, 'manifest.json'))) await rm(path, { recursive: true });
      }
      return { directory, files: files.length };
    } finally {
      this.backingUp = false;
      if (!wasMaintaining) await this.life.resume();
    }
  }
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.server) { this.server.closeAllConnections(); await new Promise<void>((resolve, reject) => this.server!.close(error => error ? reject(error) : resolve())); }
    await this.barrier;
    await this.drain();
  }
}

async function exists(path: string): Promise<boolean> { return stat(path).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }); }
async function checksums(root: string): Promise<{ path: string; sha256: string; bytes: number }[]> {
  const result: { path: string; sha256: string; bytes: number }[] = [];
  for (const item of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!item.isFile()) continue;
    const path = join(item.parentPath, item.name);
    if (item.name === 'manifest.json' && item.parentPath === root) continue;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    result.push({ path: relative(root, path), sha256: hash.digest('hex'), bytes: (await stat(path)).size });
  }
  return result;
}

/** 恢复只接受已完成备份，应用存活时拒绝执行。 */
export async function restoreBackup(source: string, destination: string): Promise<void> {
  const root = resolve(destination);
  if (await check(join(root, 'kwagent')).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; })) throw new Error('应用仍在运行，请先停止');
  const manifest = z.object({ version: z.literal(1), harnessVersion: z.literal('0.2.2-alpha.2'), files: z.array(z.object({ path: z.string(), sha256: z.string(), bytes: z.number() })) }).passthrough().parse(JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8')));
  for (const file of manifest.files) {
    const path = resolve(source, file.path);
    if (relative(resolve(source), path).startsWith('..')) throw new Error('备份包含越界路径');
    const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk);
    if (hash.digest('hex') !== file.sha256 || (await stat(path)).size !== file.bytes) throw new Error(`备份校验失败：${file.path}`);
  }
  await mkdir(root, { recursive: true });
  const entries = await readdir(root);
  if (entries.some(name => !['backups', 'run', 'cache', 'tmp'].includes(name))) throw new Error('恢复目标需要使用独立的空数据目录');
  for (const name of ['kwagent', 'dsh', 'workspaces', 'extensions', 'media', 'artifacts']) if (await exists(join(source, name))) await cp(join(source, name), join(root, name), { recursive: true, dereference: false });
}
