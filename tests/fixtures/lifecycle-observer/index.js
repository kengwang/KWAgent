import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionId } from '@deepseek-ai/dsh-session';

export const name = 'kwagent-lifecycle-observer';
export const inject = ['kwLife', 'webServer', 'workspaceRegistry', 'tools'];
export async function apply(ctx) {
  if (process.env.KW_LIFECYCLE_TEST !== 'true' || !new URL(process.env.KW_PUBLIC_URL).hostname.match(/^(127\.0\.0\.1|localhost)$/)) throw new Error('会话验收扩展只允许在隔离的本机环境启用');
  const life = ctx.kwLife;
  const roleId = process.env.KW_LIFECYCLE_TEST_ROLE;
  const directory = join(process.env.KW_DATA_ROOT, 'workspaces', roleId); await mkdir(directory, { recursive: true });
  ctx.tools.guard(exec => exec.name.startsWith('mcp__lagrange__') ? '会话管理验收禁止全部QQ调用' : undefined);
  ctx.tools.register({ name: 'verification_mark', description: '将本次内部验收的观察写入本地记录，text填写一句话。', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: async (args, exec) => { if (!exec.agent) throw new Error('验收记录缺少实际Agent'); await appendFile(join(directory, 'lifecycle-observations.jsonl'), `${JSON.stringify({ sessionId: exec.agent.session.id, at: new Date().toISOString(), text: args.text })}\n`); return { recorded: true }; } });
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/kw-lifecycle-test', handler: async (request, response) => {
    const send = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
    if (request.method === 'GET') return send({ sessionId: life.store.role(roleId).sessionId, archived: [...ctx.workspaceRegistry.archivedSessionIds], schedules: await life.context.schedule.catalog(), frozen: JSON.parse(life.context.kwMind.freeze(roleId, '{"memories":[]}')) });
    if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
    const body = Buffer.concat(await Array.fromAsync(request)); if (body.length > 4096) throw new Error('验收请求超出范围');
    const action = JSON.parse(body.toString('utf8')).action;
    const sessionId = life.store.role(roleId).sessionId;
    if (action === 'archive' || action === 'archive-during-maintenance') {
      if (action === 'archive-during-maintenance') await life.quiesce();
      await ctx.workspaceRegistry.archiveSession(SessionId(sessionId), { stopActivity: true });
      return send({ archived: sessionId });
    }
    if (action === 'crash-next-reset') {
      life.context.effect(() => {
        const changed = () => {
          if (life.store.meta(`lifecycle:${roleId}`) && life.store.role(roleId).sessionId !== sessionId) { life.store.changes.off('change', changed); process.exit(73); }
        };
        life.store.changes.on('change', changed); return () => life.store.changes.off('change', changed);
      }, 'verification.lifecycle-crash');
      return send({ armed: true });
    }
    response.writeHead(400); response.end('未知验收操作');
  } }), 'verification.lifecycle-route');
}
