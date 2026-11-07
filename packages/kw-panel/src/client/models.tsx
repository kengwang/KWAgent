import { useEffect, useRef, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { ModelPreset, ModelPresetWrite, PublicModelPreset } from '@kwagent/core';
import { PageNotice, usePages, type Call } from './views.tsx';

const kindLabels = { chat: '聊天', vision: '视觉', image: '生图与编辑' };
export function ModelPresetsView({ revision, call }: { revision: number; call: Call }) {
  const [kind, setKind] = useState('');
  const page = usePages<PublicModelPreset>('model.list', kind ? { kind } : {}, item => item.id, revision, call);
  const [editing, setEditing] = useState<PublicModelPreset | 'new' | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  return <section aria-label="模型预设">
    <div className="kw-section-head"><h3>模型预设</h3><Button onClick={() => { setEditing('new'); setNotice(''); }}>新建预设</Button></div>
    <p className="kw-prose">填写接口地址、API Key 和模型名称，保存后在角色中选择。聊天、视觉和生图可以使用各自的接口。</p>
    {notice && <p role="status">{notice}</p>}
    {editing && <ModelPresetForm key={editing === 'new' ? 'new' : editing.id} initial={editing === 'new' ? undefined : editing} current={editing === 'new' ? undefined : page.items.find(item => item.id === editing.id)} call={call} onCancel={() => setEditing(null)} onSaved={name => { setEditing(null); setNotice(`已保存“${name}”，角色可以选择这个预设。`); page.refresh(); }} />}
    <label className="kw-model-filter">筛选用途<select value={kind} onChange={event => setKind(event.target.value)}><option value="">全部预设</option>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <PageNotice page={page} />
    {!page.items.length && <p className="kw-empty">当前没有这类预设。新建后即可分配给角色。</p>}
    {page.items.map(preset => <article className="kw-entry" key={preset.id}>
      <div className="kw-entry-head"><h3>{preset.name}</h3><span>{kindLabels[preset.kind]}</span></div>
      <p>{preset.model}</p><p className="kw-model-address">{preset.baseUrl}</p>
      <p className="kw-muted">{preset.readonly ? '来自部署环境' : `修订 ${preset.revision}`} · API Key {preset.credentialConfigured ? '已配置' : '未配置'}</p>
      <div className="kw-actions"><Button size="sm" onClick={() => { setEditing(preset); setNotice(''); }}>{preset.readonly ? '查看配置' : '编辑预设'}</Button>{!preset.readonly && <Button size="sm" disabled={busy} onClick={() => setDeleting(preset.id)}>删除预设</Button>}</div>
      {deleting === preset.id && <div className="kw-error"><p>删除“{preset.name}”？已被角色使用的预设需要先解除选择。</p><div className="kw-actions"><Button disabled={busy} onClick={() => { setBusy(true); void call('model.delete', { id: preset.id, expectedRevision: preset.revision }).then(() => { setDeleting(null); setNotice('预设已删除。'); page.refresh(); }).catch(() => {}).finally(() => setBusy(false)); }}>确认删除</Button><Button disabled={busy} onClick={() => setDeleting(null)}>取消</Button></div></div>}
    </article>)}
    {page.nextCursor !== null && <Button onClick={page.more}>读取更多预设</Button>}
  </section>;
}

function ModelPresetForm({ initial, current, call, onCancel, onSaved }: { initial?: PublicModelPreset; current?: PublicModelPreset; call: Call; onCancel(): void; onSaved(name: string): void }) {
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { form.current?.scrollIntoView({ block: 'start' }); form.current?.focus({ preventScroll: true }); }, []);
  const [draft, setDraft] = useState(() => ({ id: initial?.id ?? `model-${crypto.randomUUID().slice(0, 8)}`, name: initial?.name ?? '', kind: initial?.kind ?? 'chat', baseUrl: initial?.baseUrl ?? '', model: initial?.model ?? '', protocol: initial?.protocol ?? 'openai-completions', thinkingFormat: initial?.thinkingFormat ?? 'auto', reasoningEffort: initial?.reasoningEffort ?? null, imageInput: initial?.imageInput ?? true, timeoutMs: initial?.timeoutMs ?? 300000, responseFormat: initial?.responseFormat ?? 'auto' } satisfies Omit<ModelPresetWrite, 'expectedRevision' | 'apiKey' | 'clearApiKey'>));
  const [expected, setExpected] = useState(initial?.revision ?? null);
  const [apiKey, setApiKey] = useState(''); const [clearKey, setClearKey] = useState(false); const [busy, setBusy] = useState(false);
  const [latest, setLatest] = useState<PublicModelPreset>(); const [saveError, setSaveError] = useState('');
  const set = <K extends keyof typeof draft>(key: K, value: typeof draft[K]) => setDraft(previous => ({ ...previous, [key]: value }));
  const readonly = initial?.readonly ?? false;
  const actual = latest && (!current || latest.revision > current.revision) ? latest : current;
  const conflict = actual && actual.revision !== expected;
  return <form ref={form} tabIndex={-1} className="kw-form kw-model-form" aria-label="模型预设配置" onSubmit={event => {
    event.preventDefault(); setBusy(true); setSaveError('');
    void call('model.save', { ...draft, expectedRevision: expected, ...apiKey ? { apiKey } : {}, clearApiKey: clearKey }).then(value => { setApiKey(''); onSaved((value as PublicModelPreset).name); }).catch(async error => { setSaveError(error instanceof Error ? error.message : String(error)); if (initial) await call('model.read', { id: initial.id }).then(value => setLatest(value as PublicModelPreset)).catch(() => {}); }).finally(() => setBusy(false));
  }}>
    <h3>{readonly ? '部署环境配置' : initial ? '编辑模型预设' : '新建模型预设'}</h3>
    <fieldset disabled={readonly || busy} className="kw-model-fields">
      <label>名称<input required value={draft.name} onChange={event => set('name', event.target.value)} /></label>
      <div className="kw-model-columns"><label>预设标识<input required disabled={Boolean(initial)} pattern="[a-z]([a-z0-9]|-){0,47}" value={draft.id} onChange={event => set('id', event.target.value)} /></label><label>用途<select disabled={Boolean(initial)} value={draft.kind} onChange={event => set('kind', event.target.value as ModelPreset['kind'])}>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
      <label>API 地址<input type="url" required value={draft.baseUrl} onChange={event => set('baseUrl', event.target.value)} placeholder="https://api.example.com/v1" /></label>
      <p className="kw-muted">填写接口根地址{draft.kind === 'image' ? '，系统追加 /images/generations 或 /images/edits' : ''}。</p>
      <label>模型名称<input required value={draft.model} onChange={event => set('model', event.target.value)} autoComplete="off" /></label>
      {!readonly && <><label>API Key<input type="password" autoComplete="new-password" value={apiKey} disabled={clearKey} onChange={event => setApiKey(event.target.value)} placeholder={initial?.credentialConfigured ? '已配置，留空保留现有 Key' : '填写接口的 API Key'} /></label>{initial?.credentialConfigured && <label className="kw-check"><input type="checkbox" checked={clearKey} onChange={event => setClearKey(event.target.checked)} />清除已保存的 API Key</label>}<p className="kw-muted">Key 保存到服务器的凭据存储，读取配置不会返回明文。</p></>}
      {draft.kind === 'chat' && <><label>接口协议<select value={draft.protocol} onChange={event => set('protocol', event.target.value as typeof draft.protocol)}><option value="openai-completions">OpenAI Chat Completions 兼容</option><option value="openai-responses">OpenAI Responses 兼容</option><option value="anthropic-messages">Anthropic Messages 兼容</option></select></label>
        <label>推理格式<select value={draft.thinkingFormat} onChange={event => set('thinkingFormat', event.target.value as typeof draft.thinkingFormat)}><option value="auto">自动</option><option value="openai">OpenAI</option><option value="deepseek">DeepSeek</option></select></label>
        <label>默认推理等级<select value={draft.reasoningEffort ?? ''} onChange={event => set('reasoningEffort', event.target.value ? event.target.value as NonNullable<typeof draft.reasoningEffort> : null)}><option value="">由接口决定</option>{['off', 'low', 'medium', 'high'].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label className="kw-check"><input type="checkbox" checked={draft.imageInput} onChange={event => set('imageInput', event.target.checked)} />模型支持图片输入</label></>}
      {draft.kind === 'image' && <label>图片返回格式<select value={draft.responseFormat} onChange={event => set('responseFormat', event.target.value as typeof draft.responseFormat)}><option value="auto">接口默认</option><option value="b64_json">Base64 图片</option><option value="url">图片 URL</option></select></label>}
      <label>请求超时（秒）<input type="number" min="1" max="3600" required value={draft.timeoutMs / 1000} onChange={event => set('timeoutMs', Number(event.target.value) * 1000)} /></label>
    </fieldset>
    {readonly && <p>此预设来自部署环境；需要其他配置时可以新建预设。</p>}
    {saveError && <p role="alert">{saveError}</p>}
    {conflict && <div role="alert" className="kw-error"><p>此预设已经更新，输入内容已保留。当前模型：{actual.model}；地址：{actual.baseUrl}。</p><Button onClick={() => setExpected(actual.revision)}>使用当前修订号继续编辑</Button></div>}
    <div className="kw-actions">{!readonly && <Button type="submit" variant="primary" disabled={busy || Boolean(conflict)}>{busy ? '正在保存…' : '保存预设'}</Button>}<Button disabled={busy} onClick={onCancel}>{readonly ? '关闭' : '取消'}</Button></div>
  </form>;
}

export function RoleModelPresets({ call, revision, values, onSelect }: { call: Call; revision: number; values: { chat: string; vision: string; image: string }; onSelect(kind: ModelPreset['kind'], id: string, preset?: PublicModelPreset): void }) {
  const page = usePages<PublicModelPreset>('model.list', {}, item => item.id, revision, call);
  const [selected, setSelected] = useState<PublicModelPreset[]>([]);
  const selection = JSON.stringify(values);
  useEffect(() => { let live = true; void Promise.all(Object.values(values).filter(Boolean).map(id => call('model.read', { id }))).then(items => { if (live) setSelected(items as PublicModelPreset[]); }).catch(() => {}); return () => { live = false; }; }, [selection, revision]);
  const all = [...new Map([...selected, ...page.items].map(item => [item.id, item])).values()];
  return <fieldset className="kw-model-fields"><legend>模型预设</legend><p>在“模型配置”页面统一管理接口；此处为角色选择各项用途。</p>
    {(['chat', 'vision', 'image'] as const).map(kind => <label key={kind}>{kindLabels[kind]}预设<select value={values[kind]} onChange={event => onSelect(kind, event.target.value, all.find(item => item.id === event.target.value))}>
      <option value="">{kind === 'chat' ? '保留当前模型配置' : kind === 'vision' ? '跟随聊天预设或部署默认' : '使用部署默认生图配置'}</option>
      {values[kind] && !all.some(item => item.id === values[kind]) && <option value={values[kind]}>{values[kind]}（尚未读取）</option>}
      {all.filter(item => item.kind === kind).map(item => <option key={item.id} value={item.id}>{item.name} · {item.model}{item.credentialConfigured ? '' : '（Key 未配置）'}</option>)}
    </select></label>)}
    {page.nextCursor !== null && <Button size="sm" onClick={page.more}>读取更多模型预设</Button>}
  </fieldset>;
}
