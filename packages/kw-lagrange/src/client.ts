import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { asJson, errorText, jsonSchema, now, Store } from '@kwagent/core';
import type { AppConfig, Json, Operation } from '@kwagent/core';

const schemaObject = z.object({ type: z.literal('object') }).catchall(jsonSchema);
export const milkyToolSchema = z.object({
  name: z.string(), description: z.string().optional(), inputSchema: schemaObject,
  outputSchema: z.record(z.string(), jsonSchema).optional(),
  annotations: z.object({ readOnlyHint: z.boolean().optional(), destructiveHint: z.boolean().optional(), idempotentHint: z.boolean().optional() }).passthrough().optional(),
}).passthrough();
export type MilkyTool = z.infer<typeof milkyToolSchema>;
const toolList = z.object({ tools: z.array(milkyToolSchema), nextCursor: z.string().optional() });
const milkyResponse = z.object({ status: z.string(), retcode: z.number(), message: z.string().nullable().optional(), data: jsonSchema.optional() });

export class MilkyBusinessError extends Error {
  constructor(readonly response: Json) { super(`Milky 操作失败：${JSON.stringify(response)}`); }
}
export function responseData(result: { isError?: boolean; structuredContent?: Record<string, unknown>; content: unknown[] }): Json {
  if (result.isError) throw new MilkyBusinessError(asJson(result));
  let value: unknown = result.structuredContent;
  if (!value) {
    const text = result.content.find(item => typeof item === 'object' && item !== null && 'type' in item && item.type === 'text');
    if (!text || typeof text !== 'object' || !('text' in text) || typeof text.text !== 'string') throw new Error('Milky 缺少 JSON 结果');
    value = JSON.parse(text.text);
  }
  const response = milkyResponse.parse(value);
  if (response.status !== 'ok' || response.retcode !== 0) throw new MilkyBusinessError(asJson(response));
  return response.data ?? null;
}

/** 使用官方 MCP transport，保留远程合法的 boolean JSON Schema。 */
export class MilkyClient {
  readonly sdk = new Client({ name: 'kwagent', version: '0.1.0' }, { capabilities: {} });
  tools: MilkyTool[] = [];
  selfId = 0;
  status: { state: string; since: string; error: string | null } = { state: 'disconnected', since: now(), error: null };
  private transport?: StreamableHTTPClientTransport;
  private accountWrites: Promise<void> = Promise.resolve();
  private connecting?: Promise<void>;
  private readonly shutdown = new AbortController();
  constructor(readonly config: AppConfig['milky'], readonly store: Store, readonly accountId = 'main') {
    this.sdk.onclose = () => { this.status = { state: 'disconnected', since: now(), error: this.status.error }; };
    this.sdk.onerror = error => { this.status = { state: 'error', since: now(), error: errorText(error) }; };
  }

  connect(signal?: AbortSignal): Promise<void> {
    this.connecting ??= this.open(AbortSignal.any([this.shutdown.signal, ...signal ? [signal] : []])).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  async restore(signal?: AbortSignal): Promise<void> { if (this.status.state !== 'connected') await this.connect(signal); }
  private async open(signal: AbortSignal): Promise<void> {
    if (this.transport) await this.sdk.close();
    const headers: Record<string, string> = {};
    if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`;
    this.transport = new StreamableHTTPClientTransport(new URL('mcp', this.config.baseUrl.endsWith('/') ? this.config.baseUrl : `${this.config.baseUrl}/`), { requestInit: { headers } });
    await this.sdk.connect(this.transport, { signal, timeout: this.config.timeoutMs });
    const tools: MilkyTool[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const response = await this.sdk.request({ method: 'tools/list', params: cursor ? { cursor } : {} }, toolList, { signal, timeout: this.config.timeoutMs });
      tools.push(...response.tools);
      cursor = response.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('MCP 工具目录游标重复');
      if (cursor) seen.add(cursor);
    } while (cursor);
    if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error('MCP 工具名称重复');
    for (const required of ['get_login_info', 'send_group_message', 'get_group_list', 'probe_history_sync_state', 'get_history_sync_page']) {
      if (!tools.some(tool => tool.name === required)) throw new Error(`Milky 缺少所需工具：${required}`);
    }
    this.tools = tools;
    const login = z.object({ uin: z.number().int().positive().safe() }).passthrough().parse(await this.call('get_login_info', {}, signal));
    this.selfId = login.uin;
    this.status = { state: 'connected', since: now(), error: null };
    this.store.setMeta(`milky:${this.accountId}:tools`, JSON.stringify(tools));
    this.store.setMeta(`milky:${this.accountId}:self`, String(this.selfId));
  }

  async rawCall(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    try {
      const result = await this.sdk.callTool({ name, arguments: args }, undefined, { signal, timeout: this.config.timeoutMs });
      return z.object({ content: z.array(z.unknown()), isError: z.boolean().optional(), structuredContent: z.record(z.string(), z.unknown()).optional() }).passthrough().parse(result);
    } catch (error) {
      if (!signal?.aborted) this.status = { state: 'error', since: now(), error: errorText(error) };
      throw error;
    }
  }
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Json> {
    return responseData(await this.rawCall(name, args, signal));
  }
  async execute(name: string, args: Record<string, unknown>, roleId: string | null, signal?: AbortSignal) {
    const tool = this.tools.find(tool => tool.name === name);
    if (!tool) throw new Error(`Milky 工具不存在：${name}`);
    const write = tool.annotations?.readOnlyHint !== true;
    const operation = write ? this.store.startOperation(this.accountId, roleId, name, asJson(args)) : undefined;
    const run = async () => {
      let dispatched = false;
      try {
        signal?.throwIfAborted();
        dispatched = true;
        const result = await this.rawCall(name, args, signal);
        responseData(result);
        if (operation) this.store.finishOperation(operation.id, 'succeeded', asJson(result));
        return result;
      } catch (error) {
        if (operation) this.store.finishOperation(operation.id, error instanceof MilkyBusinessError || !dispatched ? 'failed' : 'unknown', { message: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    };
    const accountMutation = isAccountMutation(name);
    if (!accountMutation) return run();
    const previous = this.accountWrites;
    let release!: () => void;
    this.accountWrites = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await run(); } finally { release(); }
  }
  async close(): Promise<void> { this.shutdown.abort(); await this.sdk.close(); this.status = { state: 'disconnected', since: now(), error: null }; }
}

export function isAccountMutation(name: string): boolean { return /^(set_(nickname|avatar|bio|profile|online_status|diy_online_status|self_long_nick|qzone_profile))$/.test(name); }
