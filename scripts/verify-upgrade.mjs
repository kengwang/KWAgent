import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const target = process.argv[2]; if (!target) throw new Error('需要提供待验证镜像');
const run = (args, input) => { const result = spawnSync('docker', args, { input, stdio: input ? ['pipe', 'inherit', 'inherit'] : 'inherit' }); assert.equal(result.status, 0, `docker ${args[0]} 失败`); };
for (const [version, schema] of [['0.1.0', 1], ['0.2.0', 2]]) {
  const base = `kwagent:${version}`;
  if (spawnSync('docker', ['image', 'inspect', base], { stdio: 'ignore' }).status !== 0) {
    const archive = spawnSync('git', ['archive', '--format=tar', `v${version}`], { maxBuffer: 64 * 1024 * 1024 }); assert.equal(archive.status, 0);
    run(['buildx', 'build', '--load', '--platform', 'linux/amd64', '--build-arg', `NODE_IMAGE=${process.env.KW_NODE_IMAGE ?? 'node:24.18.0-bookworm-slim'}`, '-t', base, '-'], archive.stdout);
  }
  const volume = `kwagent-upgrade-${schema}-${Date.now()}`; run(['volume', 'create', volume]);
  try {
    run(['run', '--rm', '--network', 'none', '-v', `${volume}:/data`, '--entrypoint', 'node', base, '--input-type=module', '-e', "import{Store,roleInputSchema}from'@kwagent/core';const s=new Store('/data/kwagent/state.sqlite');s.createRole(roleInputSchema.parse({id:'legacy-image',accountId:'main',name:'旧版本升级',initialPersona:'保存原有配置。',provider:'deepseek-official',model:'configured-model'}));s.close();"]);
    run(['run', '--rm', '--network', 'none', '-v', `${volume}:/data`, '-e', `KW_TEST_SCHEMA=${schema}`, '--entrypoint', 'node', target, 'scripts/verify-image.mjs']);
  } finally { run(['volume', 'rm', volume]); }
}
const report = { image: target, verifiedUpgradeSchemas: [1, 2], restored: true };
await mkdir('.artifacts/verification', { recursive: true }); await writeFile('.artifacts/verification/image-upgrade.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
