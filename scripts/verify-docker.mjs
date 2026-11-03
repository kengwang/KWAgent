import { spawnSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { strict as assert } from 'node:assert';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { request } from 'node:http';

loadEnvFile('.env');
const image = process.argv[2] ?? 'kwagent:verification';
const name = `kwagent-test-${Date.now()}`;
const volume = `${name}-data`;
function docker(...args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
function admin(action, payload = null) { return JSON.parse(docker('exec', name, 'node', 'scripts/admin.mjs', action, JSON.stringify(payload))); }
async function ready() {
  const end = Date.now() + 90000;
  while (Date.now() < end) {
    const response = await fetch('http://127.0.0.1:3082/kw-health', { headers: { Host: 'kwagent.local.test' } }).catch(error => { if (!['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET'].includes(error.cause?.code)) throw error; });
    if (response?.ok && (await response.json()).businessReady) return;
    await delay(1000);
  }
  throw new Error('容器业务就绪超时');
}
docker('volume', 'create', volume);
docker('run', '-d', '--name', name, '--init', '--env-file', '.env', '-e', 'KW_DATA_ROOT=/data', '-e', 'DSH_HOME=/data/dsh', '-e', 'KW_CONTAINER=true', '-e', 'KW_PUBLIC_URL=https://kwagent.local.test', '-e', 'HTTP_PROXY=', '-e', 'HTTPS_PROXY=', '-p', '127.0.0.1:3082:3080', '-v', `${volume}:/data`, image);
try {
  await ready();
  assert.equal(docker('exec', name, 'id', '-u'), '10001');
  assert.equal(admin('doctor').database, 'ok');
  const duplicate = spawnSync('docker', ['exec', name, 'node', 'scripts/start.mjs'], { encoding: 'utf8', timeout: 10000 });
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /ELOCKED/);
  assert.match(duplicate.stderr, /\/data\/run/);
  const role = admin('role.create', { id: 'docker-persistence', accountId: 'main', name: '容器持久化验收', initialPersona: '记录本地验收经历。', provider: process.env.KW_LLM_PROVIDER, model: process.env.KW_LLM_MODEL });
  const event = admin('event', { roleId: role.id, text: '容器重启前保存的观察。' });
  admin('quiesce');
  const backup = admin('backup');
  docker('restart', '-t', '30', name);
  await ready();
  let state = admin('status', { roleId: role.id });
  assert.equal(state.roles.find(item => item.id === role.id).state, 'disabled');
  assert.ok(state.events.some(item => item.id === event.id));
  docker('exec', name, 'node', 'scripts/admin.mjs', 'restore', backup.directory, '/data/tmp/restored');
  const restored = docker('exec', name, 'node', '--input-type=module', '-e', "import {Store} from '@kwagent/core';const db=new Store('/data/tmp/restored/kwagent/state.sqlite');if(db.role('docker-persistence').state!=='disabled'||db.integrity()!=='ok')throw new Error('恢复验证失败');db.close();console.log('ok');");
  assert.equal(restored, 'ok');
  const invalidHost = await new Promise((resolve, reject) => {
    const req = request('http://127.0.0.1:3082/api', { headers: { Host: 'untrusted.invalid' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.equal(invalidHost, 403);
  const result = { image, nonRoot: true, database: 'ok', singleInstance: true, reconnect: true, persistentEvent: event.id, backupFiles: backup.files, restored: true, hostValidation: true };
  await mkdir('.artifacts/verification', { recursive: true });
  await writeFile('.artifacts/verification/docker.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { docker('stop', '-t', '30', name); docker('rm', name); }
