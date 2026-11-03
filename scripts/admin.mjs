import { existsSync, readFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { request } from 'node:http';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

if (existsSync('.env')) loadEnvFile('.env');
const root = resolve(process.env.KW_DATA_ROOT ?? './data');
const action = process.argv[2] ?? 'status';
if (action === 'restore') {
  const source = process.argv[3]; const destination = process.argv[4];
  if (!source || !destination) throw new Error('用法：node scripts/admin.mjs restore <备份目录> <独立恢复目录>');
  const { restoreBackup } = await import('@kwagent/kw-life');
  await restoreBackup(resolve(source), resolve(destination));
  console.log('备份校验与恢复完成');
} else {
  const socketPath = process.platform === 'win32' ? String.raw`\\.\pipe\kwagent-${createHash('sha256').update(root).digest('hex').slice(0, 16)}` : `${root}/run/admin.sock`;
  const argument = process.argv[3] ?? 'null';
  const payload = argument.startsWith('@') ? readFileSync(argument.slice(1), 'utf8') : argument;
  JSON.parse(payload);
  const result = await new Promise((resolve, reject) => {
    const req = request({ socketPath, path: `/${encodeURIComponent(action)}`, method: 'POST', headers: { 'Content-Type': 'application/json' } }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve(JSON.parse(text)));
    });
    req.on('error', reject); req.end(payload);
  });
  if (!result.ok) { console.error(result.error); process.exitCode = 1; }
  else console.log(JSON.stringify(result.result, null, 2));
}
