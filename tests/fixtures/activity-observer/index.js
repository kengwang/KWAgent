import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const name = 'kwagent-verification-observer';
export const inject = ['tools'];
export async function apply(ctx) {
  const directory = join(process.env.KW_DATA_ROOT, 'workspaces', 'verification-observer');
  await mkdir(directory, { recursive: true });
  const record = value => appendFile(join(directory, 'observations.jsonl'), `${JSON.stringify({ time: new Date().toISOString(), ...value })}\n`);
  await record({ lifecycle: 'mounted' });
  ctx.effect(() => () => record({ lifecycle: 'disposed' }), 'verification.lifecycle');
  ctx.tools.guard(exec => exec.name.startsWith('mcp__lagrange__') ? '本地验收角色仅使用内部工具' : undefined);
  ctx.tools.register({
    name: 'verification_observe',
    description: '将本地观察写入验收记录。stage 使用 initialize、timer 或 manual。',
    parameters: { type: 'object', properties: { stage: { type: 'string', enum: ['initialize', 'timer', 'manual'] }, text: { type: 'string' } }, required: ['stage', 'text'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { recorded: { type: 'boolean', const: true } }, required: ['recorded'] }, render: () => [{ type: 'text', text: '观察已保存。' }] },
    execute: async args => {
      if (!args || !['initialize', 'timer', 'manual'].includes(args.stage) || typeof args.text !== 'string') throw new Error('观察参数无效');
      await record(args);
      return { recorded: true };
    },
  });
}
