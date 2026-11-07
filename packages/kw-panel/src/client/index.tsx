import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-gateway/client';
import type {} from '@deepseek-ai/dsh-client-connection/client';
import type {} from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { useEffect, useState } from 'react';
import type { Role, Memory, LifePlan, Experience, Operation, Json, Extension } from '@kwagent/core';
import contribution from '@kwagent/kw-panel/remote';
import styles from './style.css?inline';
import { RoleForm, PlanForm, RoleSkillForm } from './forms.tsx';
import { Timeline, TaskList, EventHistory, People, CapabilityList, DetailReader, PageNotice, useRecords, type Detail } from './views.tsx';
import { ContinuityView } from './continuity.tsx';

interface Snapshot {
  version: string; truncated: boolean;
  revision: number; rolesGeneration: number; maintenance: boolean; started: boolean; startupError: string | null;
  roles: (Role & { runtime: { state: string; error: string | null }; usage: { requests: number; tokens: number }; memoryStatus?: { status: string; reason?: string; retryAt?: number } | null })[];
  events: Experience[]; memories: Memory[]; plans: LifePlan[]; operations: Operation[]; extensions: Extension[];
  connections: Record<string, { state: string; error: string | null }>; config: { vision: { model: string | null }; chat: { model: string | null; provider: string } };
}
type Call = (action: string, payload?: unknown) => Promise<unknown>;
const tabs = ['活动', '角色', '记忆', '人物', '世界', '目标与安排', '能力', '运维'] as const;
const stateLabels: Record<string, string> = { active: '已启用', disabled: '未启用', paused: '已暂停', stopped: '已停止', running: '正在活动', waiting: '等待中', resetting: '正在重置', deleting: '正在删除', 'management-pending': '等待管理操作恢复', error: '需要处理', quota: '已达到额度', maintenance: '维护中', 'outside-active-hours': '活动时段外' };

