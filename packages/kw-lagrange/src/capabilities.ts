import { asJson, now, type Json, type Store } from '@kwagent/core';
import { markdownUnsupported, messageSendTools, milkyToolSchema } from './client.ts';

/** Schema、接入策略与调用证据分别保存，失败不改变接入支持声明。 */
export class Capabilities {
  constructor(readonly store: Store, readonly accountId: string) {}
  description(name: string): string { return messageSendTools.has(name) ? markdownUnsupported : ''; }
  record(tool: string, state: string, evidence: Json): void { this.store.setMeta(`capability:${this.accountId}:${tool}`, JSON.stringify({ state, at: now(), evidence })); }
  read(name?: string, limit = 50, cursor = 0, detail = false): Json {
    const tools = milkyToolSchema.array().parse(JSON.parse(this.store.meta(`milky:${this.accountId}:tools`) ?? '[]'));
    const rows = tools.filter(tool => !name || tool.name === name).map(tool => ({
      name: tool.name, description: tool.description ?? '', remoteDeclared: true, adapterSupport: '已接入，实际可用性参照调用证据',
      policy: this.description(tool.name), readOnly: tool.annotations?.readOnlyHint === true,
      latest: JSON.parse(this.store.meta(`capability:${this.accountId}:${tool.name}`) ?? 'null') as Json,
      ...(detail ? { inputSchema: tool.inputSchema, outputSchema: tool.outputSchema ?? null } : {}),
    }));
    const policy = { name: 'message.markdown', remoteDeclared: tools.some(tool => messageSendTools.has(tool.name) && JSON.stringify(tool.inputSchema).includes('"markdown"')), adapterSupport: 'unsupported', policy: markdownUnsupported, latest: null };
    if (!name || name === policy.name) rows.push(policy as typeof rows[number]);
    return asJson({ items: rows.slice(cursor, cursor + limit), nextCursor: cursor + limit < rows.length ? cursor + limit : null, skill: 'lagrange', dependencies: ['Lagrange MCP', 'Milky /event'], policyVersion: 1 });
  }
}
