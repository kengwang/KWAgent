import { spawnSync } from 'node:child_process';
for (const args of [['scripts/build.mjs'], ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--noEmit'], ['scripts/test.mjs'], ['scripts/check-ignore.mjs'], ['scripts/check-secrets.mjs']]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
