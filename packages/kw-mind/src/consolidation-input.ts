import { tokens, type Experience, type Memory, type Role, type ContinuityRecord } from '@kwagent/core';
import { queryTerms } from './local-recall.ts';

export interface ConsolidationInput {
  role: Role; validationFeedback: string;
  sources: { id: string; part: number; total: number; payloadId: string; text: string; sourceMeaning: string }[];
  memories: Memory[]; continuity: ContinuityRecord[];
}

/** 工具调度和空内部输出没有新的经历内容，原始记录仍持续保存。 */
export function hasConsolidationContent(event: Experience): boolean {
  const body = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) ? event.payload : {};
  if (['initialize', 'resume-activity', 'background-result', 'scheduled-activity', 'condition-candidate', 'deferred-input'].includes(event.type)) return false;
  if (event.type === 'tool-result' && /^(continuity_|memory_|self_|life_plan|operation_read|capability_read|payload_read$|skill$|job_(list|output|kill)$|run_code$)/.test(String(body.name))) return false;
  if (event.type !== 'internal-activity') return true;
  const message = body.message && typeof body.message === 'object' && !Array.isArray(body.message) ? body.message : {};
  return Array.isArray(message.content) && message.content.some(block => block && typeof block === 'object' && !Array.isArray(block) && block.type === 'text' && typeof block.text === 'string' && block.text.trim());
}

const order = (first: { id: string; createdAt: string }, second: { id: string; createdAt: string }) => first.createdAt < second.createdAt ? -1 : first.createdAt > second.createdAt ? 1 : first.id < second.id ? -1 : first.id > second.id ? 1 : 0;

/** 既有认识置于稳定前缀，新来源与校验反馈置于末尾。 */
export function consolidationMessages(input: ConsolidationInput) {
  const { id, accountId, name, initialPersona, persona, selfState, worldMode, expressionExamples } = input.role;
  const memories = [...input.memories].sort(order).map(({ id, revision, kind, title, content, realm, epistemic, people }) => ({ id, revision, kind, title, content, realm, epistemic, people }));
  const continuity = [...input.continuity].sort(order).map(record => { const { sources: _sources, memories: _memories, plans: _plans, relatedRecords: _related, ...data } = record.data; return { id: record.id, revision: record.revision, data }; });
  const known = { role: { id, accountId, name, initialPersona, persona, selfState, worldMode, expressionExamples } };
  const incoming = { sources: input.sources };
  return [known, { memories, continuity }, incoming, ...input.validationFeedback ? [{ validationFeedback: input.validationFeedback }] : []].map(value => ({ role: 'user' as const, content: [{ type: 'text' as const, text: JSON.stringify(value) }] }));
}

/** 仅携带本批相关的旧认识，留出来源空间，不用无关条目填满预算。 */
export function relatedConsolidationRecords(input: ConsolidationInput, memories: Memory[], continuity: ContinuityRecord[]) {
  const text = input.sources.map(source => source.text).join('\n');
  const terms = queryTerms(text);
  const sources = new Set(input.sources.map(source => source.id));
  const rank = (title: string, content: string, people: string[], evidence: string[]) =>
    (evidence.some(id => sources.has(id)) ? 100 : 0) + people.filter(person => text.includes(person)).length * 20 + terms.filter(term => `${title}\n${content}`.toLowerCase().includes(term)).length;
  const selectedMemories = memories.map(memory => ({ value: memory, score: rank(memory.title, memory.content, memory.people, memory.sources) })).filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 12).map(item => item.value);
  const selectedContinuity = continuity.map(record => ({ value: record, score: rank(record.data.title, record.data.content, record.data.people, record.data.sources) })).filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 6).map(item => item.value);
  return { memories: selectedMemories, continuity: selectedContinuity };
}

export function consolidationInputTokens(input: ConsolidationInput): number {
  return consolidationMessages(input).reduce((sum, message) => sum + tokens(message.content[0]!.text) + 8, 0);
}

/** 修正只携带草稿实际引用的旧认识；真实来源与角色边界仍完整提供。 */
export function consolidationCorrectionInput(input: ConsolidationInput, draft: unknown): ConsolidationInput {
  const memories = new Set<string>(), continuity = new Set<string>();
  const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const value = object(draft);
  if (Array.isArray(value.memories)) for (const item of value.memories) { const record = object(item); if (typeof record.id === 'string') memories.add(record.id); }
  if (Array.isArray(value.continuity)) for (const item of value.continuity) {
    const record = object(item), data = object(record.data);
    if (typeof record.id === 'string') continuity.add(record.id);
    if (Array.isArray(data.memories)) for (const id of data.memories) if (typeof id === 'string') memories.add(id);
    if (Array.isArray(data.relatedRecords)) for (const id of data.relatedRecords) if (typeof id === 'string') continuity.add(id);
  }
  return { ...input, memories: input.memories.filter(record => memories.has(record.id)), continuity: input.continuity.filter(record => continuity.has(record.id)), validationFeedback: '' };
}
