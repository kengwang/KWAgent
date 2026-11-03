import { createHash } from 'node:crypto';
import { asJson, tokens, freezeJson, perceptionFrameSchema, type PerceptionFrame, type Experience, type Json, type Payloads, type Store } from '@kwagent/core';
import { normalizeExperience, conversationOrder, NORMALIZER_VERSION } from '@kwagent/kw-lagrange';

export async function preparePerception(store: Store, payloads: Payloads, roleId: string, events: Experience[], messageId: string, budget: number, signal?: AbortSignal): Promise<PerceptionFrame> {
  if (events.some(event => event.roleId !== roleId)) throw new Error('感知经历属于其他角色');
  const saved = store.frame(messageId);
  if (saved !== undefined) { const frame = perceptionFrameSchema.parse(saved); if (frame.roleId !== roleId) throw new Error('感知批次属于其他角色'); return freezeJson(frame); }
  const scenes = events.filter(event => event.scene && event.peerId !== null).map(event => `${event.scene}:${event.peerId}`);
  const recent = store.db.prepare("SELECT id FROM events WHERE role_id=? AND id NOT IN (SELECT value FROM json_each(?)) AND (?=0 OR scene||':'||peer_id IN (SELECT value FROM json_each(?))) ORDER BY occurred_at DESC,seq DESC LIMIT 20").all(roleId, JSON.stringify(events.map(event => event.id)), scenes.length, JSON.stringify(scenes)).map(row => store.event(String(row.id)));
  const id = `frame-${createHash('sha256').update(messageId).digest('hex')}`;
  const normalize = (items: Experience[]) => conversationOrder(items).map(event => normalizeExperience(store, event));
  const full = asJson({ current: normalize(events), recent: normalize(recent) });
  const contentRef = await payloads.put(roleId, id, full, signal);
  const content: Json[] = [];
  const header = { id, roleId, messageId, normalizerVersion: NORMALIZER_VERSION, eventIds: events.map(event => event.id), contentRef, budget: { limit: budget, estimatedTokens: 0 }, omitted: 0, instruction: '自主决定行动、观察或休息。附件信息代表已知元数据，未理解的内容需要主动读取。' };
  for (const [phase, items] of Object.entries(full as { current: Json[]; recent: Json[] })) {
    for (let index = 0; index < items.length; index++) {
      const value = await payloads.view(roleId, `${id}:${phase}:${index}`, items[index]!, Math.max(256, Math.floor(budget / Math.max(events.length, 8))), signal);
      const next = asJson({ phase, value });
      if (tokens(JSON.stringify({ ...header, content: [...content, next] })) + 64 <= budget) content.push(next); else header.omitted++;
    }
  }
  const frame = { ...header, content };
  frame.budget.estimatedTokens = tokens(JSON.stringify(frame)) + 8;
  if (frame.budget.estimatedTokens > budget) throw new Error('感知来源与必需读取引用超过正文预算');
  return freezeJson(perceptionFrameSchema.parse(store.saveFrame(id, roleId, messageId, asJson(frame))));
}
