import { useEffect, useRef, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { Memory, Experience } from '@kwagent/core';
import { appendPage, type Page } from './paging.ts';

export type Call = (action: string, payload?: unknown) => Promise<unknown>;
export type Open = (action: string, payload: Record<string, unknown>) => void;
export function usePages<T>(action: string, parameters: Record<string, unknown>, key: (item: T) => string, revision: number, call: Call, enabled = true, cursor = 'cursor') {
  const [page, setPage] = useState<Page<T>>({ items: [], nextCursor: null });
  const [frozen, setFrozen] = useState(false); const [generation, setGeneration] = useState(0); const [loadedRevision, setLoadedRevision] = useState(0);
  const selection = JSON.stringify({ action, parameters }); const owner = useRef(selection); owner.current = selection; const epoch = useRef(0);
  useEffect(() => { epoch.current++; setPage({ items: [], nextCursor: null }); setFrozen(false); }, [selection]);
  useEffect(() => { let active = true; if (enabled && !frozen) void call(action, parameters).then(value => { if (active) { setPage(value as Page<T>); setLoadedRevision(revision); } }).catch(() => {}); return () => { active = false; }; }, [selection, revision, enabled, frozen, generation]);
  const more = () => { if (page.nextCursor === null) return; const selected = owner.current, version = epoch.current; setFrozen(true); void call(action, { ...parameters, [cursor]: page.nextCursor }).then(value => { if (selected === owner.current && version === epoch.current) setPage(previous => appendPage(previous, value as Page<T>, key)); }).catch(() => {}); };
  const refresh = () => { epoch.current++; setPage({ items: [], nextCursor: null }); setFrozen(false); setGeneration(value => value + 1); };
  return { ...page, more, frozen, refresh, loadedRevision };
}
export function PageNotice({ page }: { page: { frozen: boolean; refresh(): void } }) {
  return page.frozen ? <div className="kw-search"><p className="kw-muted">正在查阅历史，刷新列表可读取新变化。</p><Button size="sm" onClick={page.refresh}>刷新列表</Button></div> : null;
}
export function useRecords<T extends { id: string; roleId?: string | null }>(kind: 'plan' | 'extension' | 'operation', roleId: string, revision: number, enabled: boolean, call: Call) {
  return usePages<T>('records.list', { kind, ...(roleId ? { roleId } : {}) }, item => kind === 'extension' ? `${item.roleId}:${item.id}` : item.id, revision, call, enabled);
}
export function EventHistory({ roleId, revision, call, open, unassigned }: { roleId: string; revision: number; call: Call; open: Open; unassigned(event: Experience): void }) {
  const page = usePages<Experience & { delivery?: { state: string } }>('events', roleId ? { roleId } : {}, item => item.id, revision, call, true, 'before');
  const states: Record<string, string> = { pending: '等待处理', prepared: '已固定感知批次', queued: '输入已排队', accepted: 'Session 已接纳', completed: '已处理', observed: '保留观察记录' };
  return <section aria-label="原始经历" data-loaded-revision={page.loadedRevision}><h3>原始经历</h3><PageNotice page={page} />{!page.items.length && <p className="kw-empty">收到的消息、工具观察与自主活动会出现在这里。</p>}{page.items.map(event => <article className="kw-entry" key={event.id} data-event-id={event.id}>
    <div className="kw-entry-head"><strong>{event.type}</strong><time>{new Date(event.occurredAt).toLocaleString()}</time></div>
    <p className="kw-muted">{event.scene ? `${event.scene} · ${event.peerId}` : '内部活动'} · {event.senderId ?? '系统'} · {states[event.delivery?.state ?? ''] ?? '输入状态未记录'}</p>
    <p className="kw-muted">{event.activityId ? '已关联活动' : '活动关联未记录或尚未接纳'}</p><p>{JSON.stringify(event.payload).slice(0, 280)}</p>
    <Button size="sm" onClick={() => event.roleId ? open('source.read', { roleId: event.roleId, id: event.id }) : unassigned(event)}>{event.roleId ? '阅读经历' : '分配经历'}</Button>
  </article>)}{page.nextCursor !== null && <Button onClick={page.more}>读取更早经历</Button>}</section>;
}
interface Activity { id: string; roleId: string; turn: number; state: string; startedAt: string; endedAt: string | null; accepted: number; steps: number; sends: { succeeded: number; failed: number; unknown: number } }
const labels: Record<string, string> = { running: '正在活动', completed: '已完成', aborted: '已中断', interrupted: '进程中断', error: '活动失败', blocked: '活动受阻', 'max-tokens': '输出达到上限', source: '原始经历', input: '已接纳输入', perception: '感知批次', context: '步骤上下文', step: '模型步骤', 'step-end': '步骤结束', tool: '工具调用', receipt: '发送或操作回执', memory: '记忆修订', role: '人格修订', plan: '后续安排', operation: '操作记录', session: 'Session 记录' };

export function Timeline({ roleId, revision, call, open }: { roleId: string; revision: number; call: Call; open: Open }) {
  const page = usePages<Activity>('activity.list', roleId ? { roleId } : {}, item => item.id, revision, call);
  return <section aria-label="活动时间线"><h3>活动时间线</h3><PageNotice page={page} />{!page.items.length && <p className="kw-empty">新的自主活动会记录输入、模型步骤、工具和后续安排。旧活动关联显示未记录。</p>}{page.items.map(item => <article className="kw-entry" key={item.id}><div className="kw-entry-head"><strong>第 {item.turn} 轮 · {labels[item.state] ?? item.state}</strong><time>{new Date(item.startedAt).toLocaleString()}</time></div><p>{item.endedAt ? `${Math.max(0, Math.round((Date.parse(item.endedAt) - Date.parse(item.startedAt)) / 1000))} 秒` : '进行中'} · 已接纳 {item.accepted} 项输入 · {item.steps} 个模型步骤</p><p>{item.sends.succeeded + item.sends.failed + item.sends.unknown === 0 ? '本轮未发送消息' : `发送成功 ${item.sends.succeeded} · 发送失败 ${item.sends.failed} · 结果未知 ${item.sends.unknown}`}</p><Button size="sm" onClick={() => open('activity.read', { roleId: item.roleId, id: item.id })}>阅读活动关联</Button></article>)}{page.nextCursor !== null && <Button onClick={page.more}>读取更早活动</Button>}</section>;
}

interface Person { identity: string; aliases: string[]; profiles: { sourceId: string; aliases: string[] }[]; memories: Memory[] }
export function People({ roleId, revision, call, open }: { roleId: string; revision: number; call: Call; open: Open }) {
  const [query, setQuery] = useState(''); const [search, setSearch] = useState('');
  const page = usePages<Person>('people.list', { roleId, query: search }, item => item.identity, revision, call, Boolean(roleId));
  return <>
    <form className="kw-search" onSubmit={event => { event.preventDefault(); setSearch(query); }}><label>查找人物<input value={query} onChange={event => setQuery(event.target.value)} placeholder="账号或有来源的别名" /></label><Button type="submit" disabled={!roleId}>查找</Button></form>
    <PageNotice page={page} />
    {!page.items.length && <p className="kw-empty">选择角色后，查看真实账号、人物认识及共同经历。</p>}
    {page.items.map(person => <article className="kw-entry" key={person.identity}>
      <h3>{person.aliases.join('、') || person.identity}</h3><p className="kw-muted">账号 {person.identity} · 昵称和群名片随来源变化</p>
      {person.memories.map(memory => <div key={memory.id}><strong>{memory.title} · {memory.kind === 'relationship' ? '关系' : '认识'}</strong><p className="kw-prose">{memory.content}</p><Button size="sm" onClick={() => open('memory.detail', { roleId, id: memory.id })}>阅读认识与依据</Button></div>)}
      <div className="kw-actions"><Button size="sm" onClick={() => open('people.memories', { roleId, personId: person.identity })}>查阅全部认识与关系</Button><Button size="sm" onClick={() => open('continuity.list', { roleId, person: person.identity })}>相处方式与话头</Button><Button size="sm" onClick={() => open('sources.list', { roleId, personId: person.identity })}>查阅共同经历</Button>{person.profiles.slice(0, 3).map(profile => <Button key={profile.sourceId} size="sm" onClick={() => open('source.read', { roleId, id: profile.sourceId })}>别名来源：{profile.aliases.join('、') || '账号身份'}</Button>)}</div>
    </article>)}
    {page.nextCursor !== null && <Button onClick={page.more}>读取更多人物</Button>}
  </>;
}

interface Capability { name: string; description?: string; adapterSupport: string; policy?: string; latest: { state: string; at: string; evidence: unknown } | null }
export function CapabilityList({ revision, call, open }: { revision: number; call: Call; open: Open }) {
  const page = usePages<Capability>('capability.read', {}, item => item.name, revision, call); const [query, setQuery] = useState('');
  return <section><h3>工具与 Skill</h3><p>Skill：lagrange · 依赖：Lagrange MCP、Milky 事件连接</p><p>Markdown 发送不支持。调用证据记录各次结果与时间。</p><PageNotice page={page} /><label>筛选当前目录<input value={query} onChange={event => setQuery(event.target.value)} /></label>{page.items.filter(item => `${item.name} ${item.description ?? ''}`.toLowerCase().includes(query.toLowerCase())).map(item => <article key={item.name} className="kw-entry"><h3>{item.name}</h3><p>{item.adapterSupport === 'unsupported' ? '接入不支持' : item.adapterSupport}</p><p>{item.policy || item.description}</p><p className="kw-muted">{item.latest ? `最近结果：${item.latest.state} · ${new Date(item.latest.at).toLocaleString()}` : '尚无调用证据'}</p><Button size="sm" onClick={() => open('capability.read', { name: item.name, detail: true })}>读取 Schema 与证据</Button></article>)}{page.nextCursor !== null && <Button onClick={page.more}>读取更多能力</Button>}</section>;
}

interface DetailQuery { action: string; payload: Record<string, unknown> }
export interface Detail { value: unknown; query?: DetailQuery }
export function DetailReader({ detail, roleId, call, onOpen }: { detail: Detail; roleId: string; call: Call; onOpen: Open }) {
  const value = detail.value as Record<string, any> | null;
  roleId = typeof detail.query?.payload.roleId === 'string' ? detail.query.payload.roleId : typeof value?.roleId === 'string' ? value.roleId : roleId;
  const [chunks, setChunks] = useState(''); const [cursor, setCursor] = useState<number | null>(0);
  useEffect(() => { setChunks(''); setCursor(0); }, [detail]);
  const linked = (item: Record<string, any>) => {
    const id = item.id; const info = item.detail ?? {};
    if (item.payloadId) onOpen('payload.read', { roleId, id: item.payloadId });
    else if (item.kind === 'continuity' || item.data?.kind || item.read === 'continuity.read') onOpen('continuity.read', { roleId, id });
    else if (item.entity && item.revision) onOpen('revision.read', { roleId, entity: item.entity, id, revision: item.revision });
    else if (item.kind === 'source' || item.kind === 'receipt') onOpen('source.read', { roleId, id });
    else if (item.kind === 'operation') onOpen('source.read', { roleId, id: info.id });
    else if (item.kind === 'tool' && info.result?.sourceId) onOpen('source.read', { roleId, id: info.result.sourceId });
    else if (item.kind === 'perception') onOpen('perception.read', { roleId, messageId: id });
    else if (item.kind === 'memory') onOpen('memory.detail', { roleId, id: info.id });
    else if (item.roleId && item.content && item.id) onOpen('memory.detail', { roleId: item.roleId, id: item.id });
    else if (item.kind === 'role') onOpen('history', { entity: 'role', id: info.id });
    else if (item.kind === 'plan') onOpen('record.read', { roleId, kind: 'plan', id: info.id });
    else if (info.payloadId) onOpen('payload.read', { roleId, id: info.payloadId });
    else if (typeof info.seq === 'number') onOpen('session.read', { roleId, seq: info.seq });
    else if (!item.kind && typeof item.seq === 'number' && item.sessionId) onOpen('session.read', { roleId, seq: item.seq });
    else if (!item.kind && id) onOpen('source.read', { roleId, id });
  };
  const payloadId = value?.payloadId ?? value?.contentRef?.payloadId;
  const sources = Array.isArray(value?.sources) ? value.sources as string[] : Array.isArray(value?.personaSources) ? value.personaSources as string[] : [];
  const rows = Array.isArray(value?.items) ? value.items as Record<string, any>[] : [];
  const references = Array.isArray(value?.references) ? value.references as { payloadId: string; bytes: number; source: string }[] : [];
  return <>
    <pre>{JSON.stringify(value?.summary ?? value, null, 2)}</pre>
    {references.map(ref => <div className="kw-source-row" key={ref.payloadId}><span>{ref.bytes.toLocaleString()} 字节 · {ref.source}</span><Button size="sm" onClick={() => onOpen('payload.read', { roleId, id: ref.payloadId })}>读取引用负载 {ref.payloadId.slice(0, 12)}</Button></div>)}
    {value?.referencesNextCursor !== null && value?.referencesNextCursor !== undefined && payloadId && <Button onClick={() => onOpen('payload.links', { roleId, id: payloadId, cursor: value.referencesNextCursor })}>读取更多引用</Button>}
    {sources.map(id => <Button key={id} size="sm" onClick={() => onOpen('source.read', { roleId, id })}>读取来源 {id}</Button>)}
    {rows.map((item, index) => <div className="kw-source-row" key={`${item.kind}:${item.id ?? item.payloadId ?? item.identity ?? index}`}><span>{labels[item.kind] ?? item.type ?? item.title ?? item.name ?? '来源'} · {item.id ?? item.payloadId ?? item.revision ?? ''}{item.detail?.state ? ` · ${item.detail.state}` : ''}</span>{(item.id || item.payloadId || item.detail?.payloadId || typeof item.seq === 'number') && <Button size="sm" onClick={() => linked(item)}>阅读关联</Button>}</div>)}
    {detail.query && value?.nextCursor !== null && value?.nextCursor !== undefined && detail.query.action !== 'payload.read' && <Button onClick={() => onOpen(detail.query!.action, { ...detail.query!.payload, ...(['events', 'history'].includes(detail.query!.action) ? { before: value.nextCursor } : { cursor: value.nextCursor }) })}>读取下一页</Button>}
    {payloadId && cursor !== null && <Button onClick={() => { void call('payload.read', { roleId, id: payloadId, offset: cursor }).then(result => { const page = result as { text: string; nextCursor: number | null }; setChunks(previous => previous + page.text); setCursor(page.nextCursor); }).catch(() => {}); }}>读取完整负载{cursor ? '下一段' : ''}</Button>}
    {chunks && <pre>{chunks}</pre>}
    {detail.query?.action === 'payload.read' && <Button onClick={() => onOpen('payload.links', { roleId, id: detail.query!.payload.id })}>查阅负载中的引用</Button>}
    {value?.text && value?.nextCursor !== null && detail.query?.action === 'payload.read' && <Button onClick={() => onOpen('payload.read', { ...detail.query!.payload, offset: value.nextCursor })}>读取后续正文</Button>}
  </>;
}
