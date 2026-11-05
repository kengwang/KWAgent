import { createHash } from 'node:crypto';
import { isModelInvocable, renderSkillContent, type SkillRegistry, type SkillViewOptions } from '@deepseek-ai/dsh-skill';
import { asJson, ConflictError, type Json, type Store } from '@kwagent/core';

/** 读取角色当前作用域与工作目录的 Skill，正文与来源一起进入步骤快照。 */
export async function readPreinjectSkills(store: Store, roleId: string, skills: SkillRegistry, options: SkillViewOptions): Promise<Json[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const names = store.role(roleId).preinjectSkills;
    const selected: Json[] = [];
    for (const name of names) {
      options.signal?.throwIfAborted();
      const skill = await skills.get(name, options);
      if (!skill || !isModelInvocable(skill)) throw new Error(`角色 ${roleId} 的预注入 Skill 不存在或不可供模型读取：${name}`);
      const content = renderSkillContent(skill);
      selected.push(asJson({ name: skill.name, provider: skill.provider, source: skill.source, path: skill.path ?? null, resourceBase: skill.resourceBase ?? null, digest: createHash('sha256').update(content).digest('hex'), content }));
    }
    options.signal?.throwIfAborted();
    const current = store.role(roleId);
    if (JSON.stringify(names) === JSON.stringify(current.preinjectSkills)) return selected;
    if (attempt === 2) throw new ConflictError(asJson(current));
  }
  throw new Error('预注入 Skill 读取没有完成');
}
