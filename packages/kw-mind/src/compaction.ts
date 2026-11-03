import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic';
import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm';
import type {} from './index.ts';

interface SummaryInput { readonly messages: readonly Message[]; readonly tools?: readonly ToolSchema[] }

/** 使用公开摘要扩展位置，在任何压缩路径提交角色的未整理经历。 */
export default class MindCompaction extends BasicCompactionEngine {
  static inject = [...BasicCompactionEngine.inject, 'kwMind'];
  constructor(ctx: Context, config: BasicCompactionConfig) { super(ctx, config); }
  protected override async summarize(input: SummaryInput, agent: Agent, signal?: AbortSignal) {
    const role = this.ctx.kwMind.store.roles().find(role => role.sessionId === agent.session.id);
    if (role) await this.ctx.kwMind.consolidate(agent, role.id, signal);
    return super.summarize(input, agent, signal);
  }
}
