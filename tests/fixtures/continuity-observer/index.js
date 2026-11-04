import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const name = 'kwagent-continuity-observer';
export const inject = ['tools', 'kwLife'];
export async function apply(ctx) {
  const life = ctx.kwLife; const extension = life.store.extensions().find(item => item.enabled && item.packageName === 'kwagent-continuity-observer');
  if (!extension) throw new Error('找不到验收扩展归属');
  const roleId = extension.roleId; const directory = join(process.env.KW_DATA_ROOT, 'workspaces', roleId); await mkdir(directory, { recursive: true });
  const path = join(directory, 'reading.txt'); await writeFile(path, '阅读观察：叶片方向与光照有关。当前文件没有实验数据，仍需了解其他因素。');
  ctx.tools.guard(exec => exec.name.startsWith('mcp__lagrange__') ? '连续性验收禁止所有远程社交工具' : undefined);
  ctx.tools.register({ name: 'verification_read', description: '实际读取本地观察文件，返回已成功的操作ID与全文。', parameters: { type: 'object', additionalProperties: false }, output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: async (_args, exec) => {
    const operation = life.store.startOperation('main', roleId, 'read_file', { path }, { callId: exec.callId, rootCallId: exec.rootCallId, executionId: life.store.invocationId(exec.token) });
    const text = await readFile(path, { encoding: 'utf8', signal: exec.signal }); life.store.finishOperation(operation.id, 'succeeded', { path, text }); return { operationId: operation.id, text };
  } });
  ctx.tools.register({ name: 'verification_mark', description: '保存验收阶段，stage为initialized/refused/feedback/timer，text记录你的判断。', parameters: { type: 'object', properties: { stage: { type: 'string', enum: ['initialized', 'refused', 'feedback', 'timer'] }, text: { type: 'string' } }, required: ['stage', 'text'], additionalProperties: false }, output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: async args => { await appendFile(join(directory, 'continuity-observations.jsonl'), `${JSON.stringify({ ...args, at: new Date().toISOString() })}\n`); return { recorded: true }; } });
}