function Panel({ ctx }: { ctx: Context }) {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [roleId, setRoleId] = useState('');
  const [tab, setTab] = useState<typeof tabs[number]>('活动');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [scene, setScene] = useState('');
  const [peer, setPeer] = useState('');
  const [found, setFound] = useState<Memory[] | null>(null);
  const [olderMemories, setOlderMemories] = useState<Memory[]>([]);
  const [memoryEnd, setMemoryEnd] = useState(false);
  const [moreRoles, setMoreRoles] = useState<Role[]>([]);
  const [roleCursor, setRoleCursor] = useState<number | null>(0);
  const [detail, setDetailState] = useState<Detail | null>(null);
  const [detailTrail, setDetailTrail] = useState<Detail[]>([]);
  const setDetail = (value: unknown) => { setDetailTrail([]); setDetailState(value === null ? null : { value }); };
  const [editing, setEditing] = useState<Role | 'new' | null>(null);
  const [editingPlan, setEditingPlan] = useState<LifePlan | undefined>();
  const [roleAction, setRoleAction] = useState<{ kind: 'reset' | 'delete'; role: Role } | null>(null);
  const [notice, setNotice] = useState('');
  const [connectionRevision, setConnectionRevision] = useState(0);
  useEffect(() => { const release = ctx.on('connection/reset', () => setConnectionRevision(value => value + 1)); return () => { release(); }; }, [ctx]);
  const call: Call = async (action, payload = null) => {
    setError(''); setBusy(true);
    try {
      const result = await ctx.remote.kwAgent.mutate(action, JSON.stringify(payload));
      if (!result.ok) throw new Error(result.error.message);
      const value = JSON.parse(result.value);
      if (action === 'memory.revise') setFound(previous => previous?.map(memory => memory.id === value.id ? value as Memory : memory) ?? null);
      return value;
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); throw error; }
    finally { setBusy(false); }
  };
  const open = (action: string, payload: Record<string, unknown>) => { const readAction = action === 'record.read' ? 'record.detail' : action; void call(readAction, payload).then(value => { if (detail) setDetailTrail(previous => [...previous, detail]); setDetailState({ value, query: { action: readAction, payload } }); }).catch(() => {}); };
  const editRole = (id: string) => { void call('role.read', { roleId: id }).then(value => setEditing(value as Role)).catch(() => {}); };
  const loadMemories = () => { void call('memory.list', { roleId, offset: allMemories.length }).then(value => { const page = value as { items: Memory[]; nextCursor: number | null }; setOlderMemories(previous => [...previous, ...page.items]); setMemoryEnd(page.nextCursor === null); }).catch(() => {}); };
  const editPlan = (id: string, owner = roleId) => { void call('record.read', { roleId: owner, kind: 'plan', id }).then(value => setEditingPlan(value as LifePlan)).catch(() => {}); };
  const planPage = useRecords<LifePlan>('plan', roleId, snapshot?.revision ?? 0, tab === '目标与安排', call);
  const extensionPage = useRecords<Extension>('extension', roleId, snapshot?.revision ?? 0, tab === '能力', call);
  const operationPage = useRecords<Operation>('operation', roleId, snapshot?.revision ?? 0, tab === '能力', call);
  useEffect(() => {
    const controller = new AbortController();
    const stream = ctx.remote.kwAgent.follow(roleId, controller.signal);
    void (async () => {
      try { for await (const frame of stream) setSnapshot(JSON.parse(frame.payload) as Snapshot); }
      catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error)); }
    })();
    return () => { controller.abort(); stream.dispose(); };
  }, [roleId, connectionRevision]);
  const role = snapshot?.roles.find(role => role.id === roleId);
  const currentEdit = editing && editing !== 'new' ? snapshot?.roles.find(role => role.id === editing.id) : undefined;
  const currentPlan = snapshot?.plans.find(plan => plan.id === editingPlan?.id) ?? planPage.items.find(plan => plan.id === editingPlan?.id);
  useEffect(() => { setOlderMemories([]); setMemoryEnd(false); setEditingPlan(undefined); setEditing(null); }, [roleId]);
  useEffect(() => {
    if (!snapshot) return;
    setMoreRoles([]); setRoleCursor(0);
    if (roleId && !snapshot.roles.some(item => item.id === roleId)) { setRoleId(''); setRoleAction(null); setDetail(null); }
  }, [snapshot?.rolesGeneration]);
  useEffect(() => { if (detail && window.matchMedia('(max-width:760px)').matches) document.querySelector('.kw-detail')?.scrollIntoView({ block: 'start' }); }, [detail]);
  const act = (action: string, payload?: unknown) => { void call(action, payload).catch(() => {}); };
  const roleItems: (Role & { runtime?: { state: string } })[] = [...new Map([...moreRoles, ...(snapshot?.roles ?? [])].map(role => [role.id, role])).values()];
  const allMemories = [...new Map([...olderMemories, ...(snapshot?.memories ?? [])].map(memory => [memory.id, memory])).values()];
  const memories = (found ?? allMemories).map(memory => allMemories.find(current => current.id === memory.id && current.revision > memory.revision) ?? memory).filter(memory => tab === '人物' ? ['person', 'relationship'].includes(memory.kind) : tab === '世界' ? memory.kind === 'world' : true);
  const rawDetail = detail?.value && typeof detail.value === 'object' ? detail.value as Record<string, unknown> : null;
  const detailEvent = rawDetail?.summary && typeof rawDetail.summary === 'object' ? rawDetail.summary as Record<string, unknown> : rawDetail;
  return <div className="kw-panel" data-store-revision={snapshot?.revision ?? 0}>
    <aside className="kw-roles">
      <header><h1>KWAgent</h1><Button size="sm" onClick={() => setEditing('new')}>创建角色</Button></header>
      <button className={!roleId ? 'kw-role selected' : 'kw-role'} onClick={() => setRoleId('')}>全部活动</button>
      {roleItems.map(item => <button key={item.id} data-role-id={item.id} className={roleId === item.id ? 'kw-role selected' : 'kw-role'} onClick={() => { setRoleId(item.id); setFound(null); setDetail(null); setRoleAction(null); setNotice(''); }}>
        <strong>{item.name}</strong><span>{stateLabels[item.runtime?.state ?? item.state] ?? item.state}</span>
      </button>)}
      {roleCursor !== null && <Button size="sm" onClick={() => { void call('records.list', { kind: 'role', cursor: roleCursor }).then(value => { const page = value as { items: Role[]; nextCursor: number | null }; setMoreRoles(previous => [...previous, ...page.items]); setRoleCursor(page.nextCursor); }).catch(() => {}); }}>{roleCursor ? '读取更多角色' : '读取角色列表'}</Button>}
      <footer>{snapshot ? `修订 ${snapshot.revision}` : '正在连接 Host'}<br />{snapshot?.maintenance ? '服务器维护中' : '角色自主安排活动'}</footer>
    </aside>
    <main className="kw-main">
      <header className="kw-header"><div><h2>{role?.name ?? '全部活动'}</h2><p>{role ? `${role.worldMode === 'real' ? '现实生活' : role.worldMode === 'fictional' ? '共同虚构世界' : '现实与虚构并存'} · 今日 ${role.usage.requests} 次请求，${role.usage.tokens} Token` : '查看角色的经历、认识和自主安排'}</p></div>
        {role && <div className="kw-actions"><Button disabled={busy || Boolean(roleAction)} onClick={() => act('role.control', { id: role.id, state: 'active' })}>启用</Button><Button disabled={busy || Boolean(roleAction)} onClick={() => act('role.control', { id: role.id, state: 'paused' })}>暂停</Button><Button disabled={busy || Boolean(roleAction)} onClick={() => act('role.control', { id: role.id, state: 'stopped' })}>停止</Button><Button disabled={busy || Boolean(roleAction)} onClick={() => { setNotice(''); setRoleAction({ kind: 'reset', role }); }}>重置对话</Button><Button disabled={busy || Boolean(roleAction)} onClick={() => { setNotice(''); setRoleAction({ kind: 'delete', role }); }}>删除角色</Button></div>}
      </header>
      {notice && <p role="status">{notice}</p>}
      {role?.memoryStatus?.status === 'deferred' && <p role="status" className="kw-prose">记忆待整理：{role.memoryStatus.reason}。原始经历已保留，群聊继续运行，空闲后重新整理。</p>}
      {roleAction && <section className="kw-error" role="dialog" aria-labelledby="kw-role-action-title">
        <h3 id="kw-role-action-title">{roleAction.kind === 'reset' ? '重置当前对话' : '删除角色'}</h3>
        <p>{roleAction.kind === 'reset' ? `为 ${roleAction.role.name} 创建空白会话，保留人设、长期记忆、人物关系和角色目标与安排。当前活动、后台任务及原会话的原生提醒将停止，未接纳的外部消息继续保留。` : `停止 ${roleAction.role.name}，解除会话绑定并取消后续安排。原始经历、记忆与修订历史保留；角色标识为历史归属保留，重新创建时使用新标识。`}</p>
        <div className="kw-actions"><Button variant="primary" disabled={busy} onClick={() => { const selected = roleAction; void call(selected.kind === 'reset' ? 'role.reset' : 'role.delete', { id: selected.role.id, expectedRevision: selected.role.revision }).then(() => { setRoleAction(null); setDetail(null); setNotice(selected.kind === 'reset' ? '当前对话已重置，长期记忆与角色设置保留。' : '角色已删除，历史记录保留。'); if (selected.kind === 'delete') { setMoreRoles(previous => previous.filter(item => item.id !== selected.role.id)); setRoleId(''); } }).catch(() => {}); }}>{roleAction.kind === 'reset' ? '确认重置' : '确认删除'}</Button><Button disabled={busy} onClick={() => { void call('role.read', { roleId: roleAction.role.id }).then(value => setRoleAction({ ...roleAction, role: value as Role })).catch(() => {}); }}>读取当前角色版本</Button><Button disabled={busy} onClick={() => setRoleAction(null)}>取消</Button></div>
      </section>}
      <nav aria-label="角色管理">{tabs.map(name => <button key={name} aria-current={tab === name ? 'page' : undefined} onClick={() => { setTab(name); setFound(null); }}>{name}</button>)}</nav>
      {(error || snapshot?.startupError || role?.runtime.error) && <div role="alert" className="kw-error">{error || role?.runtime.error || snapshot?.startupError}</div>}
      {editing && editing !== 'new' && currentEdit && editing.revision !== currentEdit.revision && <div role="alert" className="kw-error"><p>角色已经更新，输入内容已保留。当前人格：</p><p className="kw-prose">{currentEdit.persona}</p><Button onClick={() => editRole(currentEdit.id)}>读取当前版本</Button></div>}
      {tab === '目标与安排' && editingPlan && currentPlan && editingPlan.revision !== currentPlan.revision && <div role="alert" className="kw-error"><p>事项已经更新，输入内容已保留。当前内容：{currentPlan.instruction}</p><Button onClick={() => editPlan(currentPlan.id, currentPlan.roleId)}>读取当前事项版本</Button></div>}
      {!snapshot ? <p role="status">正在读取状态…</p> : editing ? <RoleForm key={editing === 'new' ? 'new' : `${editing.id}:${editing.revision}`} initial={editing === 'new' ? undefined : editing} config={snapshot.config.chat} busy={busy} call={call} onCancel={() => setEditing(null)} onSave={async value => { await call(editing === 'new' ? 'role.create' : 'role.update', editing === 'new' ? value : { id: editing.id, expectedRevision: editing.revision, patch: value }); setEditing(null); }} /> : <section className="kw-content">
        {tab === '活动' && <><EventInput roleId={roleId} call={call} /><TaskList roleId={roleId} revision={snapshot.revision} call={call} open={open} /><Timeline roleId={roleId} revision={snapshot.revision} call={call} open={open} /><EventHistory roleId={roleId} revision={snapshot.revision} call={call} open={open} unassigned={setDetail} /></>}
        {tab === '角色' && (role ? <><div className="kw-section-head"><h3>当前人格</h3><Button onClick={() => editRole(role.id)}>编辑角色</Button></div><p className="kw-prose">{role.persona}</p><h3>初始设定</h3><p className="kw-prose">{role.initialPersona}</p><h3>自我状态</h3><p>{role.selfState || '尚未形成当前状态。'}</p><h3>表达示例</h3><p className="kw-muted">仅作为表达风格，不作为真实经历。</p>{role.expressionExamples.map((example, index) => <p className="kw-prose" key={index}>{example}</p>)}<h3>会话归属</h3><p>群聊：{role.globalGroups ? '账号全局共享' : role.groups.join('、') || '尚未绑定'}；私聊：{role.defaultPrivate ? '账号默认角色' : role.contacts.join('、') || '按联系人绑定'}</p><Button onClick={() => open('history', { entity: 'role', id: role.id })}>查看人格修订</Button><Button onClick={() => open('persona.read', { roleId })}>读取完整人格</Button></> : <Empty text="选择或创建一个角色来编辑人格与会话归属。" />)}
        {tab === '角色' && <ContinuityView roleId={roleId} revision={snapshot.revision} call={call} open={open} kinds={['life', 'expression', 'reflection']} />}
        {tab === '人物' && <><People roleId={roleId} revision={snapshot.revision} call={call} open={open} /><ContinuityView roleId={roleId} revision={snapshot.revision} call={call} open={open} kinds={['relationship', 'thread', 'conversation']} /></>}
        {tab === '记忆' && <ContinuityView roleId={roleId} revision={snapshot.revision} call={call} open={open} kinds={['journal', 'reflection']} />}
        {['记忆', '世界'].includes(tab) && <>
          <form className="kw-search" onSubmit={event => { event.preventDefault(); if (roleId) void call('memory.recall', { roleId, query, semantic: Boolean(query), ...(scene ? { scene } : {}), ...(peer ? { peerId: Number(peer) } : {}) }).then(result => setFound(result as Memory[])).catch(() => {}); }}>
            <label>检索记忆<input value={query} onChange={event => setQuery(event.target.value)} placeholder="人物、共同经历或正在关注的问题" /></label>
            <label>会话类型<select value={scene} onChange={event => setScene(event.target.value)}><option value="">全部会话</option><option value="group">群聊</option><option value="private">私聊</option></select></label>
            <label>会话对象<input type="number" min="1" value={peer} onChange={event => setPeer(event.target.value)} placeholder="群号或联系人号" /></label><Button type="submit" disabled={!roleId || busy}>检索</Button>
          </form>
          {memories.length ? memories.map(memory => <MemoryEditor key={memory.id} memory={memory} call={call} onDetail={setDetail} open={open} />) : <Empty text={roleId ? '相关认识形成后会出现在这里。' : '选择角色后可以查阅和检索记忆。'} />}
          {roleId && !found && !memoryEnd && <Button disabled={busy} onClick={loadMemories}>读取更多认识</Button>}
        </>}
        {tab === '目标与安排' && <>
          <ContinuityView roleId={roleId} revision={snapshot.revision} call={call} open={open} kinds={['thread', 'conversation']} />
          <PlanForm key={editingPlan ? `${editingPlan.id}:${editingPlan.revision}` : roleId} roleId={roleId} call={call} initial={editingPlan} onDone={() => setEditingPlan(undefined)} />
          <PageNotice page={planPage} />
          {planPage.items.map(plan => <article className="kw-entry" key={plan.id}><h3>{plan.title}</h3><p>{plan.instruction}</p><p>{{ goal: '持续目标', condition: '条件事项', time: '时间安排' }[plan.kind]} · {{ pending: '待安排', active: '进行中', paused: '已暂停', completed: plan.kind === 'time' ? '已投递' : '已完成', cancelled: '已取消', error: '需要处理' }[plan.status]}</p><div className="kw-actions"><Button size="sm" onClick={() => editPlan(plan.id, plan.roleId)}>修改</Button><Button size="sm" onClick={() => open('record.read', { roleId: plan.roleId, kind: 'plan', id: plan.id })}>详情</Button><Button size="sm" onClick={() => act('plan', { roleId: plan.roleId, request: { action: 'complete', id: plan.id, expectedRevision: plan.revision } })}>完成</Button><Button size="sm" onClick={() => act('plan', { roleId: plan.roleId, request: { action: 'cancel', id: plan.id, expectedRevision: plan.revision } })}>取消</Button></div></article>)}
          {planPage.nextCursor !== null && <Button onClick={planPage.more}>读取更多事项</Button>}
        </>}
        {tab === '能力' && <>
          <h3>连接</h3>{Object.entries(snapshot.connections).map(([name, value]) => <p key={name}>{name}：{value.state}{value.error ? ` · ${value.error}` : ''}</p>)}<h3>模型</h3><p>视觉：{snapshot.config.vision.model ?? '尚未配置'}</p><p>记忆检索：SQLite FTS5、人物关联、时间及当前模型的查询扩展</p>
          <CapabilityList revision={snapshot.revision} call={call} open={open} /><h3>自主扩展</h3><ExtensionForm roleId={roleId} call={call} />
          {role && <RoleSkillForm key={role.id} roleId={role.id} revision={role.revision} call={call} />}
          <PageNotice page={extensionPage} />
          {extensionPage.items.map(extension => <article className="kw-entry" key={`${extension.roleId}:${extension.id}`}><h3>{extension.packageName}</h3><p>{extension.state}</p><Button onClick={() => act('extension', { roleId: extension.roleId, request: { action: extension.enabled ? 'disable' : 'enable', id: extension.id } })}>{extension.enabled ? '停用' : '启用'}</Button></article>)}
          {extensionPage.nextCursor !== null && <Button onClick={extensionPage.more}>读取更多扩展</Button>}
          <h3>工具记录</h3><PageNotice page={operationPage} />{operationPage.items.map(operation => <article className="kw-entry" key={operation.id}><p>{operation.tool} · {operation.state}</p><Button size="sm" onClick={() => operation.roleId ? open('source.read', { roleId: operation.roleId, id: operation.id }) : setDetail(operation)}>读取回执与参数</Button></article>)}
          {operationPage.nextCursor !== null && <Button onClick={operationPage.more}>读取更多操作</Button>}
        </>}
        {tab === '运维' && <><h3>服务器操作</h3><div className="kw-actions"><Button onClick={async () => setDetail(await call('doctor'))}>检查运行环境</Button><Button onClick={() => act(snapshot.maintenance ? 'resume' : 'quiesce')}>{snapshot.maintenance ? '恢复活动' : '进入维护'}</Button><Button disabled={busy} onClick={async () => setDetail(await call('backup'))}>创建备份</Button><Button disabled={busy} onClick={async () => setDetail(await call('reindex'))}>重建记忆索引</Button></div><p>应用版本 {snapshot.version} · Harness 0.2.2-alpha.2</p></>}
      </section>}
    </main>
    {detail !== null && <aside className="kw-detail"><div className="kw-section-head"><h3>内容与来源</h3><Button size="sm" onClick={() => setDetail(null)}>关闭</Button></div>{detailTrail.length > 0 && <Button size="sm" onClick={() => { setDetailState(detailTrail[detailTrail.length - 1]!); setDetailTrail(previous => previous.slice(0, -1)); }}>返回上一项</Button>}<DetailReader detail={detail} roleId={roleId} call={call} onOpen={open} />{detailEvent && 'seq' in detailEvent && 'id' in detailEvent && <TransferEvent eventId={String(detailEvent.id)} roles={roleItems} call={call} />}</aside>}
  </div>;
}

