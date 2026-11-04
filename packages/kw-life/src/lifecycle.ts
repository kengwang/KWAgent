import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { asJson, ConflictError, errorText, operationSchema, roleSchema, type Operation, type Role } from '@kwagent/core';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Life } from './index.ts';

const requestSchema = z.object({ id: z.string(), kind: z.enum(['reset', 'delete']), from: z.string(), to: z.string().nullable(), state: roleSchema.shape.state, reason: z.string() }).strict();

/** 角色会话切换与删除拥有独立日志，重启继续同一项管理操作。 */
export class RoleLifecycle {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly phases = new Map<string, string>();
  constructor(readonly life: Life) {}
  whenIdle(): Promise<void> { return Promise.all([...this.tails.values()]).then(() => {}); }
  phase(id: string): string | undefined { return this.phases.get(id) ?? (this.life.store.meta(`lifecycle:${id}`) ? 'management-pending' : undefined); }
  assertAvailable(id: string): void { if (this.phase(id)) throw new Error('角色有未完成的会话管理操作，请完成或重试重置／删除'); }
  private async exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>(resolve => { release = resolve; }); this.tails.set(id, tail);
    await previous;
    try { return await action(); } finally { release(); if (this.tails.get(id) === tail) this.tails.delete(id); }
  }
  reset(id: string, expectedRevision: number): Promise<Role> { return this.request(id, expectedRevision, 'reset', '人工重置当前对话'); }
  remove(id: string, expectedRevision: number): Promise<Role> { return this.request(id, expectedRevision, 'delete', '人工删除角色'); }
  private request(id: string, expectedRevision: number, kind: 'reset' | 'delete', reason: string): Promise<Role> {
    return this.exclusive(id, async () => {
      const role = this.life.store.role(id);
      if (role.revision !== expectedRevision) throw new ConflictError(asJson(role));
      const pending = this.life.store.meta(`lifecycle:${id}`);
      if (pending) {
        const operation = this.life.store.get('operation', pending, operationSchema)!;
        if (requestSchema.parse(operation.arguments).kind !== kind) throw new Error('需要先重试并完成已有的会话管理操作');
        return this.execute(operation);
      }
      return this.begin(role, kind, reason);
    });
  }
  archived(id: string, sessionId: string): Promise<Role | undefined> {
    return this.exclusive(id, async () => {
      const role = this.life.store.get('role', id, roleSchema);
      if (!role || role.deletedAt || role.sessionId !== sessionId) return;
      const pending = this.life.store.meta(`lifecycle:${id}`);
      if (pending) return this.execute(this.life.store.get('operation', pending, operationSchema)!);
      return this.begin(role, 'reset', '原会话已归档，自动创建新对话');
    });
  }
  async recover(): Promise<void> {
    const rows = this.life.store.db.prepare("SELECT body FROM documents WHERE kind='operation' AND json_extract(body,'$.tool') IN ('role_lifecycle_reset','role_lifecycle_delete') AND json_extract(body,'$.state') IN ('started','unknown') ORDER BY updated_at,id").all();
    for (const row of rows) {
      const operation = operationSchema.parse(JSON.parse(String(row.body)));
      try { await this.exclusive(operation.roleId!, () => this.execute(operation)); }
      catch (error) { this.life.fail(error, operation.roleId!); }
    }
  }
  private begin(role: Role, kind: 'reset' | 'delete', reason: string): Promise<Role> {
    const args = requestSchema.parse({ id: role.id, kind, from: role.sessionId, to: kind === 'reset' ? `kw-${role.id}-${randomUUID()}` : null, state: role.state, reason });
    const operation = this.life.store.transaction(() => {
      const saved = this.life.store.startOperation(role.accountId, role.id, `role_lifecycle_${kind}`, asJson(args));
      this.life.store.setMeta(`lifecycle:${role.id}`, saved.id); return saved;
    });
    return this.execute(operation);
  }
  private async archive(sessionId: string): Promise<void> {
    const registry = this.life.context.workspaceRegistry;
    if (!registry.archivedSessionIds.includes(SessionId(sessionId)) && await this.life.context.sessionPersistence.stat(SessionId(sessionId))) await registry.archiveSession(SessionId(sessionId), { stopActivity: true });
    const agent = this.life.context.agents.get(SessionId(sessionId));
    if (agent) { agent.cancel({ kind: 'hook', reason: '角色会话管理' }, { keepInbox: true }); await agent.whenIdle(); }
  }
  private async execute(operation: Operation): Promise<Role> {
    const input = requestSchema.parse(operation.arguments);
    const { store } = this.life;
    if (operation.roleId !== input.id) throw new Error('会话管理日志的角色归属不一致');
    this.phases.set(input.id, input.kind === 'reset' ? 'resetting' : 'deleting');
    this.life.runtime.set(input.id, { state: this.phases.get(input.id)!, error: null, lastActivityAt: null });
    try {
      let role = store.role(input.id);
      if (role.sessionId !== input.from && role.sessionId !== input.to) throw new Error('角色会话已经变更，不能覆盖当前会话');
      if (role.state !== 'paused') role = store.updateRole(role.id, { state: 'paused' }, role.revision, 'owner', input.reason);
      await this.life.retireRole(role.id);
      await this.life.extensions.drain(role.id);
      await this.life.plans.detachSession(role.id, input.from);
      if (input.kind === 'reset') {
        if (role.sessionId === input.from) {
          const existing = await this.life.context.sessionPersistence.stat(SessionId(input.from));
          const accepted = existing ? (await this.life.context.sessionQuery.readSession(SessionId(input.from))).events.flatMap(event => event.type === 'user/message' ? [String(event.data.id)] : []) : [];
          role = store.rotateRoleSession(role.id, input.to!, store.role(role.id).revision, accepted, input.reason);
        }
        await this.archive(input.from);
        const handle = input.state === 'active' ? await this.life.ensure(role.id, false) : undefined;
        if (!handle) await this.life.prepareEmptySession(role);
        role = store.updateRole(role.id, { state: input.state }, store.role(role.id).revision, 'owner', '会话重置完成，保留角色启停状态');
        await this.life.plans.reconcileRole(role.id);
        if (handle && role.state === 'active' && !this.life.maintenance) await this.life.extensions.restore(role.id, handle.agent.ctx);
      } else {
        await this.life.plans.cancelRole(role.id);
        await this.life.extensions.disableRole(role.id);
        const sessions = store.db.prepare("SELECT key FROM meta WHERE key LIKE 'session-owner:%' AND value=?").all(role.id).map(row => String(row.key).slice('session-owner:'.length));
        for (const sessionId of new Set([input.from, ...sessions])) { await this.life.plans.detachSession(role.id, sessionId); await this.archive(sessionId); }
      }
      const result = store.transaction(() => {
        if (input.kind === 'delete') role = store.deleteRole(role.id, store.role(role.id).revision);
        store.finishOperation(operation.id, 'succeeded', { previousSessionId: input.from, sessionId: role.sessionId, deletedAt: role.deletedAt });
        store.setMeta(`lifecycle:${role.id}`, ''); return role;
      });
      if (result.deletedAt) this.life.runtime.delete(result.id);
      else this.life.runtime.set(result.id, { state: result.state === 'active' ? 'waiting' : result.state, error: null, lastActivityAt: null });
      return result;
    } catch (error) { store.finishOperation(operation.id, 'unknown', { message: errorText(error) }); throw error; }
    finally {
      this.phases.delete(input.id);
      const role = store.get('role', input.id, roleSchema);
      if (role && !role.deletedAt && role.state === 'active' && !store.meta(`lifecycle:${role.id}`)) this.life.enqueue(role.id);
    }
  }
}
