import { Context, Service } from '@deepseek-ai/cordis';
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client';
import type {} from '@deepseek-ai/dsh-skill';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@kwagent/kw-mind';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { Ajv } from 'ajv';
import { createHash } from 'node:crypto';
import { asJson, jsonSchema, loadConfig, operationSchema, registerTool, errorText, now, milkyId } from '@kwagent/core';
import type { Experience } from '@kwagent/core';
import { MilkyClient, isAccountMutation, assertSupportedMessage, messageSendTools, markdownUnsupported } from './client.ts';
import { MilkyEvents } from './events.ts';
import { MediaModule } from './media.ts';

export { MilkyClient, responseData, MilkyBusinessError } from './client.ts';
export { milkyId, toolConversation } from '@kwagent/core';
export { MilkyEvents } from './events.ts';
export { MediaModule } from './media.ts';
export { normalizeExperience, conversationOrder, NORMALIZER_VERSION } from './perception.ts';
declare module '@deepseek-ai/cordis' { interface Context { kwLagrange: Lagrange } }

/** 账号共享连接，角色获得完整工具目录及各自的执行归属。 */
export class Lagrange extends Service {
  readonly client: MilkyClient;
  readonly events: MilkyEvents;
  readonly media: MediaModule;
  readonly received = new EventEmitter();
  private startup?: Promise<void>;
  private mediaQueue: Promise<void> = Promise.resolve();
  private readonly mediaAbort = new AbortController();
  private closeTask?: Promise<void>;
  private readonly ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
  constructor(ctx: Context) {
    super(ctx, 'kwLagrange');
    const config = loadConfig();
    this.client = new MilkyClient(config.milky, ctx.kwMind.store);
    this.client.payloads = ctx.kwMind.payloads; this.client.previewTokens = config.budgets.tool;
    this.events = new MilkyEvents(this.client, ctx.kwMind.store, event => {
      this.received.emit('event', event);
      this.mediaQueue = this.mediaQueue.then(() => this.media.receive(event, this.mediaAbort.signal));
      void this.mediaQueue.catch(error => { this.events.status.error = errorText(error); });
    });
    this.media = new MediaModule(ctx.kwMind.store, config, this.client);
  }
  start(): Promise<void> {
    this.startup ??= this.client.connect().then(() => {
      this.events.start();
      this.mediaQueue = this.mediaQueue.then(async () => {
        let after = 0;
        for (;;) {
          const rows = this.media.store.db.prepare("SELECT id,seq FROM events WHERE source='milky' AND type='message_receive' AND role_id IS NOT NULL AND seq>? ORDER BY seq LIMIT 100").all(after);
          if (!rows.length) return;
          for (const row of rows) { this.mediaAbort.signal.throwIfAborted(); await this.media.receive(this.media.store.event(String(row.id)), this.mediaAbort.signal); after = Number(row.seq); }
        }
      });
      void this.mediaQueue.catch(error => { this.events.status.error = errorText(error); });
    }).catch(error => { this.startup = undefined; throw error; });
    return this.startup;
  }
  async attach(ctx: Context, roleId: string): Promise<void> {
    await this.start();
    registerTool(ctx, 'capability_read', '只读能力目录：区分远端声明、接入支持和最近账号回执。不会发送探测消息。Markdown 固定不支持。', z.object({ name: z.string().optional(), limit: z.number().int().min(1).max(200).default(50), cursor: z.number().int().nonnegative().default(0), detail: z.boolean().default(false) }).strict(), async input => this.client.capabilities.read(input.name, input.limit, input.cursor, input.detail));
    registerTool(ctx, 'operation_read', '查阅自己的工具操作意图、回执与结果未知记录。核实可能已经完成的发送或上传前先读取记录。', z.object({ id: z.string().optional(), limit: z.number().int().min(1).max(100).default(20) }), async input => {
      if (!input.id) return this.media.store.operations(roleId, input.limit);
      const operation = this.media.store.get('operation', input.id, operationSchema);
      if (!operation || operation.roleId !== roleId) throw new Error('操作不存在或属于其他角色');
      return operation;
    });
    for (const tool of this.client.tools) {
      const validateInput = this.ajv.compile(tool.inputSchema);
      const validateOutput = tool.outputSchema ? this.ajv.compile(tool.outputSchema) : undefined;
      const definition = createMcpToolDefinition(ctx, {
        name: mcpToolName(tool.name), rawName: tool.name,
        description: `${tool.description ?? tool.name}\n${this.client.capabilities.description(tool.name)}`, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema,
        call: async (args, exec) => {
          assertSupportedMessage(tool.name, args);
          if (!validateInput(args)) { const message = `Milky 参数无效：${this.ajv.errorsText(validateInput.errors)}`; this.client.capabilities.record(tool.name, 'failed', { stage: 'input-schema', callId: exec.callId, roleId, message }); throw new Error(message); }
          if (['send_private_message', 'send_temp_message', 'upload_private_file'].includes(tool.name) && args.user_id !== undefined) {
            const userId = milkyId(args.user_id);
            const store = this.ctx.kwMind.store;
            const owner = store.route(this.client.accountId, 'private', userId);
            if (owner && owner !== roleId) {
              const event = store.appendEvent({ accountId: this.client.accountId, roleId: owner, source: 'handoff', type: 'private-conversation-handoff', occurredAt: now(), scene: 'private', peerId: userId, senderId: null, messageSeq: null, self: false, payload: asJson({ fromRoleId: roleId, tool: tool.name, arguments: args }) }).event;
              this.received.emit('event', event);
              throw new Error(`私聊事项已交给负责角色 ${store.role(owner).name}，交接记录 ${event.id}`);
            }
            if (!owner) {
              const role = store.role(roleId);
              store.updateRole(roleId, { contacts: [...role.contacts, userId] }, role.revision, roleId, '主动私聊建立联系人归属');
            }
          }
          const result = await this.client.execute(tool.name, args, roleId, exec.signal, { callId: exec.callId, rootCallId: exec.rootCallId, executionId: this.media.store.invocationId(exec.token) });
          if (isAccountMutation(tool.name)) for (const role of this.media.store.roles().filter(role => role.accountId === this.client.accountId)) {
            const event = this.media.store.appendEvent({ accountId: this.client.accountId, roleId: role.id, source: 'tool', type: 'account-profile-updated', occurredAt: now(), scene: null, peerId: null, senderId: null, messageSeq: null, self: false, payload: asJson({ actorRoleId: roleId, tool: tool.name, arguments: args, result }) }).event;
            this.received.emit('event', event);
          }
          if (validateOutput && result.structuredContent && !validateOutput(result.structuredContent)) { const message = `Milky 结果不符合公布的 Schema：${this.ajv.errorsText(validateOutput.errors)}`; this.client.capabilities.record(tool.name, 'failed', { stage: 'output-schema', remoteState: 'succeeded', callId: exec.callId, roleId, message }); throw new Error(message); }
          return result;
        },
      });
      ctx.tools.register(definition);
    }
    registerTool(ctx, 'media_prepare', '登记当前角色的媒体，并生成远程 Lagrange 可访问的发送 URI。resourceId 会查询新的资源地址。', z.object({ mediaId: z.string().optional(), uri: z.string().optional(), resourceId: z.string().optional(), name: z.string().optional(), eventId: z.string().optional(), mode: z.enum(['url', 'base64']).default('url') }), async (input, exec) => {
      const uri = input.resourceId ? await this.media.resourceUrl(input.resourceId, exec.signal) : input.uri;
      const media = input.mediaId ? this.media.store.media(input.mediaId) : uri ? await this.media.import(roleId, uri, input.name, input.eventId, exec.signal) : undefined;
      if (!media) throw new Error('需要提供 mediaId、resourceId 或 uri');
      return { media, ...await this.media.prepare(roleId, media.id, input.mode) };
    });
    registerTool(ctx, 'media_inspect', '理解图片、语音、视频或文档，读取结果会保存为带来源的经历。', z.object({ mediaId: z.string(), prompt: z.string().optional(), action: z.enum(['inspect', 'extract_audio']).default('inspect') }), (input, exec) => input.action === 'extract_audio' ? this.media.extractAudio(roleId, input.mediaId, exec.signal) : this.media.inspect(roleId, input.mediaId, input.prompt, exec.signal));
  }
  socialContext(roleId: string, contexts: { scene: 'group' | 'private'; peerId: number }[]) {
    return this.media.store.operations(roleId, 200).filter(operation => /^send_(group|private|temp)_message$/.test(operation.tool)).map(operation => ({ ...operation, context: this.ctx.kwMind.payloads.operationContext(operation) })).filter(operation => !contexts.length || operation.context && contexts.some(context => context.scene === operation.context!.scene && context.peerId === operation.context!.peerId)).slice(0, 12).map(operation => ({ id: operation.id, tool: operation.tool, state: operation.state, context: operation.context, startedAt: operation.startedAt, endedAt: operation.endedAt, read: 'operation_read', meaning: operation.state === 'unknown' ? '可能已经产生远程效果，需要核实，不能自动重放' : '真实操作回执，交流动机另外保存' }));
  }
  close(): Promise<void> { this.closeTask ??= this.stop(); return this.closeTask; }
  private async stop(): Promise<void> { await this.events.close(); this.mediaAbort.abort(); await this.mediaQueue.catch(error => { if (!this.mediaAbort.signal.aborted) throw error; }); await this.client.close(); this.received.removeAllListeners(); }
}

