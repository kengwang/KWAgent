import type { Context } from '@deepseek-ai/cordis';
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry';
import { entryListProblem } from '@deepseek-ai/dsh-agent-preset-registry';
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include';
import { load } from 'js-yaml';

/** 通过公开声明接口保留宿主工具，并为角色挂载专用的压缩与人格配置。 */
export async function registerRolePreset(ctx: Context): Promise<void> {
  const document = await ctx.agentPresets.readDocument('standard');
  const value = load(document.content, { schema: entryListSchema });
  const problem = entryListProblem(value); if (problem) throw new Error(`宿主角色配置无效：${problem}`);
  let replaced = 0;
  const visit = (rows: PresetDefinition['plugins']): PresetDefinition['plugins'] => rows.map(row => {
    if (row.id === 'compaction-basic') { replaced++; return { ...row, name: '@kwagent/kw-mind/compaction' }; }
    if (row.id === 'persona') return { ...row, config: { ...row.config, prefix: '' } };
    return row.group && Array.isArray(row.config) ? { ...row, config: visit(row.config) } : row;
  });
  const plugins = visit(value as PresetDefinition['plugins']); if (replaced !== 1) throw new Error('宿主配置没有唯一的角色压缩入口');
  const release = await ctx.agentPresets.register({ id: 'kwagent', name: 'KWAgent', description: '自主生活与交流角色', plugins });
  ctx.effect(() => release, 'kw-life.role-preset');
}
