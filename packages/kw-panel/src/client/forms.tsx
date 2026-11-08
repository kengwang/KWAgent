import { useEffect, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { Json, LifePlan, Role, CharacterDraft } from '@kwagent/core';
import { RoleModelPresets } from './models.tsx';
import { CharacterGenerator } from './character.tsx';
type Call = (action: string, payload?: unknown) => Promise<unknown>;
const numbers = (text: string) => text.split(/[,，\s]+/).filter(Boolean).map(Number);
function object(value: Json | undefined): Record<string, Json> { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }

export function RoleForm({ initial, config, busy, call, revision, manageModels, onCancel, onSave }: { initial?: Role; config: { provider: string; model: string | null }; busy: boolean; call: Call; revision: number; manageModels(): void; onCancel(): void; onSave(value: unknown): Promise<void> }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [id, setId] = useState(initial?.id ?? '');
  const [persona, setPersona] = useState(initial?.persona ?? '');
  const [initialPersona, setInitialPersona] = useState(initial?.initialPersona ?? '');
  const [worldEntries, setWorldEntries] = useState<CharacterDraft['world']>([]);
  const [generationId, setGenerationId] = useState<string>();
  const [generating, setGenerating] = useState(false);
  const [selfState, setSelfState] = useState(initial?.selfState ?? '');
  const [examples, setExamples] = useState(initial?.expressionExamples.join('\n\n') ?? '');
  const [preinjectSkills, setPreinjectSkills] = useState(initial?.preinjectSkills.join('\n') ?? '');
  const [adminQQs, setAdminQQs] = useState(initial?.adminQQs.join('\n') ?? '');
  const [provider, setProvider] = useState(initial?.provider ?? config.provider);
  const [model, setModel] = useState(initial?.model ?? config.model ?? '');
  const [presets, setPresets] = useState({ chat: initial?.chatPresetId ?? '', vision: initial?.visionPresetId ?? '', image: initial?.imagePresetId ?? '' });
  const [reasoningEffort, setReasoningEffort] = useState(initial?.reasoningEffort ?? '');
  const [reasoning, setReasoning] = useState<{ efforts: { id: string; name: string }[]; defaultEffort: string | null } | null>(null);
  const [reasoningError, setReasoningError] = useState('');
  const [presetReasoning, setPresetReasoning] = useState<string | null>(null);
  useEffect(() => {
    let live = true; setPresetReasoning(null);
    if (presets.chat) void call('model.read', { id: presets.chat }).then(value => { if (live) { const preset = value as { reasoningEffort: string | null; provider: string; model: string }; setPresetReasoning(preset.reasoningEffort); setProvider(preset.provider); setModel(preset.model); } }).catch(() => {});
    return () => { live = false; };
  }, [presets.chat, revision]);
  useEffect(() => {
    let live = true; setReasoning(null); setReasoningError('');
    const timer = setTimeout(() => {
      if (!provider.trim() || !model.trim()) return;
      void call('model.reasoning', { provider, model }).then(value => { if (live) setReasoning(value as NonNullable<typeof reasoning>); }).catch(error => { if (live) setReasoningError(error instanceof Error ? error.message : String(error)); });
    }, 300);
    return () => { live = false; clearTimeout(timer); };
  }, [provider, model]);
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
  return <form className="kw-form" aria-label="角色配置" onSubmit={event => {
    event.preventDefault();
    void onSave({ id, name, accountId: initial?.accountId ?? 'main', initialPersona: initial?.initialPersona ?? (initialPersona || persona), persona, selfState, ...!initial ? { world: worldEntries, generationId } : {}, expressionExamples: examples.split(/\n\s*\n/).filter(value => value.trim()), preinjectSkills: preinjectSkills.split(/[,，\s]+/).filter(Boolean), provider, model, chatPresetId: presets.chat || null, visionPresetId: presets.vision || null, imagePresetId: presets.image || null, reasoningEffort: reasoningEffort || null, worldMode: world,
      groups: numbers(groups), contacts: numbers(contacts), adminQQs: numbers(adminQQs), globalGroups: global, defaultPrivate: privateRole,
      memoryTokens: budget, dailyRequests: requests ? Number(requests) : null, dailyTokens: tokens ? Number(tokens) : null,
      activeHours: start || end ? { start, end } : null }).catch(() => {});
  }}>
    <h3>{initial ? '编辑角色' : '创建角色'}</h3>
    <fieldset className="kw-fields" disabled={generating}>
    <RoleModelPresets call={call} revision={revision} values={presets} requiredChat={!initial || Boolean(initial.chatPresetId)} manageModels={manageModels} onSelect={(kind, id, preset) => { setPresets(previous => ({ ...previous, [kind]: id })); if (kind === 'chat') { setProvider(preset?.provider ?? initial?.provider ?? config.provider); setModel(preset?.model ?? initial?.model ?? config.model ?? ''); } }} />
    {!initial && <CharacterGenerator chatPresetId={presets.chat} reasoningEffort={reasoningEffort} call={call} onBusy={setGenerating} onDraft={draft => {
      setId(draft.id); setName(draft.name); setInitialPersona(draft.initialPersona); setPersona(draft.persona); setSelfState(draft.selfState); setExamples(draft.expressionExamples.join('\n\n')); setWorld(draft.worldMode); setWorldEntries(draft.world); setGenerationId(draft.generationId);
    }} />}
    <label>标识<input required pattern="[A-Za-z0-9]([A-Za-z0-9_]|-){0,63}" disabled={Boolean(initial)} value={id} onChange={event => setId(event.target.value)} /></label>
    <label>名称<input required value={name} onChange={event => setName(event.target.value)} /></label>
    {!initial && <label>初始设定<textarea rows={7} value={initialPersona} onChange={event => setInitialPersona(event.target.value)} placeholder="角色的身份、来历与世界观边界；留空使用人格内容。" /></label>}
    <label>人格<textarea required rows={9} value={persona} onChange={event => setPersona(event.target.value)} /></label>
    <label>自我状态<textarea value={selfState} onChange={event => setSelfState(event.target.value)} /></label>
    <label>表达示例<textarea rows={5} value={examples} onChange={event => setExamples(event.target.value)} placeholder="示例之间留空行，仅作为风格上下文。" /></label>
    <label>预注入 Skill 列表<textarea rows={4} value={preinjectSkills} onChange={event => setPreinjectSkills(event.target.value)} placeholder="每行填写一个已安装的 Skill 名称，例如 kwagent-life 或 lagrange。" /></label>
    <p>每个模型步骤自动读取并注入所选 Skill 正文；修改从下一步骤生效。引用资料仍按需读取，缺失或不可读取的 Skill 会明确报错。</p>
    {initial && !presets.chat && <p className="kw-muted">当前聊天配置：{provider} / {model}。选择全局聊天方案后使用该方案。</p>}
    <label>对话推理等级<select aria-label="对话推理等级" value={reasoningEffort} disabled={busy || !reasoning} onChange={event => setReasoningEffort(event.target.value)}>
      <option value="">{presetReasoning ? `跟随聊天预设（${presetReasoning}）` : `跟随提供商默认值${reasoning?.defaultEffort ? `（${reasoning.defaultEffort}）` : ''}`}</option>
      {reasoning?.efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}（{effort.id}）</option>)}
      {reasoningEffort && !reasoning?.efforts.some(effort => effort.id === reasoningEffort) && <option value={reasoningEffort}>{reasoningEffort}（当前模型未声明）</option>}
    </select></label>
    {reasoningError && <p role="status">无法读取模型推理等级：{reasoningError}</p>}
    <p>用于本角色的对话与工具推理，修改从下一模型步骤生效，并在重启后保留。记忆整理与检索扩展沿用辅助请求的现有策略。</p>
    <label>世界模式<select value={world} onChange={event => setWorld(event.target.value as Role['worldMode'])}><option value="real">现实生活</option><option value="fictional">共同虚构世界</option><option value="mixed">现实与虚构并存</option></select></label>
    {!initial && worldEntries.length > 0 && <section className="kw-world-drafts" aria-label="生成的世界条目"><h4>世界条目</h4><p className="kw-muted">创建角色时一并保存，可在世界页面继续阅读和修订。</p>{worldEntries.map((entry, index) => <div className="kw-world-draft" key={index}>
      <label>世界条目标题<input required aria-label={`世界条目 ${index + 1} 标题`} value={entry.title} onChange={event => setWorldEntries(previous => previous.map((item, offset) => offset === index ? { ...item, title: event.target.value } : item))} /></label>
      <label>世界条目内容<textarea required rows={5} aria-label={`世界条目 ${index + 1} 内容`} value={entry.content} onChange={event => setWorldEntries(previous => previous.map((item, offset) => offset === index ? { ...item, content: event.target.value } : item))} /></label>
      <label>条目情境<select aria-label={`世界条目 ${index + 1} 情境`} value={entry.realm} onChange={event => setWorldEntries(previous => previous.map((item, offset) => offset === index ? { ...item, realm: event.target.value as typeof item.realm } : item))}><option value="real">现实认识</option><option value="fictional">虚构设定</option><option value="mixed">现实与虚构并存</option></select></label>
      <Button type="button" onClick={() => setWorldEntries(previous => previous.filter((_, offset) => offset !== index))}>移除此条目</Button>
    </div>)}</section>}
    <label>绑定群聊<input value={groups} onChange={event => setGroups(event.target.value)} placeholder="使用逗号分隔真实群号" /></label>
    <label>绑定联系人<input value={contacts} onChange={event => setContacts(event.target.value)} /></label>
    <label>角色管理员 QQ<textarea rows={3} value={adminQQs} onChange={event => setAdminQQs(event.target.value)} placeholder="使用换行或逗号分隔。群主和群管理员不会自动获得角色管理权限。" /></label>
    <p>管理员 QQ 和实际消息来源会写入角色提示词，由角色判断请求与操作；昵称、群权限和转发不会改变配置的管理员身份。</p>
    <label className="kw-check"><input type="checkbox" checked={global} onChange={event => setGlobal(event.target.checked)} />接收账号全部未绑定群聊</label>
    <label className="kw-check"><input type="checkbox" checked={privateRole} onChange={event => setPrivateRole(event.target.checked)} />作为账号默认私聊角色</label>
    <label>记忆上下文预算<input type="number" min="256" max="131072" required value={budget} onChange={event => setBudget(Number(event.target.value))} /></label>
    <label>每日请求额度<input type="number" min="1" value={requests} onChange={event => setRequests(event.target.value)} placeholder="留空表示不设额度" /></label>
    <label>每日 Token 额度<input type="number" min="1" value={tokens} onChange={event => setTokens(event.target.value)} placeholder="留空表示不设额度" /></label>
    <label>活动开始时间<input type="time" value={start} onChange={event => setStart(event.target.value)} /></label>
    <label>活动结束时间<input type="time" value={end} onChange={event => setEnd(event.target.value)} /></label>
    </fieldset>
    <div className="kw-actions"><Button type="submit" variant="primary" disabled={busy || generating}>保存角色</Button><Button type="button" onClick={onCancel}>取消</Button></div>
  </form>;
}

