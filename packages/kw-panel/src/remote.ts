import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';
import type { RemoteResult, RemoteStreamHandle, TypertRemoteCodecSpec, TypertRemoteMethodSpec, TypertRemoteParameterSpec } from '@deepseek-ai/dsh-typert-protocol';

export interface PanelFrame { revision: number; payload: string }
const text: TypertRemoteCodecSpec = { mode: 'strict', typeSymbol: 'string', create: () => z.string() };
function parameter(name: string): TypertRemoteParameterSpec { return { name, source: 'json', codec: text, strictCodec: text }; }
function command(): TypertRemoteMethodSpec { return { service: 'kwAgent', invocation: { kind: 'direct' }, parameters: [parameter('action'), parameter('payload')], result: text }; }

/** 同一份严格 wire schema 供 Host 分派和 Client 调用使用。 */
export const remote = createTypertRemoteInfo({ package: '@kwagent/kw-panel', methods: {
  'kwAgent/query': command(), 'kwAgent/mutate': command(),
  'kwAgent/follow': { service: 'kwAgent', mode: 'stream', invocation: { kind: 'direct' }, parameters: [parameter('roleId')], cancellation: { parameter: 'signal' }, result: { mode: 'strict', typeSymbol: '@kwagent/kw-panel#PanelFrame', create: () => z.strictObject({ revision: z.number().int().nonnegative(), payload: z.string() }) } },
} }, z);

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    kwAgent: {
      query(action: string, payload: string): Promise<RemoteResult<string>>;
      mutate(action: string, payload: string): Promise<RemoteResult<string>>;
      follow(roleId: string, signal?: AbortSignal): RemoteStreamHandle<PanelFrame, never>;
    };
  }
}
export default remote;
