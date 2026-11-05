import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, ProxyAgent, request } from 'undici';
import ipaddr from 'ipaddr.js';
import { getProxyForUrl } from 'proxy-from-env';
import { CapabilityError } from './types.ts';

export function assertPublicAddress(address: string): void {
  if (!ipaddr.isValid(address) || ipaddr.process(address).range() !== 'unicast') throw new CapabilityError('访问本机、内网或保留地址需要角色管理员授权');
}

/** 每一跳校验DNS结果并固定连接IP，代理隧道同样使用已校验的IP。 */
export async function downloadResource(uri: string, options: { maxBytes: number; signal?: AbortSignal; allowPrivate?: boolean; timeoutMs?: number }) {
  const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 30000), ...options.signal ? [options.signal] : []]);
  let url = new URL(uri);
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal.throwIfAborted();
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new CapabilityError('资源地址需要无内嵌凭据的 HTTP 或 HTTPS URL');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = await lookup(host, { all: true }); signal.throwIfAborted();
    if (!addresses.length) throw new Error('资源域名没有可连接的地址');
    if (!options.allowPrivate) for (const item of addresses) assertPublicAddress(item.address);
    const selected = addresses.find(item => item.family === 4) ?? addresses[0]!;
    const proxy = getProxyForUrl(url.href);
    const target = new URL(url);
    const dispatcher = proxy ? new ProxyAgent({ uri: proxy, requestTls: isIP(host) ? {} : { servername: host } }) : new Agent({ connect: { autoSelectFamily: false, family: selected.family, lookup: (_hostname, _lookupOptions, callback) => callback(null, selected.address, selected.family) } });
    if (proxy) target.hostname = selected.family === 6 ? `[${selected.address}]` : selected.address;
    try {
      const response = await request(target, { dispatcher, method: 'GET', signal, headers: { host: url.host, 'accept-encoding': 'identity' } });
      try {
        if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
          if (redirects === 5) throw new Error('资源重定向次数超过允许范围');
          if (typeof response.headers.location !== 'string') throw new Error('资源重定向地址不明确');
          url = new URL(response.headers.location, url); continue;
        }
        if (Number(response.headers['content-length'] ?? 0) > options.maxBytes) throw new Error('资源超过配置的下载容量');
        const parts: Uint8Array[] = []; let size = 0;
        if (response.body) for await (const part of response.body) {
          signal.throwIfAborted(); size += part.byteLength;
          if (size > options.maxBytes) throw new Error('资源超过配置的下载容量');
          parts.push(part);
        }
        return { url: url.href, status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300, mime: response.headers['content-type'] ?? 'application/octet-stream', bytes: Buffer.concat(parts) };
      } finally {
        // 主动结束未读完的重定向或超限响应，保留此前的业务错误。
        response.body.on('error', () => {}); response.body.destroy();
      }
    } finally { await dispatcher.close(); }
  }
  throw new Error('资源下载没有取得结果');
}
