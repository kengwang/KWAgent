import { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@kwagent/kw-life';
import type {} from '@deepseek-ai/dsh-host-webserver';
import { asJson } from '@kwagent/core';

export interface PanelFrame { revision: number; payload: string }
declare module '@deepseek-ai/cordis' { interface Context { kwAgent: KwAgentRemote } }

/** 管理页面与服务器命令调用同一个 Operations Module。 */
export class KwAgentRemote extends TypertRemoteService {
  static inject = ['kwLife', 'webServer'];
  constructor(ctx: Context) {
    super(ctx, 'kwAgent');
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/kw-health', resource: async () => {
      const state = ctx.kwLife;
      const events = state.context.kwLagrange.events.status;
      return Response.json({ alive: true, managementReady: state.store.db.prepare('SELECT 1 AS ok').get()?.ok === 1, businessReady: state.started && !state.maintenance && !state.startupError && events.state === 'connected' && !events.error && Boolean(events.reconciledAt) && ![...state.runtime.values()].some(value => value.state === 'error') }, { status: 200 });
    } }), 'kw-panel.health');
  }
  @Remote
  async query(action: string, payload: string): Promise<string> { return JSON.stringify(await this.ctx.kwLife.operations.invoke(action, asJson(JSON.parse(payload)))); }
  @Remote
  async mutate(action: string, payload: string): Promise<string> { return JSON.stringify(await this.ctx.kwLife.operations.invoke(action, asJson(JSON.parse(payload)))); }
  @Remote({ mode: 'stream' })
  follow(roleId: string, signal: AbortSignal): AsyncIterable<PanelFrame> { return this.ctx.kwLife.operations.follow(roleId || undefined, signal); }
}

export default KwAgentRemote;
