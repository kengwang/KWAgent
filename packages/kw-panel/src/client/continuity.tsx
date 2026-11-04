import { useEffect, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { ContinuityData, ContinuityRecord } from '@kwagent/core';
import { PageNotice, usePages, type Call, type Open } from './views.tsx';

const labels: Record<string, string> = { life: '当前生活', relationship: '相处方式', thread: '未完话头', conversation: '交流判断', expression: '表达习惯', reflection: '短期反思', journal: '日记', active: '进行中', archived: '已归档', deferred: '暂缓', resolved: '已解决', declined: '对方拒绝', cancelled: '已取消', expired: '已失效', open: '开放交流', closed: '已收尾', candidate: '待采用', adopted: '已采用', disabled: '已停用', planned: '准备', in_progress: '进行', paused: '暂停', completed: '完成' };
const states: Record<string, string[]> = { life: ['active', 'archived'], relationship: ['active', 'archived'], thread: ['active', 'deferred', 'resolved', 'declined', 'cancelled', 'expired'], conversation: ['open', 'closed', 'deferred', 'archived'], expression: ['candidate', 'adopted', 'disabled', 'archived'], reflection: ['active', 'archived'], journal: ['active', 'archived'] };
interface Entry extends ContinuityRecord { kind: string; title: string; status: string; content: string; expiresAt: string | null }
export function ContinuityView({ roleId, revision, call, open, kinds }: { roleId: string; revision: number; call: Call; open: Open; kinds: ContinuityData['kind'][] }) {
  const [kind, setKind] = useState(''); const [query, setQuery] = useState(''); const [search, setSearch] = useState(''); const [editor, setEditor] = useState<ContinuityRecord | 'new' | null>(null);
  const page = usePages<Entry>('continuity.list', { roleId, kinds, ...(kind ? { kind } : {}), query: search }, item => item.id, revision, call, Boolean(roleId));
  useEffect(() => { setEditor(null); setKind(''); setQuery(''); setSearch(''); }, [roleId, kinds.join(',')]);
  const edit = (id: string) => { void call('continuity.read', { roleId, id, raw: true }).then(value => setEditor(value as ContinuityRecord)).catch(() => {}); };
  return <section aria-label="生活与关系连续性">
    <div className="kw-section-head"><h3>生活与关系连续性</h3><Button disabled={!roleId} onClick={() => setEditor('new')}>添加连续性记录</Button></div>
    <p className="kw-muted">生活与主观认识、表达风格、反思和日记保留各自语义。计划与判断不代表已经发送或完成。</p>
    {editor && <ContinuityForm key={editor === 'new' ? 'new' : `${editor.id}:${editor.revision}`} roleId={roleId} initial={editor === 'new' ? undefined : editor} call={call} onDone={() => { setEditor(null); page.refresh(); }} onReload={() => { if (editor !== 'new') edit(editor.id); }} kinds={kinds} />}
    <form className="kw-search" onSubmit={event => { event.preventDefault(); setSearch(query); page.refresh(); }}><label>连续性类型<select value={kind} onChange={event => setKind(event.target.value)}><option value="">当前页面全部类型</option>{kinds.map(item => <option value={item} key={item}>{labels[item]}</option>)}</select></label><label>查找记录<input value={query} onChange={event => setQuery(event.target.value)} /></label><Button type="submit" disabled={!roleId}>查找连续性</Button></form>
    <PageNotice page={page} />
    {page.items.filter(record => kinds.includes(record.kind as ContinuityData['kind'])).map(record => <article className="kw-entry" key={record.id} data-continuity-id={record.id}><h3>{record.title}</h3><p className="kw-muted">{labels[record.kind]} · {labels[record.status] ?? record.status} · 修订 {record.revision}{record.expiresAt ? ` · 有效至 ${new Date(record.expiresAt).toLocaleString()}` : ''}</p><p className="kw-prose">{record.content}</p><div className="kw-actions"><Button size="sm" onClick={() => edit(record.id)}>编辑连续性</Button><Button size="sm" onClick={() => open('continuity.read', { roleId, id: record.id })}>阅读依据与回执</Button><Button size="sm" onClick={() => open('history', { entity: 'continuity', id: record.id })}>修订历史</Button></div></article>)}
    {!page.items.length && <p className="kw-empty">相关生活、相处方式和持续事项形成后显示在这里。</p>}
    {page.nextCursor !== null && <Button onClick={page.more}>读取更多连续性</Button>}
  </section>;
}
function ContinuityForm({ roleId, initial, call, onDone, onReload, kinds }: { roleId: string; initial?: ContinuityRecord; call: Call; onDone(): void; onReload(): void; kinds: ContinuityData['kind'][] }) {
  const [kind, setKind] = useState<ContinuityData['kind']>(initial?.data.kind ?? kinds[0]!); const data = initial?.data;
  const [title, setTitle] = useState(data?.title ?? ''); const [content, setContent] = useState(data?.content ?? ''); const [status, setStatus] = useState(data?.status ?? states[kind]![0]!);
  const [people, setPeople] = useState(data?.people.join('\n') ?? ''); const [scene, setScene] = useState(data?.context?.scene ?? ''); const [peer, setPeer] = useState(String(data?.context?.peerId ?? '')); const [realm, setRealm] = useState(data?.realm ?? 'real');
  const [sources, setSources] = useState(data?.sources.join('\n') ?? ''); const [reason, setReason] = useState(''); const [expires, setExpires] = useState(data?.expiresAt ?? ''); const [applicable, setApplicable] = useState(data?.applicableAt ?? '');
  const [review, setReview] = useState(data && 'reviewAt' in data ? data.reviewAt ?? '' : ''); const [expected, setExpected] = useState(data?.kind === 'thread' ? data.expectedAt ?? '' : ''); const [answer, setAnswer] = useState(data?.kind === 'thread' ? data.answer : '');
  const [examples, setExamples] = useState(data?.kind === 'expression' ? data.examples.join('\n') : ''); const [situations, setSituations] = useState(data && 'situations' in data ? data.situations.join('\n') : ''); const [uncertainty, setUncertainty] = useState(data?.kind === 'relationship' ? data.uncertainty : '');
  const [activity, setActivity] = useState(data?.kind === 'life' ? data.activity : null); const [concerns, setConcerns] = useState(data?.kind === 'life' ? data.concerns.join('\n') : ''); const [emotions, setEmotions] = useState(data?.kind === 'life' ? data.emotions : []);
  const [conflict, setConflict] = useState(false); const [busy, setBusy] = useState(false);
  const lines = (text: string) => text.split(/\n/).map(value => value.trim()).filter(Boolean);
  return <form className="kw-form" onSubmit={event => {
    event.preventDefault(); setBusy(true);
    const value: Record<string, unknown> = { ...data, kind, title, content, status, people: people.split(/[\s,，]+/).filter(Boolean), context: scene ? { scene, peerId: Number(peer) } : null, realm, sources: lines(sources), expiresAt: expires || null, applicableAt: applicable || null };
    if (kind === 'life') Object.assign(value, { activity, concerns: lines(concerns), emotions });
    if (kind === 'relationship') Object.assign(value, { uncertainty });
    if (kind === 'thread') Object.assign(value, { reviewAt: review || null, expectedAt: expected || null, answer });
    if (kind === 'conversation') Object.assign(value, { reviewAt: review || null });
    if (kind === 'expression') Object.assign(value, { examples: lines(examples), situations: lines(situations) });
    if (kind === 'reflection') Object.assign(value, { situations: lines(situations) });
    void call('continuity.revise', { roleId, ...(initial ? { id: initial.id } : {}), expectedRevision: initial?.revision ?? null, data: value, reason }).then(onDone).catch(() => setConflict(true)).finally(() => setBusy(false));
  }}>
    <h3>{initial ? '编辑连续性记录' : '新建连续性记录'}</h3>
    {conflict && <div role="alert"><p>提交未完成，输入已保留。读取当前版本后可以重新编辑。</p>{initial && <Button onClick={onReload}>读取连续性当前版本</Button>}</div>}
    <label>记录类型<select aria-label="记录类型" disabled={Boolean(initial)} value={kind} onChange={event => { const next = event.target.value as ContinuityData['kind']; setKind(next); setStatus(states[next]![0]!); }}>{kinds.map(item => <option key={item} value={item}>{labels[item]}</option>)}</select></label>
    <label>记录标题<input aria-label="记录标题" required value={title} onChange={event => setTitle(event.target.value)} /></label><label>记录正文<textarea aria-label="记录正文" required rows={5} value={content} onChange={event => setContent(event.target.value)} /></label>
    <label>记录状态<select aria-label="记录状态" value={status} onChange={event => setStatus(event.target.value)}>{states[kind]!.map(item => <option key={item} value={item}>{labels[item]}</option>)}</select></label>
    <label>相关账号<input value={people} onChange={event => setPeople(event.target.value)} placeholder="实际账号，使用空白分隔" /></label>
    <label>适用场合<select aria-label="适用场合" value={scene} onChange={event => setScene(event.target.value as typeof scene)}><option value="">角色通用</option><option value="group">指定群聊</option><option value="private">指定私聊</option></select></label>{scene && <label>会话对象<input type="number" min="1" required value={peer} onChange={event => setPeer(event.target.value)} /></label>}
    <label>现实与虚构<select value={realm} onChange={event => setRealm(event.target.value as typeof realm)}><option value="real">现实</option><option value="fictional">虚构</option><option value="mixed">并存</option></select></label>
    <label>开始适用时间<input value={applicable} onChange={event => setApplicable(event.target.value)} placeholder="带时区的 ISO 时间，可留空" /></label><label>失效时间<input value={expires} onChange={event => setExpires(event.target.value)} placeholder="反思默认七天，其他可留空" /></label>
    {(kind === 'thread' || kind === 'conversation') && <label>下次复核时间<input aria-label="下次复核时间" value={review} onChange={event => setReview(event.target.value)} placeholder="带时区的 ISO 时间；届时重新判断" /></label>}
    {kind === 'thread' && <><label>预计时间<input value={expected} onChange={event => setExpected(event.target.value)} /></label><label>已有答复<textarea value={answer} onChange={event => setAnswer(event.target.value)} /></label></>}
    {kind === 'relationship' && <label>尚未确定的理解<textarea value={uncertainty} onChange={event => setUncertainty(event.target.value)} /></label>}
    {kind === 'expression' && <label>表达实例<textarea required value={examples} onChange={event => setExamples(event.target.value)} placeholder="每行一条；仅为表达风格" /></label>}
    {(kind === 'expression' || kind === 'reflection') && <label>适用情境<textarea value={situations} onChange={event => setSituations(event.target.value)} placeholder="每行一条" /></label>}
    {kind === 'life' && <><label>牵挂与疑问<textarea value={concerns} onChange={event => setConcerns(event.target.value)} /></label>{activity ? <><label>当前事情<input required value={activity.title} onChange={event => setActivity({ ...activity, title: event.target.value })} /></label><label>事情进展<textarea value={activity.progress} onChange={event => setActivity({ ...activity, progress: event.target.value })} /></label><label>事情状态<select value={activity.state} onChange={event => setActivity({ ...activity, state: event.target.value as typeof activity.state })}>{['planned', 'in_progress', 'paused', 'completed', 'cancelled'].map(item => <option key={item} value={item}>{labels[item]}</option>)}</select></label><label>执行依据<textarea value={activity.sources.join('\n')} onChange={event => setActivity({ ...activity, sources: lines(event.target.value) })} /></label><Button onClick={() => setActivity(null)}>清除当前事情</Button></> : <Button onClick={() => setActivity({ title: '', state: 'planned', progress: '', sources: [] })}>添加当前事情</Button>}{emotions.map((emotion, index) => <fieldset key={index}><legend>感受 {index + 1}</legend><label>感受<input required value={emotion.text} onChange={event => setEmotions(emotions.map((item, i) => i === index ? { ...item, text: event.target.value } : item))} /></label><label>形成原因<input required value={emotion.reason} onChange={event => setEmotions(emotions.map((item, i) => i === index ? { ...item, reason: event.target.value } : item))} /></label><label>感受有效至<input value={emotion.expiresAt ?? ''} onChange={event => setEmotions(emotions.map((item, i) => i === index ? { ...item, expiresAt: event.target.value || undefined } : item))} /></label><Button onClick={() => setEmotions(emotions.filter((_, i) => i !== index))}>移除感受</Button></fieldset>)}<Button onClick={() => setEmotions([...emotions, { text: '', reason: '', formedAt: new Date().toISOString() }])}>添加感受</Button></>}
    <label>记录依据<textarea aria-label="记录依据" value={sources} onChange={event => setSources(event.target.value)} placeholder="真实事件或操作标识，每行一条；人工声明可以留空" /></label><label>修改理由<textarea aria-label="修改理由" required value={reason} onChange={event => setReason(event.target.value)} /></label>
    <div className="kw-actions"><Button type="submit" disabled={busy}>保存连续性</Button><Button onClick={onDone}>取消连续性编辑</Button></div>
  </form>;
}
