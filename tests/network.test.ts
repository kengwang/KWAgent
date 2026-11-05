import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { connect, type Socket } from 'node:net';
import { assertPublicAddress, downloadResource } from '../packages/core/src/network.ts';

test('公网地址检查拒绝本机、内网、保留及IPv4映射地址', () => {
  for (const address of ['127.0.0.1', '0.0.0.0', '10.0.0.1', '172.16.0.1', '192.168.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1']) assert.throws(() => assertPublicAddress(address));
  assert.doesNotThrow(() => assertPublicAddress('8.8.8.8'));
});

test('真实代理固定目标IP，同时保留资源原始Host', async () => {
  const names = ['http_proxy', 'HTTP_PROXY', 'no_proxy', 'NO_PROXY'];
  const environment = names.map(name => [name, process.env[name]] as const);
  const connections = new Set<Socket>();
  let expectedHost = '';
  const targets: string[] = [];
  const origin = createServer((request, response) => {
    response.statusCode = request.headers.host === expectedHost ? 200 : 421;
    response.end(request.headers.host);
  });
  const track = (socket: Socket) => { connections.add(socket); socket.once('close', () => connections.delete(socket)); };
  const proxy = createServer((incoming, response) => {
    const target = new URL(incoming.url!); targets.push(target.host);
    const outgoing = request(target, { method: incoming.method, headers: incoming.headers }, result => {
      response.writeHead(result.statusCode!, result.headers);
      result.pipe(response);
    });
    outgoing.on('socket', track);
    outgoing.on('error', () => response.destroy());
    incoming.pipe(outgoing);
  });
  proxy.on('connection', track);
  proxy.on('connect', (request, client, head) => {
    targets.push(request.url!);
    const port = Number(new URL(`http://${request.url}`).port);
    const upstream = connect(port, '127.0.0.1');
    track(upstream);
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  origin.listen(0, '127.0.0.1'); proxy.listen(0, '127.0.0.1');
  await Promise.all([once(origin, 'listening'), once(proxy, 'listening')]);
  const address = origin.address(), proxyAddress = proxy.address();
  assert.ok(address && typeof address === 'object' && proxyAddress && typeof proxyAddress === 'object');
  expectedHost = `localhost:${address.port}`;
  process.env.http_proxy = process.env.HTTP_PROXY = `http://127.0.0.1:${proxyAddress.port}`;
  process.env.no_proxy = process.env.NO_PROXY = '';
  try {
    const resource = await downloadResource(`http://${expectedHost}/resource`, { maxBytes: 1024, allowPrivate: true, signal: AbortSignal.timeout(5000) });
    assert.equal(resource.status, 200);
    assert.equal(resource.bytes.toString('utf8'), expectedHost);
    assert.deepEqual(targets, [`127.0.0.1:${address.port}`]);
  } finally {
    for (const [name, value] of environment) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    origin.closeAllConnections(); for (const socket of connections) socket.destroy();
    await Promise.all([origin, proxy].map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  }
});

test('真实HTTP资源在普通请求中拒绝内网，授权下载保持内容与容量校验', async () => {
  const previous = process.env.NO_PROXY;
  process.env.NO_PROXY = '*';
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.end('授权读取的真实本地资源');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const uri = `http://localhost:${address.port}/resource`;
  try {
    await assert.rejects(downloadResource(uri, { maxBytes: 1024, signal: AbortSignal.timeout(5000) }), /管理员/);
    assert.equal(requests, 0);
    const resource = await downloadResource(uri, { maxBytes: 1024, allowPrivate: true, signal: AbortSignal.timeout(5000) });
    assert.equal(resource.ok, true);
    assert.equal(resource.bytes.toString('utf8'), '授权读取的真实本地资源');
    await assert.rejects(downloadResource(uri, { maxBytes: 1, allowPrivate: true, signal: AbortSignal.timeout(5000) }), /容量/);
  } finally {
    if (previous === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = previous;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
