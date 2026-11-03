import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
if (existsSync('.env')) loadEnvFile('.env');
if (process.argv.slice(2).some(argument => argument !== '--candidate')) throw new Error('仅支持 --candidate 参数');
const git = (...args) => {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
if (git('status', '--porcelain', '--untracked-files=no')) throw new Error('发布需要所有受版本管理的修改已经提交');
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const commit = git('rev-parse', 'HEAD');
const tag = `v${version}`;
const existing = spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}^{}`], { encoding: 'utf8' });
if (existing.status === 0 && existing.stdout.trim() !== commit) throw new Error('该发布标签已经指向其他提交');
const ci = spawnSync(process.execPath, ['scripts/ci.mjs'], { stdio: 'inherit' });
if (ci.status !== 0) process.exit(ci.status ?? 1);
const image = spawnSync('docker', ['image', 'inspect', `kwagent:${version}`], { stdio: 'ignore' });
if (image.status === 0) throw new Error('该版本镜像已经存在，请使用新版本');
const archive = spawnSync('git', ['archive', '--format=tar', commit], { maxBuffer: 64 * 1024 * 1024 });
if (archive.status !== 0) throw new Error('无法读取发布提交');
const candidate = `kwagent:candidate-${commit}`;
const build = spawnSync('docker', ['build', '--platform', 'linux/amd64', '--build-arg', `KW_COMMIT=${commit}`, '--build-arg', `NODE_IMAGE=${process.env.KW_NODE_IMAGE ?? 'node:24.18.0-bookworm-slim'}`, '--build-arg', `HTTP_PROXY=${process.env.KW_BUILD_PROXY ?? ''}`, '--build-arg', `HTTPS_PROXY=${process.env.KW_BUILD_PROXY ?? ''}`, '-t', candidate, '-'], { input: archive.stdout, stdio: ['pipe', 'inherit', 'inherit'] });
if (build.status !== 0) process.exit(build.status ?? 1);
const verify = spawnSync(process.execPath, ['scripts/verify-docker.mjs', candidate], { stdio: 'inherit' });
if (verify.status !== 0) process.exit(verify.status ?? 1);
if (process.argv.includes('--candidate')) { console.log(`候选镜像验收通过：${candidate}`); process.exit(0); }
for (const target of [`kwagent:${version}`, `kwagent:sha-${commit}`]) {
  const result = spawnSync('docker', ['tag', candidate, target], { stdio: 'inherit' }); if (result.status !== 0) process.exit(result.status ?? 1);
}
if (existing.status !== 0) git('tag', '--no-sign', tag, commit);
console.log(`已构建 kwagent:${version}，提交 ${commit}`);
