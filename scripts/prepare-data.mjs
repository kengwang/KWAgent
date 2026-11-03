import { mkdir, readdir, lstat, chown, chmod } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { check } from 'proper-lockfile';
const root = resolve(process.env.KW_DATA_ROOT ?? '/data');
if (process.platform !== 'linux' || process.getuid() !== 0 || root !== '/data') throw new Error('此命令需要在容器中以 root 准备 /data');
const running = await check(join(root, 'kwagent')).catch(error => { if (error.code === 'ENOENT') return false; throw error; });
if (running) throw new Error('请停止应用后准备数据目录');
await mkdir(root, { recursive: true });
for (const name of ['dsh', 'kwagent', 'workspaces', 'media', 'artifacts', 'extensions', 'backups', 'cache', 'tmp', 'run']) await mkdir(join(root, name), { recursive: true });
async function own(path) {
  if (relative(root, path).startsWith('..')) throw new Error('数据路径越界');
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  await chown(path, 10001, 10001);
  await chmod(path, info.isDirectory() ? 0o700 : 0o600 | (info.mode & 0o111));
  if (info.isDirectory()) for (const item of await readdir(path)) await own(join(path, item));
}
await own(root);
console.log('持久数据目录已准备完成');