function Empty({ text }: { text: string }) { return <p className="kw-empty">{text}</p>; }
function TransferEvent({ eventId, roles, call }: { eventId: string; roles: Role[]; call: Call }) {
  const [target, setTarget] = useState('');
  return <form className="kw-form" onSubmit={event => { event.preventDefault(); void call('events.transfer', { ids: [eventId], targetRoleId: target }).catch(() => {}); }}><label>迁移经历到角色<select required value={target} onChange={event => setTarget(event.target.value)}><option value="">选择目标角色</option>{roles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label><Button type="submit" disabled={!target}>迁移经历</Button></form>;
}
function EventInput({ roleId, call }: { roleId: string; call: Call }) {
  const [text, setText] = useState('');
  return <form className="kw-search" onSubmit={event => { event.preventDefault(); void call('event', { roleId, text }).then(() => setText('')).catch(() => {}); }}><label>提供一段经历<textarea disabled={!roleId} value={text} onChange={event => setText(event.target.value)} placeholder={roleId ? '描述一件事情，让角色自行决定如何回应。' : '选择角色后提供经历'} /></label><Button type="submit" disabled={!roleId || !text}>提交事件</Button></form>;
}
function MemoryEditor({ memory, call, onDetail, open }: { memory: Memory; call: Call; onDetail(value: unknown): void; open(action: string, payload: Record<string, unknown>): void }) {
  const [editing, setEditing] = useState<Memory | null>(null); const [content, setContent] = useState(memory.content);
  const [epistemic, setEpistemic] = useState(memory.epistemic); const [realm, setRealm] = useState(memory.realm);
  return <article className="kw-entry">
    <h3>{memory.title}</h3><p className="kw-muted">{memory.kind} · {memory.epistemic} · 修订 {memory.revision}</p>
    {editing ? <><label>记忆正文<textarea aria-label="记忆正文" rows={8} value={content} onChange={event => setContent(event.target.value)} /></label><label>认识依据类型<select aria-label="认识依据类型" value={epistemic} onChange={event => setEpistemic(event.target.value as typeof epistemic)}><option value="observed">直接观察</option><option value="reported">他人转述</option><option value="inferred">主观推测</option><option value="fictional">虚构设定</option></select></label><label>认识情境<select aria-label="认识情境" value={realm} onChange={event => setRealm(event.target.value as typeof realm)}><option value="real">现实</option><option value="fictional">虚构</option><option value="mixed">并存</option></select></label>{editing.revision !== memory.revision && <div role="alert"><p>这条认识已更新，输入内容已保留。当前版本：</p><p className="kw-prose">{memory.content}</p><Button size="sm" onClick={() => { void call('memory.read', { roleId: memory.roleId, id: memory.id }).then(value => setEditing(value as Memory)).catch(() => {}); }}>使用当前修订号继续编辑</Button></div>}</> : <p className="kw-prose">{memory.content}</p>}
    <div className="kw-actions">
      <Button size="sm" onClick={() => { if (editing) { setEditing(null); return; } void call('memory.read', { roleId: memory.roleId, id: memory.id }).then(value => { const full = value as Memory; setEditing(full); setContent(full.content); setEpistemic(full.epistemic); setRealm(full.realm); }).catch(() => {}); }}>{editing ? '取消编辑' : '编辑认识'}</Button>
      {editing && <Button size="sm" onClick={() => { void call('memory.revise', { memory: { ...editing, content, epistemic, realm }, expectedRevision: editing.revision, reason: '人工修订认识' }).then(() => setEditing(null)).catch(() => {}); }}>保存</Button>}
      <Button size="sm" onClick={() => open('history', { entity: 'memory', id: memory.id })}>来源与版本</Button>
      <Button size="sm" onClick={() => open('sources.list', { roleId: memory.roleId, memoryId: memory.id })}>全部来源</Button>
    </div>
    <details><summary>原始依据</summary>{memory.sources.map(source => <Button key={source} size="sm" onClick={() => { void call('source.read', { roleId: memory.roleId, id: source }).then(onDetail).catch(() => {}); }}>{source}</Button>)}</details>
  </article>;
}
function ExtensionForm({ roleId, call }: { roleId: string; call: Call }) {
  const [id, setId] = useState(''); const [spec, setSpec] = useState('');
  return <form className="kw-search" onSubmit={event => { event.preventDefault(); void call('extension', { roleId, request: { action: 'install', id, spec } }).catch(() => {}); }}><label>扩展标识<input required value={id} onChange={event => setId(event.target.value)} /></label><label>包名或角色工程路径<input required value={spec} onChange={event => setSpec(event.target.value)} /></label><Button type="submit" disabled={!roleId}>安装扩展</Button></form>;
}

export const inject = ['slots', 'layout', 'locale', 'remote'];
export async function apply(ctx: Context): Promise<void> {
  const unmount = await ctx.remote.$mount(contribution);
  ctx.effect(() => unmount, 'kw-panel.remote');
  const style = document.createElement('style'); style.textContent = styles;
  ctx.effect(() => { document.head.append(style); return () => style.remove(); }, 'kw-panel.styles');
  await ctx.plugin({
    name: 'kw-panel-ui', inject: ['slots', 'layout', 'locale', 'remote', 'remote.kwAgent'],
    apply(inner: Context) {
      const panelId = 'kwagent' as MainPanelId;
      inner.slots.inject('main', () => inner.slots.register({ name: 'main', key: panelId, inject: () => ({ ctx: inner }) }, Panel));
      inner.slots.inject('sidebar.panellist', () => inner.slots.register({ name: 'sidebar.panellist', id: panelId, order: 2, label: () => 'KWAgent' }, ({ size }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M5 5h14v10H9l-4 4V5Z" /><path d="M9 9h6M9 12h4" /></svg>));
    },
  });
}