export function RoleSkillForm({ roleId, call, revision }: { roleId: string; call: Call; revision: number }) {
  const [repository, setRepository] = useState(''); const [path, setPath] = useState('.'); const [ref, setRef] = useState('');
  const [items, setItems] = useState<{ name: string; repository: string; path: string; commit: string }[]>([]);
  const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { let live = true; void call('skill.list', { roleId }).then(value => { if (live) setItems(value as typeof items); }).catch(() => {}); return () => { live = false; }; }, [roleId, revision]);
  return <section><h3>角色 Skill</h3><p>导入后，在“编辑角色”的预注入列表中填写 Skill 名称。正文按角色加载，参考资料按需读取。</p>
    {items.map(item => <article className="kw-entry" key={item.name}><strong>{item.name}</strong><p>{item.repository} · {item.path}</p><p>安装版本：{item.commit}</p></article>)}
    <form className="kw-form" onSubmit={event => { event.preventDefault(); setBusy(true); setNotice(''); void call('skill.install', { roleId, repository, path, ...ref ? { ref } : {} }).then(value => { const item = value as typeof items[number]; setItems(previous => [...previous.filter(old => old.name !== item.name), item]); setNotice(`已导入 ${item.name}，可将名称加入该角色的预注入列表。`); }).catch(() => {}).finally(() => setBusy(false)); }}>
      <label>GitHub Skill 仓库<input type="url" required value={repository} onChange={event => setRepository(event.target.value)} placeholder="https://github.com/Aboudjem/humanizer-skill" /></label>
      <label>Skill 子目录<input required value={path} onChange={event => setPath(event.target.value)} placeholder="例如 skills/humanizer；根目录填写 ." /></label>
      <label>分支或标签<input value={ref} onChange={event => setRef(event.target.value)} placeholder="留空使用仓库默认分支" /></label>
      <Button type="submit" disabled={busy}>{busy ? '正在导入…' : '导入角色 Skill'}</Button>
      {notice && <p role="status">{notice}</p>}
    </form>
  </section>;
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
  const [purpose, setPurpose] = useState(initial?.purpose ?? 'internal');
  const [relatedRecords, setRelatedRecords] = useState(initial?.relatedRecords.join('\n') ?? '');
  return <form className="kw-form" onSubmit={event => {
    event.preventDefault();
    const value: Record<string, unknown> = { action: initial ? 'update' : 'create', ...(initial ? { id: initial.id, expectedRevision: initial.revision } : {}), kind, title, instruction };
    value.context = scene ? { scene, peerId: Number(peerId) } : null; value.sources = sources.split(/\s+/).filter(Boolean);
    value.purpose = purpose; value.relatedRecords = relatedRecords.split(/\s+/).filter(Boolean);
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
    <label>安排目的<select value={purpose} onChange={event => setPurpose(event.target.value as typeof purpose)}><option value="internal">内部活动</option><option value="review">状态复核</option><option value="contact">考虑交流</option></select></label><label>关联连续性记录<textarea value={relatedRecords} onChange={event => setRelatedRecords(event.target.value)} placeholder="记录标识，每行一条。到期重新判断，不自动发送。" /></label>
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
