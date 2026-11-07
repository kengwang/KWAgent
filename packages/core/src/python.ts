import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const preparing = new Map<string, Promise<string>>();

/** 所有角色共用持久环境；并行准备角色时只执行一次 uv 初始化。 */
export function preparePython(dataRoot: string): Promise<string> {
  const root = resolve(dataRoot);
  const existing = preparing.get(root); if (existing) return existing;
  const task = prepare(root).finally(() => preparing.delete(root));
  preparing.set(root, task); return task;
}

async function prepare(dataRoot: string): Promise<string> {
  if (process.platform !== 'linux') throw new Error('持久 Python 运行环境需要 Linux 容器');
  const directory = join(dataRoot, 'python', '.venv');
  await mkdir(join(dataRoot, 'python'), { recursive: true });
  if (!existsSync(join(directory, 'pyvenv.cfg'))) await execute('uv', ['venv', '--allow-existing', '--system-site-packages', '--no-project', '--python', '/usr/bin/python3', directory], { cwd: dataRoot, timeout: 60000 });
  const python = join(directory, 'bin', 'python');
  await execute(python, ['-c', 'from playwright.sync_api import sync_playwright'], { cwd: dataRoot, timeout: 30000 });
  return python;
}
