import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic';
import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm';
import type {} from './index.ts';
import { appendPluginRecord } from '@deepseek-ai/dsh-session';

interface SummaryInput { readonly messages: readonly Message[]; readonly tools?: readonly ToolSchema[] }

/** 压缩保存数据库检查点；模型整理独立于前台会话执行。 */
export default class MindCompaction extends BasicCompactionEngine {
  static inject = [...BasicCompactionEngine.inject, 'kwMind'];
  constructor(ctx: Context, config: BasicCompactionConfig) { super(ctx, config); }
  protected override async summarize(input: SummaryInput, agent: Agent, signal?: AbortSignal) {
    const role = this.ctx.kwMind.store.roles().find(role => role.sessionId === agent.session.id);
    if (role) {
      signal?.throwIfAborted();
      const store = this.ctx.kwMind.store;
      const state = store.db.prepare('SELECT coalesce(max(seq),0) upper,sum(CASE WHEN consolidated=0 THEN 1 ELSE 0 END) pending FROM events WHERE role_id=?').get(role.id)!;
      appendPluginRecord(agent.session, 'plugin:kwagent/context', { kind: 'memory-checkpoint', roleId: role.id, throughReceiveSeq: Number(state.upper), pending: Number(state.pending ?? 0), status: 'raw-persisted', read: 'memory_read', consolidation: 'background' });
    }
    return super.summarize(input, agent, signal);
  }
}
