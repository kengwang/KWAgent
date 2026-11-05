import { randomUUID } from 'node:crypto';
import { cp, mkdir, lstat, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, join, relative, resolve, isAbsolute } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { createScope } from '@deepseek-ai/dsh-scope';
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem';
import { z } from 'zod';
import { asJson, errorText, now, type Store } from '@kwagent/core';
import { run } from './extensions.ts';

export const skillInstallSchema = z.object({ repository: z.url().refine(value => /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(value), '请填写 GitHub 仓库的 HTTPS 根地址'), path: z.string().default('.'), ref: z.string().min(1).optional() }).strict();

/** 仅复制 Skill 资料；Harness 原生 provider 负责解析、加载和监听。 */
export class RoleSkills {
  private readonly importing = new Map<string, Promise<unknown>>();
  constructor(readonly ctx: Context, readonly store: Store, readonly dataRoot: string) {}
  directory(roleId: string): string { return join(this.dataRoot, 'workspaces', roleId, '.agents', 'skills'); }
  async attach(ctx: Context, roleId: string): Promise<void> {
    await ctx.plugin({ name: `kw-role-skills-${roleId}`, inject: ['skills'], apply: (child: Context) => this.mount(child, `kw-role-skills-${roleId}`, this.directory(roleId), true) });
  }
  private mount(ctx: Context, name: string, directory: string, watch: boolean): void {
    let provider!: FileSystemSkillProvider;
    ctx.skills.registerProvider(control => provider = new FileSystemSkillProvider(ctx, control, { providerName: name, includeDefaultRoots: false, customSkillDirs: [directory], watch }));
    ctx.effect(() => () => provider.dispose(), `kw-role-skills:${name}`);
  }
  list(roleId: string) { return this.store.list('role-skill', z.object({ name: z.string(), repository: z.string(), commit: z.string(), path: z.string(), directory: z.string(), installedAt: z.string() }), roleId, 200); }
  async drain(roleId: string): Promise<void> { await this.importing.get(roleId)?.catch(() => undefined); }
  async install(roleId: string, input: z.input<typeof skillInstallSchema>) {
    const role = this.store.role(roleId);
    if (this.store.meta(`lifecycle:${roleId}`) || this.importing.has(roleId)) throw new Error('角色正在管理会话或导入 Skill，请等待当前操作完成');
    const request = skillInstallSchema.parse(input);
    const task = this.import(roleId, role.accountId, request); this.importing.set(roleId, task);
    try { return await task; } finally { this.importing.delete(roleId); }
  }
  private async import(roleId: string, accountId: string, request: z.infer<typeof skillInstallSchema>) {
    const operation = this.store.startOperation(accountId, roleId, 'role_skill_install', asJson(request));
    const temporary = resolve(this.dataRoot, 'tmp', `skill-${randomUUID()}`);
    const repository = join(temporary, 'repository'), stage = join(temporary, 'staged');
    try {
      await mkdir(temporary, { recursive: true });
      const signal = AbortSignal.timeout(120000);
      await run('git', ['clone', '--depth=1', '--no-tags', ...request.ref ? ['--branch', request.ref] : [], '--', request.repository, repository], temporary, signal);
      const source = await realpath(resolve(repository, request.path));
      const fromRepository = relative(await realpath(repository), source);
      if (isAbsolute(fromRepository) || fromRepository === '..' || fromRepository.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('Skill 子目录超出仓库范围');
      await stat(join(source, 'SKILL.md')); await mkdir(stage);
      const staged = join(stage, 'candidate');
      await cp(source, staged, { recursive: true, filter: async path => { if (basename(path) === '.git') return false; if ((await lstat(path)).isSymbolicLink()) throw new Error('导入的 Skill 目录不能包含符号链接'); return true; } });
      const scopeKey = {}; const scope = createScope(this.ctx, scopeKey);
      const providerName = `kw-import-${randomUUID()}`;
      let name: string;
      try {
        this.mount(scope.ctx, providerName, stage, false);
        const skills = (await scope.ctx.skills.list({ scope: scopeKey })).filter(item => item.provider === providerName);
        if (skills.length !== 1) throw new Error('指定目录需要包含一个可读取、声明名称的 SKILL.md');
        const skill = await scope.ctx.skills.get(skills[0]!.name, { scope: scopeKey });
        if (!skill || !skill.content.trim()) throw new Error('Skill 正文为空或不可读取');
        name = skill.name;
      } finally { await scope.dispose(); }
      const directory = join(this.directory(roleId), name);
      const exists = await stat(directory).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; });
      if (exists) throw new Error(`该角色已经有 ${name} Skill，请保留当前目录并使用不同名称的 Skill`);
      const commit = (await run('git', ['rev-parse', 'HEAD'], repository, signal)).trim();
      await readFile(join(staged, 'SKILL.md'), { signal });
      await mkdir(this.directory(roleId), { recursive: true }); await rename(staged, directory);
      const record = { name, repository: request.repository, path: request.path, commit, directory, installedAt: now() };
      this.store.transaction(() => { this.store.put('role-skill', `${roleId}:${name}`, roleId, asJson(record), null, 'owner', '导入角色 Skill'); this.store.finishOperation(operation.id, 'succeeded', asJson(record)); });
      return record;
    } catch (error) { this.store.finishOperation(operation.id, 'unknown', { message: errorText(error), instruction: '未确认导入完成；读取角色 Skill 目录和操作记录后再决定重试。' }); throw error; }
    finally { await rm(temporary, { recursive: true, force: true }); }
  }
}
