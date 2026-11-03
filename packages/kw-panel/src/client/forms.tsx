import { useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { Json, LifePlan, Role } from '@kwagent/core';
type Call = (action: string, payload?: unknown) => Promise<unknown>;
const numbers = (text: string) => text.split(/[,，\s]+/).filter(Boolean).map(Number);
function object(value: Json | undefined): Record<string, Json> { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }

export function RoleForm({ initial, config, busy, onCancel, onSave }: { initial?: Role; config: { provider: string; model: string | null }; busy: boolean; onCancel(): void; onSave(value: unknown): Promise<void> }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [id, setId] = useState(initial?.id ?? '');
  const [persona, setPersona] = useState(initial?.persona ?? '');
  const [selfState, setSelfState] = useState(initial?.selfState ?? '');
  const [examples, setExamples] = useState(initial?.expressionExamples.join('\n\n') ?? '');
  const [provider, setProvider] = useState(initial?.provider ?? config.provider);
  const [model, setModel] = useState(initial?.model ?? config.model ?? '');
  const [world, setWorld] = useState(initial?.worldMode ?? 'real');
  const [groups, setGroups] = useState(initial?.groups.join(',') ?? '');
  const [contacts, setContacts] = useState(initial?.contacts.join(',') ?? '');
  const [global, setGlobal] = useState(initial?.globalGroups ?? false);
  const [privateRole, setPrivateRole] = useState(initial?.defaultPrivate ?? false);
  const [requests, setRequests] = useState(initial?.dailyRequests?.toString() ?? '');
  const [tokens, setTokens] = useState(initial?.dailyTokens?.toString() ?? '');
  const [start, setStart] = useState(initial?.activeHours?.start ?? '');
  const [end, setEnd] = useState(initial?.activeHours?.end ?? '');
  const [budget, setBudget] = useState(initial?.memoryTokens ?? 8192);
  return <form className="kw-form" onSubmit={event => {
    event.preventDefault();
    void onSave({ id, name, accountId: initial?.accountId ?? 'main', initialPersona: initial?.initialPersona ?? persona, persona, selfState, expressionExamples: examples.split(/\n\s*\n/).filter(value => value.trim()), provider, model, worldMode: world,
      groups: numbers(groups), contacts: numbers(contacts), globalGroups: global, defaultPrivate: privateRole,
      memoryTokens: budget, dailyRequests: requests ? Number(requests) : null, dailyTokens: tokens ? Number(tokens) : null,
      activeHours: start || end ? { start, end } : null }).catch(() => {});
  }}>
    <h3>{initial ? '编辑角色' : '创建角色'}</h3>
    <label>标识<input required pattern="[A-Za-z0-9]([A-Za-z0-9_]|-){0,63}" disabled={Boolean(initial)} value={id} onChange={event => setId(event.target.value)} /></label>
    <label>名称<input required value={name} onChange={event => setName(event.target.value)} /></label>
    <label>人格<textarea required rows={9} value={persona} onChange={event => setPersona(event.target.value)} /></label>
    <label>自我状态<textarea value={selfState} onChange={event => setSelfState(event.target.value)} /></label>
    <label>表达示例<textarea rows={5} value={examples} onChange={event => setExamples(event.target.value)} placeholder="示例之间留空行，仅作为风格上下文。" /></label>
    <label>模型提供者<input required value={provider} onChange={event => setProvider(event.target.value)} /></label>
    <label>模型<input required value={model} onChange={event => setModel(event.target.value)} /></label>
    <label>世界模式<select value={world} onChange={event => setWorld(event.target.value as Role['worldMode'])}><option value="real">现实生活</option><option value="fictional">共同虚构世界</option><option value="mixed">现实与虚构并存</option></select></label>
    <label>绑定群聊<input value={groups} onChange={event => setGroups(event.target.value)} placeholder="使用逗号分隔真实群号" /></label>
    <label>绑定联系人<input value={contacts} onChange={event => setContacts(event.target.value)} /></label>
    <label className="kw-check"><input type="checkbox" checked={global} onChange={event => setGlobal(event.target.checked)} />接收账号全部未绑定群聊</label>
    <label className="kw-check"><input type="checkbox" checked={privateRole} onChange={event => setPrivateRole(event.target.checked)} />作为账号默认私聊角色</label>
    <label>记忆上下文预算<input type="number" min="256" max="131072" required value={budget} onChange={event => setBudget(Number(event.target.value))} /></label>
    <label>每日请求额度<input type="number" min="1" value={requests} onChange={event => setRequests(event.target.value)} placeholder="留空表示不设额度" /></label>
    <label>每日 Token 额度<input type="number" min="1" value={tokens} onChange={event => setTokens(event.target.value)} placeholder="留空表示不设额度" /></label>
    <label>活动开始时间<input type="time" value={start} onChange={event => setStart(event.target.value)} /></label>
    <label>活动结束时间<input type="time" value={end} onChange={event => setEnd(event.target.value)} /></label>
    <div className="kw-actions"><Button type="submit" variant="primary" disabled={busy}>保存角色</Button><Button onClick={onCancel}>取消</Button></div>
  </form>;
}

export function PlanForm({ roleId, call, initial, onDone }: { roleId: string; call: Call; initial?: LifePlan; onDone(): void }) {
  const timing = object(initial?.timing);
  const nested = object(timing.daily ?? timing.weekly ?? timing.cron);
  const [title, setTitle] = useState(initial?.title ?? '');
  const [instruction, setInstruction] = useState(initial?.instruction ?? '');
  const [kind, setKind] = useState(initial?.kind ?? 'goal');
  const [timeKind, setTimeKind] = useState(String(timing.kind ?? 'after'));
  const [seconds, setSeconds] = useState(String(timing.after_seconds ?? timing.every_seconds ?? '3600'));
  const [at, setAt] = useState(String(timing.at ?? ''));
  const [clock, setClock] = useState(String(nested.time ?? '09:00'));
  const [zone, setZone] = useState(String(nested.time_zone ?? 'Asia/Shanghai'));
  const [weekdays, setWeekdays] = useState(Array.isArray(nested.weekdays) ? nested.weekdays.join(',') : '1,2,3,4,5');
  const [expression, setExpression] = useState(String(nested.expression ?? '0 9 * * *'));
  const [rule, setRule] = useState(String(timing.rrule ?? ''));
  const [condition, setCondition] = useState(initial?.condition?.text ?? '');
  const [types, setTypes] = useState(initial?.condition?.eventTypes.join(',') ?? '');
  const [peers, setPeers] = useState(initial?.condition?.peerIds.join(',') ?? '');
  const [busy, setBusy] = useState(false);
  const [scene, setScene] = useState(initial?.context?.scene ?? '');
  const [peerId, setPeerId] = useState(String(initial?.context?.peerId ?? ''));
  const [sources, setSources] = useState(initial?.sources.join('\n') ?? '');
  return <form className="kw-form" onSubmit={event => {
    event.preventDefault();
    const value: Record<string, unknown> = { action: initial ? 'update' : 'create', ...(initial ? { id: initial.id, expectedRevision: initial.revision } : {}), kind, title, instruction };
    value.context = scene ? { scene, peerId: Number(peerId) } : null; value.sources = sources.split(/\s+/).filter(Boolean);
    if (kind === 'condition') value.condition = { text: condition, eventTypes: types.split(/[,，\s]+/).filter(Boolean), peerIds: numbers(peers) };
    if (kind === 'time') {
      const values: Record<string, unknown> = { after: { kind: 'after', after_seconds: Number(seconds) }, every: { kind: 'every', every_seconds: Number(seconds) }, at: { kind: 'at', at }, daily: { kind: 'daily', daily: { time: clock, time_zone: zone } }, weekly: { kind: 'weekly', weekly: { time: clock, time_zone: zone, weekdays: numbers(weekdays) } }, cron: { kind: 'cron', cron: { expression, time_zone: zone } }, rrule: { kind: 'rrule', rrule: rule } };
      value.timing = values[timeKind];
    }
    setBusy(true);
    void call('plan', { roleId, request: value }).then(() => { setTitle(''); setInstruction(''); onDone(); }).catch(() => {}).finally(() => setBusy(false));
  }}>
    <h3>{initial ? '修改目标与安排' : '添加目标或唤醒事项'}</h3>
    <label>类型<select value={kind} onChange={event => setKind(event.target.value as LifePlan['kind'])}><option value="goal">持续目标</option><option value="condition">条件事项</option><option value="time">时间安排</option></select></label>
    <label>标题<input required value={title} onChange={event => setTitle(event.target.value)} /></label>
    <label>内容<textarea required value={instruction} onChange={event => setInstruction(event.target.value)} /></label>
    <label>交流情境<select value={scene} onChange={event => setScene(event.target.value as typeof scene)}><option value="">内部自主活动</option><option value="group">群聊</option><option value="private">私聊</option></select></label>
    {scene && <label>会话对象<input type="number" min="1" required value={peerId} onChange={event => setPeerId(event.target.value)} /></label>}
    <label>来源引用<textarea value={sources} onChange={event => setSources(event.target.value)} placeholder="真实事件或操作 ID，使用空白分隔。" /></label>
    {kind === 'condition' && <><label>触发条件<textarea required value={condition} onChange={event => setCondition(event.target.value)} /></label><label>相关事件类型<input value={types} onChange={event => setTypes(event.target.value)} placeholder="留空表示任意事件，多个类型使用逗号分隔" /></label><label>相关会话<input value={peers} onChange={event => setPeers(event.target.value)} placeholder="留空表示任意会话" /></label></>}
    {kind === 'time' && <><label>时间规则<select value={timeKind} onChange={event => setTimeKind(event.target.value)}><option value="after">延迟一次</option><option value="at">指定时间</option><option value="every">固定周期</option><option value="daily">每日</option><option value="weekly">每周</option><option value="cron">Cron</option><option value="rrule">RRULE</option></select></label>
      {['after', 'every'].includes(timeKind) && <label>{timeKind === 'after' ? '延迟秒数' : '周期秒数'}<input type="number" required min={timeKind === 'every' ? 60 : 1} value={seconds} onChange={event => setSeconds(event.target.value)} /></label>}
      {timeKind === 'at' && <label>执行时间<input required value={at} onChange={event => setAt(event.target.value)} placeholder="带时区的 ISO 时间，例如 2026-11-04T09:00:00+08:00" /></label>}
      {['daily', 'weekly'].includes(timeKind) && <label>每日时间<input type="time" required value={clock} onChange={event => setClock(event.target.value)} /></label>}
      {timeKind === 'weekly' && <label>星期<input required value={weekdays} onChange={event => setWeekdays(event.target.value)} placeholder="周一为1，周日为7，使用逗号分隔" /></label>}
      {timeKind === 'cron' && <label>Cron 表达式<input required value={expression} onChange={event => setExpression(event.target.value)} /></label>}
      {['daily', 'weekly', 'cron'].includes(timeKind) && <label>时区<input required value={zone} onChange={event => setZone(event.target.value)} /></label>}
      {timeKind === 'rrule' && <label>RRULE<textarea required rows={4} value={rule} onChange={event => setRule(event.target.value)} placeholder="包含 DTSTART 和 RRULE" /></label>}
    </>}
    <div className="kw-actions"><Button type="submit" disabled={!roleId || busy}>保存事项</Button>{initial && <Button onClick={onDone}>取消编辑</Button>}</div>
  </form>;
}
