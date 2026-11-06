import { createDeveloperMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { ContextFormed } from '@deepseek-ai/dsh-llm/message';
import type { Session } from '@deepseek-ai/dsh-session';
import { joinContextSections } from '@deepseek-ai/dsh-system-prompt';
import type {} from '@deepseek-ai/dsh-agent-loop';

declare module '@deepseek-ai/dsh-llm/message' {
  interface MessageSourceMap { 'runtime-context': { kind: 'runtime-context' } & ContextFormed }
}

/** 旧步骤背景退出模型输入；原始事件与完整快照继续保留在 Session。 */
export function retireStepContexts(session: Session, turn: number, step: number): void {
  for (const seq of [...session.surface.nodes]) {
    const event = session.eventAt(seq);
    if (event?.type !== 'user/message') continue;
    const source = event.data.source;
    if (source.kind !== 'runtime-context' || source.form !== 'snapshot' || !source.sections.some(section => section.name === 'kw-life-state')) continue;
    const sections = source.sections.filter(section => section.name !== 'kw-life-state');
    const intent = { surfaceOp: { op: 'replace' as const, startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] };
    if (sections.length) {
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: joinContextSections(sections) }], source: { ...source, sections } }), intent);
    } else {
      // 空 developer 节点是宿主公开支持的无模型内容替换，不产生工具变更。
      session.append('developer/message', { turn, step, message: createDeveloperMessage({ content: [], source: { ...source, sections } }) }, intent);
    }
  }
}
