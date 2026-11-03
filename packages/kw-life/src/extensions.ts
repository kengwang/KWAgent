import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, realpath, stat, symlink, unlink } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { satisfies } from 'semver';
import { asJson, errorText, extensionSchema, identifier, now } from '@kwagent/core';
import type { Extension, Store } from '@kwagent/core';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-hmr';
import type {} from '@deepseek-ai/dsh-app-boot';
import { readProfileManifest, writeProfileManifest } from '@deepseek-ai/dsh-app-boot';

export const extensionRequestSchema = z.object({ action: z.enum(['list', 'install', 'enable', 'disable']), id: identifier.optional(), spec: z.string().min(1).optional(), entry: z.string().default('lib/index.js') });
export type ExtensionRequest = z.infer<typeof extensionRequestSchema>;

/** Bun 安装与 Node 验证在真实角色目录执行，插件附着到角色 Context。 */
export class Extensions {
  private readonly running = new Map<string, () => Promise<void>>();
  private readonly installing = new Set<string>();
  private readonly runtimeCode = runtimeFingerprint();
  constructor(readonly store: Store, readonly dataRoot: string, readonly owner: Context) {}
  async manage(roleId: string, raw: ExtensionRequest, ctx?: Context, signal?: AbortSignal): Promise<Extension[] | Extension> {
    const request = extensionRequestSchema.parse(raw);
    if (request.action === 'list') return this.store.extensions(roleId);
    if (!request.id) throw new Error('扩展需要 id');
    const key = `${roleId}:${request.id}`;
    const previous = this.store.get('extension', key, extensionSchema);
    if (request.action === 'disable') {
      if (!previous) throw new Error('扩展不存在');
      const intent = this.save(key, { ...previous, enabled: false, revision: previous.revision + 1, updatedAt: now() }, previous.revision);
      try {
        await this.running.get(key)?.(); this.running.delete(key);
        const pending = await this.profile(intent, false);
        return this.save(key, { ...intent, state: pending ? 'pending-restart' : 'disabled', error: pending, revision: intent.revision + 1, updatedAt: now() }, intent.revision);
      } catch (error) { this.save(key, { ...intent, state: 'error', error: errorText(error), revision: intent.revision + 1, updatedAt: now() }, intent.revision); throw error; }
    }
    if (request.action === 'enable') {
      if (!previous || !ctx) throw new Error('扩展或角色运行环境不存在');
      const intent = this.save(key, { ...previous, enabled: true, revision: previous.revision + 1, updatedAt: now() }, previous.revision);
      try {
        const pending = await this.profile(intent, true);
        if (!intent.client && this.store.role(roleId).state === 'active') await this.mount(key, intent, ctx);
        return this.save(key, { ...intent, state: pending ? 'pending-restart' : 'enabled', error: pending, revision: intent.revision + 1, updatedAt: now() }, intent.revision);
      } catch (error) { this.save(key, { ...intent, state: 'error', error: errorText(error), revision: intent.revision + 1, updatedAt: now() }, intent.revision); throw error; }
    }
    if (!request.spec || this.installing.has(roleId)) throw new Error('需要安装 spec，且同一角色只能同时安装一个扩展');
    if (previous?.enabled) throw new Error('请停用扩展后安装新的版本');
    this.installing.add(roleId);
    const directory = join(this.dataRoot, 'extensions', roleId, request.id, String(Date.now()));
    const operation = this.store.startOperation(this.store.role(roleId).accountId, roleId, 'extension_install', asJson(request));
    try {
      await mkdir(directory, { recursive: true });
      const manifestPath = join(directory, 'package.json');
      const manifestExists = await stat(manifestPath).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; });
      if (!manifestExists) await writeFile(manifestPath, JSON.stringify({ name: `kw-extension-${roleId}-${request.id}`, private: true, type: 'module', dependencies: {} }, null, 2));
      await run('bun', ['add', '--exact', '--linker=hoisted', '--omit=peer', request.spec], directory, signal);
      const manifest = z.object({ dependencies: z.record(z.string(), z.string()) }).passthrough().parse(JSON.parse(await readFile(manifestPath, 'utf8')));
      const names = Object.keys(manifest.dependencies);
      if (names.length !== 1) throw new Error('扩展工程必须明确声明一个入口依赖');
      const packageName = names[0]!;
      const packageRoot = join(directory, 'node_modules', packageName);
      const pkg = z.object({ type: z.string().optional(), main: z.string().optional(), scripts: z.record(z.string(), z.string()).optional(), engines: z.object({ dsh: z.string().optional() }).optional(), dsh: z.object({ client: z.unknown().optional(), bundle: z.unknown().optional() }).optional() }).passthrough().parse(JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')));
      if (pkg.engines?.dsh && !satisfies('0.2.2-alpha.2', pkg.engines.dsh, { includePrerelease: true })) throw new Error('扩展不兼容当前 Harness 版本');
      const entry = resolve(packageRoot, pkg.main ?? request.entry);
      if (relative(packageRoot, entry).startsWith('..')) throw new Error('扩展入口超出包目录');
      if (pkg.dsh?.client && !pkg.dsh.bundle) throw new Error('浏览器扩展需要声明 dsh.bundle，并由 bundle 挂载包的根入口');
      if (!(await stat(entry).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; })) && pkg.scripts?.build) await run(process.execPath, ['--run', 'build'], packageRoot, signal);
      await run(process.execPath, ['--check', entry], directory, signal);
      const extension: Extension = { id: request.id, roleId, packageName, spec: request.spec, directory, entry, client: Boolean(pkg.dsh?.client), enabled: false, state: 'installed', revision: (previous?.revision ?? 0) + 1, error: null, updatedAt: now() };
      this.save(key, extension, previous?.revision ?? null);
      this.store.finishOperation(operation.id, 'succeeded', asJson(extension));
      return extension;
    } catch (error) {
      this.store.finishOperation(operation.id, 'failed', { message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally { this.installing.delete(roleId); }
  }
  private save(key: string, value: Extension, expected: number | null): Extension { this.store.put('extension', key, value.roleId, asJson(value), expected, value.roleId, '管理角色扩展'); return value; }
  private async profile(value: Extension, enabled: boolean): Promise<string | null> {
    const profile = this.owner.profileContext;
    if (!profile) throw new Error('扩展安装需要 Harness profile');
    const target = await realpath(join(value.directory, 'node_modules', value.packageName));
    const link = join(profile.dir, 'node_modules', value.packageName);
    return this.owner.hmr.runExclusive(async () => {
      const manifest = readProfileManifest('kwagent', profile.dir);
      const dependencies = { ...manifest.dependencies };
      const bundles = [...manifest.dsh?.profile?.bundles ?? []];
      if (enabled) {
        let linked = await realpath(link).then(path => path, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
        if (linked && linked !== target) {
          let stale = false;
          for (const record of this.store.extensions().filter(record => !record.enabled && record.packageName === value.packageName)) if (await realpath(join(record.directory, 'node_modules', record.packageName)) === linked) stale = true;
          if (!stale) throw new Error('该包名称已经被其他安装占用，请使用独立的扩展包名称');
          await unlink(link); linked = undefined;
        }
        if (!linked) { await mkdir(resolve(link, '..'), { recursive: true }); await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
        dependencies[value.packageName] = `link:${target.replaceAll('\\', '/')}`;
        if (value.client && !bundles.includes(value.packageName)) bundles.push(value.packageName);
      } else {
        if (dependencies[value.packageName] !== `link:${target.replaceAll('\\', '/')}`) return null;
        delete dependencies[value.packageName];
        const index = bundles.indexOf(value.packageName); if (index >= 0) bundles.splice(index, 1);
      }
      writeProfileManifest(profile.dir, { ...manifest, dependencies, dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } } });
      await this.owner.pluginPackages.refresh();
      if (!value.client) { if (!enabled) await unlink(link); return null; }
      if (runtimeFingerprint() !== this.runtimeCode) return '需要重启：KWAgent 运行文件已经更新，重启后加载已保存的浏览器扩展配置';
      const result = await this.owner.hmr.reconcileProfile();
      if (!enabled) await unlink(link);
      if (result.warnings.length) throw new Error(`扩展激活失败：${result.warnings.join('\n')}`);
      return result.restartReason || result.pending.length ? `需要重启：${result.restartReason ?? result.pending.map(item => item.url).join(', ')}` : null;
    });
  }
  private async mount(key: string, value: Extension, ctx: Context): Promise<void> {
    if (this.running.has(key)) return;
    const module = await import(pathToFileURL(await realpath(value.entry)).href);
    const fiber = await ctx.plugin(module.default ?? module);
    this.running.set(key, () => fiber.dispose());
  }
  async restore(roleId: string, ctx: Context): Promise<void> { for (const extension of this.store.extensions(roleId)) if (extension.enabled && !extension.client) await this.mount(`${roleId}:${extension.id}`, extension, ctx); }
  recoverProfile(): void {
    const started = this.owner.profileContext.startedBundles;
    for (const extension of this.store.extensions()) if (extension.client && extension.state === 'pending-restart' && extension.enabled === started.includes(extension.packageName)) {
      this.save(`${extension.roleId}:${extension.id}`, { ...extension, state: extension.enabled ? 'enabled' : 'disabled', error: null, revision: extension.revision + 1, updatedAt: now() }, extension.revision);
    }
  }
  async suspend(roleId: string): Promise<void> { for (const [key, release] of this.running) if (key.startsWith(`${roleId}:`)) { await release(); this.running.delete(key); } }
  async close(): Promise<void> { for (const release of this.running.values()) await release(); this.running.clear(); }
}

function runtimeFingerprint(): string {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const hash = createHash('sha256');
  for (const name of readdirSync(root).sort()) {
    const directory = join(root, name, 'lib');
    if (!existsSync(directory)) continue;
    for (const file of readdirSync(directory).filter(file => file.endsWith('.js')).sort()) hash.update(`${name}/${file}\n`).update(readFileSync(join(directory, file)));
  }
  return hash.digest('hex');
}

export function run(command: string, args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, signal, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + String(chunk)).slice(-32768); });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(`${command} 执行失败（${code}）：${output}`)));
  });
}
