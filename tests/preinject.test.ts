import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import SkillRegistry, { renderSkillContent } from '@deepseek-ai/dsh-skill';
import { createScope } from '@deepseek-ai/dsh-scope';
import { Store, roleInputSchema } from '@kwagent/core';
import { readPreinjectSkills } from '../packages/kw-life/src/preinject.ts';

test('角色预注入列表默认兼容旧资料并拒绝无效名称和重复项', () => {
  const input = { id: 'reader', accountId: 'main', name: '阅读者', initialPersona: '按真实资料交流', provider: 'chat', model: 'configured' };
  assert.deepEqual(roleInputSchema.parse(input).preinjectSkills, []);
  assert.throws(() => roleInputSchema.parse({ ...input, preinjectSkills: ['../humanizer'] }));
  assert.throws(() => roleInputSchema.parse({ ...input, preinjectSkills: ['lagrange', 'lagrange'] }));
  const store = new Store(join(process.cwd(), '.artifacts/tests', randomUUID(), 'state.sqlite'));
  try { assert.deepEqual(store.createRole(roleInputSchema.parse(input)).preinjectSkills, []); } finally { store.close(); }
});

test('真实 Harness Skill 注册表按角色作用域解析正文，修改和取消不会污染旧快照', async () => {
  const ctx = new Context(); const registry = await ctx.plugin(SkillRegistry, {});
  let base!: Context;
  const consumer = await ctx.plugin({ name: 'preinject-test-consumer', inject: ['skills'], apply(child: Context) { base = child; } });
  const store = new Store(join(process.cwd(), '.artifacts/tests', randomUUID(), 'state.sqlite'));
  const firstKey = {}, secondKey = {}; const first = createScope(base, firstKey), second = createScope(base, secondKey);
  try {
    const body = await readFile('packages/kw-life/skills/kwagent-life/SKILL.md', 'utf8');
    const shared = { name: 'writing-style', description: '真实文件作为加载资料', source: 'runtime' as const, content: body };
    base.skills.register(shared);
    const scopedBody = await readFile('packages/kw-lagrange/skills/lagrange/SKILL.md', 'utf8'); first.ctx.skills.register({ ...shared, content: scopedBody });
    const input = { accountId: 'main', initialPersona: '独立角色', provider: 'chat', model: 'configured', preinjectSkills: ['writing-style'] };
    store.createRole(roleInputSchema.parse({ ...input, id: 'first', name: '第一位' })); store.createRole(roleInputSchema.parse({ ...input, id: 'second', name: '第二位' }));
    const selected = await readPreinjectSkills(store, 'first', first.ctx.skills, { scope: firstKey });
    const other = await readPreinjectSkills(store, 'second', second.ctx.skills, { scope: secondKey });
    assert.equal((selected[0] as { content: string }).content, renderSkillContent((await first.ctx.skills.get('writing-style', { scope: firstKey }))!));
    assert.notEqual((selected[0] as { digest: string }).digest, (other[0] as { digest: string }).digest);
    const frozen = JSON.stringify(selected); const role = store.role('first'); store.updateRole('first', { preinjectSkills: [] }, role.revision, 'owner', '修改预注入');
    assert.deepEqual(await readPreinjectSkills(store, 'first', first.ctx.skills, { scope: firstKey }), []); assert.equal(JSON.stringify(selected), frozen);
    await assert.rejects(readPreinjectSkills(store, 'second', second.ctx.skills, { scope: secondKey, signal: AbortSignal.abort() }), /abort/i);
    const current = store.role('second'); store.updateRole('second', { preinjectSkills: ['missing-skill'] }, current.revision, 'owner', '核验缺失 Skill');
    await assert.rejects(readPreinjectSkills(store, 'second', second.ctx.skills, { scope: secondKey }), /missing-skill/);
  } finally { store.close(); await first.dispose(); await second.dispose(); await consumer.dispose(); await registry.dispose(); }
});
