import { createParser } from 'eventsource-parser';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { asJson, errorText, now } from '@kwagent/core';
import type { Experience, Json, Store } from '@kwagent/core';
import type { MilkyClient } from './client.ts';

const packetSchema = z.object({ event_type: z.string(), time: z.number(), self_id: z.number().int().safe(), data: z.record(z.string(), z.unknown()) });
const messageSchema = z.object({ message_scene: z.enum(['group', 'friend', 'temp']), peer_id: z.number().int().safe(), message_seq: z.number().int().safe(), sender_id: z.number().int().safe(), time: z.number(), segments: z.array(z.unknown()) }).passthrough();

/** 原始事件保存和序号核对共用一个 Module，连接恢复不跳过实时消息。 */
export class MilkyEvents {
  private abort?: AbortController;
  private task?: Promise<void>;
  private reconcileTask?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private readonly syncAbort = new AbortController();
  status = { state: 'disconnected', error: null as string | null, lastReceivedAt: null as string | null, reconciledAt: null as string | null };
  constructor(readonly client: MilkyClient, readonly store: Store, readonly deliver: (event: Experience) => void) {}

  accept(raw: unknown): void {
    if (typeof raw === 'object' && raw !== null && !Object.keys(raw).length) return;
    const packet = packetSchema.parse(raw);
    if (packet.self_id !== this.client.selfId) throw new Error('Milky 事件账号与 MCP 登录账号不一致');
    this.status.lastReceivedAt = now();
    if (packet.event_type === 'message_receive' || packet.event_type === 'message_sent') {
      this.acceptMessage(packet.data);
      return;
    }
    const peerId = typeof packet.data.group_id === 'number' ? packet.data.group_id : typeof packet.data.user_id === 'number' ? packet.data.user_id : null;
    const scene = typeof packet.data.group_id === 'number' ? 'group' : 'private';
    const roleId = peerId === null ? null : this.store.route(this.client.accountId, scene, peerId);
    const selfReaction = packet.event_type === 'group_message_reaction' && packet.data.user_id === this.client.selfId;
    const result = this.store.appendEvent({ accountId: this.client.accountId, roleId, source: 'milky', type: packet.event_type,
      occurredAt: new Date(packet.time * 1000).toISOString(), scene, peerId, senderId: null, messageSeq: null, self: selfReaction, payload: asJson(packet.data) });
    if (result.inserted) this.deliver(result.event);
  }
  acceptMessage(raw: unknown): void {
    const message = messageSchema.parse(raw);
    const scene = message.message_scene === 'group' ? 'group' : 'private';
    const result = this.store.appendEvent({ accountId: this.client.accountId, roleId: this.store.route(this.client.accountId, scene, message.peer_id),
      source: 'milky', type: 'message_receive', occurredAt: new Date(message.time * 1000).toISOString(), scene,
      peerId: message.peer_id, senderId: message.sender_id, messageSeq: message.message_seq,
      self: message.sender_id === this.client.selfId, payload: asJson(message) });
    if (result.inserted) this.deliver(result.event);
  }
  start(): void {
    if (this.task) return;
    this.abort = new AbortController();
    this.task = this.loop(this.abort.signal);
    this.timer = setInterval(() => { void this.reconcile().catch(error => this.fail(error)); }, this.client.config.reconcileSeconds * 1000);
    this.timer.unref();
  }
  private fail(error: unknown): void { if (this.syncAbort.signal.aborted) return; this.status.error = errorText(error); this.store.changes.emit('change', this.store.revision()); }
  private async loop(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        const headers: Record<string, string> = { Accept: 'text/event-stream' };
        if (this.client.config.token) headers.Authorization = `Bearer ${this.client.config.token}`;
        const response = await fetch(new URL('event', this.client.config.baseUrl), { headers, signal });
        if (!response.ok || !response.body) throw new Error(`Milky 事件连接失败：HTTP ${response.status}`);
        if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Milky 事件响应不是 SSE');
        this.status.state = 'connected'; this.status.error = null; failures = 0;
        const reconcile = this.reconcile().catch(error => this.fail(error));
        const parser = createParser({ onEvent: event => { if (event.event === 'milky_event' || !event.event) this.accept(JSON.parse(event.data)); } });
        const decoder = new TextDecoder();
        const reader = response.body.getReader();
        try {
          for (;;) { const chunk = await reader.read(); if (chunk.done) break; parser.feed(decoder.decode(chunk.value, { stream: true })); }
        } finally { await reader.cancel(); reader.releaseLock(); }
        await reconcile;
        if (!signal.aborted) throw new Error('Milky 事件流结束');
      } catch (error) {
        if (signal.aborted) break;
        this.status.state = 'reconnecting'; this.status.error = errorText(error);
        this.store.appendEvent({ accountId: this.client.accountId, roleId: null, source: 'system', type: 'connection-gap', occurredAt: now(), scene: null, peerId: null, senderId: null, messageSeq: null, self: true, payload: { reason: errorText(error), nonMessageEventsRecoverable: false } });
        try { await delay(Math.min(30000, 500 * 2 ** Math.min(failures++, 6)), undefined, { signal }); } catch (error) { if (!signal.aborted) throw error; }
      }
    }
  }
  reconcile(): Promise<void> {
    if (this.reconcileTask) return this.reconcileTask;
    this.reconcileTask = this.sync().finally(() => { this.reconcileTask = undefined; });
    return this.reconcileTask;
  }
  private async sync(): Promise<void> {
    const signal = this.syncAbort.signal;
    signal.throwIfAborted();
    await this.client.restore(signal);
    const failures: unknown[] = [];
    const roleGroups = this.store.roles().filter(role => role.accountId === this.client.accountId);
    const groups = new Set(roleGroups.flatMap(role => role.groups));
    if (roleGroups.some(role => role.globalGroups)) {
      const result = z.object({ groups: z.array(z.object({ group_id: z.number().int().safe() }).passthrough()) }).parse(await this.client.call('get_group_list', {}, signal));
      for (const group of result.groups) groups.add(group.group_id);
    }
    const all = [...groups];
    for (let offset = 0; offset < all.length; offset += 100) {
      const state = z.object({ groups: z.array(z.object({ group_id: z.number().int().safe(), latest_seq: z.number().int().safe() }).passthrough()) }).parse(await this.client.call('probe_history_sync_state', { group_ids: all.slice(offset, offset + 100), private_targets: [] }, signal));
      for (const group of state.groups) {
        try {
        const cursor = this.store.cursor(this.client.accountId, 'group', group.group_id);
        if (!cursor?.initialized) { this.store.confirm(this.client.accountId, 'group', group.group_id, group.latest_seq); continue; }
        let next = cursor.confirmed + 1;
        while (next <= group.latest_seq) {
          const page = z.object({ messages: z.array(z.unknown()), next_seq: z.number().int().nullable(), is_complete: z.boolean() }).parse(await this.client.call('get_history_sync_page', { message_scene: 'group', peer_id: group.group_id, next_seq: next, latest_seq: group.latest_seq, limit: 20 }, signal));
          this.store.transaction(() => { for (const message of page.messages) this.acceptMessage(message); this.store.confirm(this.client.accountId, 'group', group.group_id, page.is_complete ? group.latest_seq : (page.next_seq ?? next) - 1); });
          if (page.is_complete) break;
          if (page.next_seq === null || page.next_seq <= next) throw new Error('历史分页没有向前推进');
          next = page.next_seq;
        }
        } catch (error) { signal.throwIfAborted(); failures.push(new Error(`群聊 ${group.group_id} 历史核对失败：${errorText(error)}`, { cause: error })); }
      }
    }
    const contacts = new Set(roleGroups.flatMap(role => role.contacts));
    let defaultBaseline: string | undefined;
    if (roleGroups.some(role => role.defaultPrivate)) {
      const key = `private-default-baseline:${this.client.accountId}`;
      defaultBaseline = this.store.meta(key);
      if (!defaultBaseline) this.store.setMeta(key, String(Math.floor(Date.now() / 1000)));
      const friends = z.object({ friends: z.array(z.object({ user_id: z.number().int().positive().safe() }).passthrough()) }).parse(await this.client.call('get_friend_list', {}, signal));
      for (const friend of friends.friends) contacts.add(friend.user_id);
    }
    for (const peer of this.store.peers(this.client.accountId, 'private')) contacts.add(peer);
    for (const userId of contacts) {
      try {
      const key = `private-history:${this.client.accountId}:${userId}`;
      const upper = Math.floor(Date.now() / 1000);
      const previous = this.store.meta(key) ?? defaultBaseline;
      if (!previous) { this.store.setMeta(key, String(upper)); continue; }
      const lower = Number(previous) - 1;
      let cursor = { time: upper, random: 0 };
      for (;;) {
        const page = z.object({ messages: z.array(messageSchema), next_cursor: z.object({ time: z.number().int(), random: z.number().int() }).nullable(), is_complete: z.boolean() }).parse(await this.client.call('get_private_history_roam_page', { user_id: userId, ...cursor, limit: 20 }, signal));
        for (const message of page.messages) if (message.time >= lower) this.acceptMessage(message);
        if (page.is_complete || !page.next_cursor || page.messages.some(message => message.time < lower)) break;
        if (page.next_cursor.time > cursor.time || (page.next_cursor.time === cursor.time && page.next_cursor.random >= cursor.random)) throw new Error('私人历史游标没有向前推进');
        cursor = page.next_cursor;
      }
      this.store.setMeta(key, String(upper));
      } catch (error) { signal.throwIfAborted(); failures.push(new Error(`联系人 ${userId} 历史核对失败：${errorText(error)}`, { cause: error })); }
    }
    if (failures.length) throw new AggregateError(failures, failures.map(errorText).join('\n'));
    this.status.error = null;
    this.status.reconciledAt = now();
  }
  async close(): Promise<void> { if (this.timer) clearInterval(this.timer); this.abort?.abort(); this.syncAbort.abort(); await this.task; await this.reconcileTask?.catch(error => { if (!this.syncAbort.signal.aborted) throw error; }); this.task = undefined; this.status.state = 'disconnected'; }
}
