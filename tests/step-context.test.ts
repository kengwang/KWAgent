import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import { joinContextSections } from '@deepseek-ai/dsh-system-prompt';
import { retireStepContexts } from '../packages/kw-life/src/step-context.ts';

test('步骤替换仅移除旧KW背景，保持消息、其他贡献和不可变原始记录', async () => {
  const session = Session.create(SessionId(randomUUID()));
  session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('保持角色身份') }, { surfaceOp: 'append' });
  const input = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '实际输入' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  const original = [];
  for (let index = 0; index < 20; index++) {
    const sections = [{ name: 'kw-life-state', text: JSON.stringify({ memories: ['背景正文'.repeat(100)], revision: index }) }, ...index === 0 ? [{ name: 'other-plugin', text: '其他插件的独立状态' }] : []];
    original.push(session.append('user/message', createUserMessage({ content: [{ type: 'text', text: joinContextSections(sections) }], source: { kind: 'runtime-context', form: 'snapshot', sections } }), { surfaceOp: 'append' }));
  }
  assert.equal(session.deriveMessages().filter(message => JSON.stringify(message.content).includes('背景正文')).length, 20);
  retireStepContexts(session, 2, 1);
  assert.equal(session.deriveMessages().filter(message => JSON.stringify(message.content).includes('背景正文')).length, 0);
  assert.ok(session.deriveMessages().some(message => message.id === input.data.id));
  assert.equal(session.deriveMessages().filter(message => JSON.stringify(message.content).includes('其他插件的独立状态')).length, 1);
  for (const event of original) assert.deepEqual(session.eventAt(event.seq), event);
  const count = session.snapshotEvents().length;
  retireStepContexts(session, 2, 1);
  assert.equal(session.snapshotEvents().length, count);
  const path = join(process.cwd(), '.artifacts/tests', `${randomUUID()}.json`);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(session.snapshotEvents()));
  const restored = Session.create(session.id, JSON.parse(await readFile(path, 'utf8')) as SessionEvent[]);
  assert.deepEqual(restored.deriveMessages(), session.deriveMessages());
  const sections = [{ name: 'kw-life-state', text: '当前唯一背景' }];
  restored.append('user/message', createUserMessage({ content: [{ type: 'text', text: joinContextSections(sections) }], source: { kind: 'runtime-context', form: 'snapshot', sections } }), { surfaceOp: 'append' });
  assert.equal(restored.deriveMessages().filter(message => message.source.kind === 'runtime-context' && message.source.form === 'snapshot' && message.source.sections.some(section => section.name === 'kw-life-state')).length, 1);
  assert.equal(restored.snapshotEvents().filter(event => event.type.startsWith('compaction/')).length, 0);
});
