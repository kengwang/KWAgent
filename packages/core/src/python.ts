import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** 系统只读的浏览器依赖供各角色共享，角色自行安装的包保存在自己的 venv。 */
export async function prepareRolePython(workspace: string): Promise<string> {
  if (process.platform !== 'linux') throw new Error('持久 Python 运行环境需要 Linux 容器');
  await mkdir(workspace, { recursive: true });
  const directory = join(workspace, '.venv');
  await execute('uv', ['venv', '--allow-existing', '--system-site-packages', '--no-project', '--python', '/usr/bin/python3', directory], { cwd: workspace, timeout: 60000 });
  const python = join(directory, 'bin', 'python');
  await execute(python, ['-c', 'from playwright.sync_api import sync_playwright'], { cwd: workspace, timeout: 30000 });
  return python;
}