export const name = 'kw-lagrange';
export const inject = ['kwMind', 'tools', 'skills', 'webServer'];
export async function apply(ctx: Context): Promise<void> {
  const lagrange = new Lagrange(ctx);
  ctx.kwMind.beforeClose(() => lagrange.close());
  ctx.effect(() => () => lagrange.close(), 'kw-lagrange.connections');
  const skillPath = fileURLToPath(new URL('../skills/lagrange/SKILL.md', import.meta.url));
  const skill = await readFile(skillPath, 'utf8');
  ctx.skills.register({ name: 'lagrange', description: '通过 Lagrange MCP 在 QQ 中交流：消息组合、媒体、转发、表情、历史、资料和工具结果核实。', content: skill, source: 'runtime', path: skillPath, resourceBase: { kind: 'directory', path: fileURLToPath(new URL('../skills/lagrange/', import.meta.url)) } });
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/kw-media', resource: request => lagrange.media.serve(request) }), 'kw-lagrange.media-route');
}

export function mcpToolName(raw: string): string {
  const name = `mcp__lagrange__${raw}`;
  if (/^[A-Za-z0-9_-]{1,64}$/.test(name)) return name;
  return `${name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 51)}_${createHash('sha256').update(`lagrange\0${raw}`).digest('hex').slice(0, 12)}`;
}
