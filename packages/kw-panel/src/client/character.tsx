import { useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { CharacterDraft } from '@kwagent/core';

export function CharacterGenerator({ chatPresetId, reasoningEffort, call, onBusy, onDraft }: {
  chatPresetId: string; reasoningEffort: string; call(action: string, payload: unknown): Promise<unknown>;
  onBusy(value: boolean): void; onDraft(value: CharacterDraft & { generationId: string }): void;
}) {
  const [idea, setIdea] = useState('');
  const [generating, setGenerating] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  return <section className="kw-character-generator" aria-labelledby="kw-character-generation-title" aria-busy={generating}>
    <h4 id="kw-character-generation-title">一句话生成角色与世界</h4>
    <label>角色创意<textarea rows={3} value={idea} onChange={event => setIdea(event.target.value)} placeholder="例如：住在雨港旧书店的猫耳少女，喜欢修复古书，正在寻找失踪老师留下的地图。" /></label>
    <p className="kw-muted">使用上方聊天模型方案生成完整草稿，生成后可以逐项编辑，再保存角色。</p>
    <Button type="button" disabled={generating || !idea.trim() || !chatPresetId} onClick={() => {
      setGenerating(true); onBusy(true); setError(''); setNotice('');
      void call('role.generate', { idea, chatPresetId, reasoningEffort: reasoningEffort || null }).then(value => {
        onDraft(value as CharacterDraft & { generationId: string });
        setNotice('草稿已填入下方，包括角色设定、人格、表达示例和世界条目。可以继续编辑后保存。');
      }).catch(error => setError(error instanceof Error ? error.message : String(error))).finally(() => { setGenerating(false); onBusy(false); });
    }}>{generating ? '正在生成角色与世界…' : notice ? '重新生成草稿' : '生成角色与世界'}</Button>
    {!chatPresetId && <p className="kw-muted">请先选择聊天模型方案。</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="kw-error">生成失败：{error}。已有输入已保留。</p>}
  </section>;
}
