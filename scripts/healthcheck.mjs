import { networkInterfaces } from 'node:os';
const host = process.env.KW_BIND_IP ?? (process.env.KW_CONTAINER === 'true' ? Object.values(networkInterfaces()).flat().find(address => address?.family === 'IPv4' && !address.internal)?.address : '127.0.0.1');
if (!host) throw new Error('无法确定监听地址');
const response = await fetch(`http://${host}:3080/kw-health`, { signal: AbortSignal.timeout(4000) });
if (!response.ok || !(await response.json()).managementReady) process.exitCode = 1;
