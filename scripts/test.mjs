import { globSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
if (process.versions.bun) throw new Error('测试需要 Node.js');
const files = [...globSync('tests/**/*.test.ts')];
if (!files.length) throw new Error('没有发现测试文件');
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', ...files], { stdio: 'inherit', env: { ...process.env, TMPDIR: `${process.cwd()}/.artifacts/tmp` } });
process.exitCode = result.status ?? 1;
