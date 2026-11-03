import { existsSync, readFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { spawnSync } from 'node:child_process';
if (!existsSync('.env')) throw new Error('请先创建 .env');
loadEnvFile('.env');
const run = (command, args, capture = false) => {
  const result = spawnSync(command, args, capture ? { encoding: 'utf8' } : { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} 执行失败`);
  return capture ? result.stdout.trim() : '';
};
if (run('git', ['status', '--porcelain', '--untracked-files=no'], true)) throw new Error('部署需要所有受版本管理的修改已经提交');
const image = process.env.KW_IMAGE ?? 'kwagent:0.2.0';
const inspect = JSON.parse(run('docker', ['image', 'inspect', image], true))[0];
const commit = run('git', ['rev-parse', 'HEAD'], true);
if (inspect.Config.Labels['org.opencontainers.image.revision'] !== commit) throw new Error('镜像与当前提交不一致');
const compose = ['compose', '--env-file', '.env'];
run('docker', [...compose, 'config', '--quiet']);
const running = run('docker', [...compose, 'ps', '--status', 'running', '-q'], true);
if (running) {
  run('docker', [...compose, 'exec', '-T', 'kwagent', 'node', 'scripts/admin.mjs', 'backup']);
  run('docker', [...compose, 'exec', '-T', 'kwagent', 'node', 'scripts/admin.mjs', 'quiesce']);
  run('docker', [...compose, 'stop']);
}
run('docker', [...compose, 'run', '--rm', '--no-deps', '--user', '0', 'kwagent', 'node', 'scripts/prepare-data.mjs']);
run('docker', [...compose, 'up', '-d', '--no-build', '--wait', '--wait-timeout', '180']);
run('docker', [...compose, 'exec', '-T', 'kwagent', 'node', 'scripts/admin.mjs', 'doctor']);
run('docker', [...compose, 'exec', '-T', 'kwagent', 'node', 'scripts/admin.mjs', 'deployment.record', JSON.stringify({ commit, image, imageId: inspect.Id, deployedAt: new Date().toISOString() })]);
console.log(`部署完成：${image}，提交 ${commit}`);
