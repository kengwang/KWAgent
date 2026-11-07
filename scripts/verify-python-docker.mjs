import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const image = process.argv[2];
assert.ok(image, '需要提供验收镜像');
const volume = `kwagent-python-${Date.now()}`;
function docker(...args) {
  const result = spawnSync('docker', args, { stdio: 'inherit' });
  assert.equal(result.status, 0, `Docker 命令失败：${args[0]}`);
}
docker('volume', 'create', volume);
try {
  for (const mode of ['create', 'resume']) docker('run', '--rm', '--init', '--shm-size=1g', ...mode === 'resume' ? ['--network', 'none'] : [], '-v', `${volume}:/data`, '--entrypoint', 'node', image, 'scripts/verify-python-runtime.mjs', mode);
} finally { docker('volume', 'rm', volume); }
