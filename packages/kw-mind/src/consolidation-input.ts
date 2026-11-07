import type { Experience, Memory, Role, ContinuityRecord } from '@kwagent/core';

export interface ConsolidationInput {
  role: Role; validationFeedback: string;
  sources: { id: string; part: number; total: number; payloadId: string; text: string; sourceMeaning: string }[];
  memories: Memory[]; continuity: ContinuityRecord[];
}

/** 工具调度和空内部输出没有新的经历内容，原始记录仍持续保存。 */
export function hasConsolidationContent(event: Experience): boolean {
  const body = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) ? event.payload : {};
  if (event.type === 'tool-result' && /^(continuity_|memory_|self_|life_plan|operation_read|capability_read|payload_read$|job_(list|output|kill)$|run_code$)/.test(String(body.name))) return false;
  if (event.type !== 'internal-activity') return true;
  const message = body.message && typeof body.message === 'object' && !Array.isArray(body.message) ? body.message : {};
  return Array.isArray(message.content) && message.content.some(block => block && typeof block === 'object' && !Array.isArray(block) && block.type === 'text' && typeof block.text === 'string' && block.text.trim());
}

const order = (first: { id: string; createdAt: string }, second: { id: string; createdAt: string }) => first.createdAt < second.createdAt ? -1 : first.createdAt > second.createdAt ? 1 : first.id < second.id ? -1 : first.id > second.id ? 1 : 0;

/** 既有认识置于稳定前缀，新来源与校验反馈置于末尾。 */
export function consolidationMessages(input: ConsolidationInput) {
  const { id, accountId, name, initialPersona, persona, selfState, worldMode, expressionExamples } = input.role;
  const known = { memories: [...input.memories].sort(order), continuity: [...input.continuity].sort(order), role: { id, accountId, name, initialPersona, persona, selfState, worldMode, expressionExamples } };
  const incoming = { sources: input.sources, validationFeedback: input.validationFeedback };
  return [known, incoming].map(value => ({ role: 'user' as const, content: [{ type: 'text' as const, text: JSON.stringify(value) }] }));
}
