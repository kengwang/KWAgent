import { asJson, readable, type Experience, type Json, type Store } from '@kwagent/core';

export const NORMALIZER_VERSION = 2;
function record(value: Json | undefined): Record<string, Json> { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }

/** 只整理协议字段；话题、情绪和附件内容由角色判断。 */
export function normalizeExperience(store: Store, event: Experience): Json {
  const payload = record(event.payload);
  const selfId = Number(store.meta(`milky:${event.accountId}:self`) ?? 0) || null;
  const sender = record(payload.sender ?? payload.group_member ?? payload.friend);
  const aliases = [sender.nickname, sender.card, sender.name, payload.sender_name].filter(value => typeof value === 'string' && value.length > 0);
  const segments = (values: Json[]): Json[] => values.map((segment): Json => {
    const item = record(segment), data = record(item.data);
    if (item.type === 'text') return { type: 'text', text: data.text ?? '', state: 'available' };
    if (item.type === 'mention' || item.type === 'mention_all') return { type: item.type, identity: data.user_id ?? null, isSelf: selfId === null ? null : item.type === 'mention' && String(data.user_id) === String(selfId), includesSelf: selfId === null ? null : item.type === 'mention_all' || String(data.user_id) === String(selfId) };
    if (item.type === 'reply') {
      const seq = typeof data.message_seq === 'number' ? data.message_seq : null;
      const target = seq === null ? undefined : store.db.prepare('SELECT id,sender_id FROM events WHERE account_id=? AND scene=? AND peer_id=? AND message_seq=?').get(event.accountId, event.scene, event.peerId, seq);
      return { type: 'reply', messageSeq: seq, toSelf: target && selfId !== null ? Number(target.sender_id) === selfId : null, state: Array.isArray(data.segments) && data.segments.length ? '引用片段已附带' : target ? '未读取原文' : '原文尚未接收', sourceId: target ? String(target.id) : null, embedded: Array.isArray(data.segments) ? segments(data.segments) : [], read: target ? 'memory_read' : 'Lagrange 历史消息查询', conversation: { scene: event.scene, peerId: event.peerId } };
    }
    if (item.type === 'forward') return { type: 'forward', state: Array.isArray(data.messages) ? '转发节点已附带，发送者信息为节点声明' : '未读取转发内容', metadata: readable(asJson(data)), nodes: Array.isArray(data.messages) ? data.messages.map(value => { const node = record(value); return { declaredSender: node.sender_id ?? node.user_id ?? null, declaredName: node.sender_name ?? null, parts: Array.isArray(node.segments) ? segments(node.segments) : [] }; }) : [], read: 'Lagrange 转发查询或 memory_read 原始来源' };
    return { type: item.type ?? 'unknown', state: '未理解附件或消息片段', metadata: readable(asJson(data)), read: 'media_prepare / media_inspect；原始参数使用 memory_read' };
  });
  const parts = segments(Array.isArray(payload.segments) ? payload.segments : []);
  const media = store.db.prepare("SELECT id,json_extract(body,'$.name') AS name,json_extract(body,'$.mime') AS mime FROM documents WHERE kind='media' AND role_id=? AND json_extract(body,'$.eventId')=? ORDER BY id").all(event.roleId, event.id).map(row => {
    const analysis = store.db.prepare("SELECT id FROM events WHERE role_id=? AND source='media' AND type='media-analysis' AND json_extract(payload,'$.mediaId')=? ORDER BY seq DESC LIMIT 1").get(event.roleId, String(row.id));
    return { id: String(row.id), name: String(row.name), mime: String(row.mime), read: analysis ? 'memory_read' : 'media_inspect', analysisSourceId: analysis ? String(analysis.id) : null, state: analysis ? '已保存理解结果，正文尚未读取' : '未理解' };
  });
  return asJson({ sourceId: event.id, receiveSeq: event.seq, conversation: { accountId: event.accountId, scene: event.scene, peerId: event.peerId }, attention: { selfId, mentionedSelf: parts.some(part => record(part).type === 'mention' && record(part).isSelf === true), repliedToSelf: parts.some(part => record(part).type === 'reply' && record(part).toSelf === true), directPrivate: event.scene === 'private' && !event.self }, sender: { id: event.senderId, aliases, aliasSource: event.id }, occurredAt: event.occurredAt, messageSeq: event.messageSeq, source: event.source, eventType: event.type, self: event.self, parts, media, ...(parts.length ? {} : { knownContent: readable(event.payload) }), read: { tool: 'memory_read', source: 'event', id: event.id } });
}

export function conversationOrder(events: Experience[]): Experience[] {
  return [...events].sort((a, b) => `${a.accountId}:${a.scene}:${a.peerId}`.localeCompare(`${b.accountId}:${b.scene}:${b.peerId}`) || a.occurredAt.localeCompare(b.occurredAt) || (a.messageSeq ?? a.seq) - (b.messageSeq ?? b.seq) || a.seq - b.seq);
}
