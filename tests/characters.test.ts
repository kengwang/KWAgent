import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Store, createCharacter, characterDraftSchema, roleInputSchema } from '@kwagent/core';

test('角色与生成世界一起保存，现实认识和虚构设定不被写成亲历事实', () => {
  const store = new Store(join(process.cwd(), '.artifacts/tests', randomUUID(), 'state.sqlite'));
  try {
    const role = createCharacter(store, roleInputSchema.parse({ id: 'librarian', name: '书店管理员', accountId: 'main', initialPersona: '住在雨港旧书店，研究古书。', provider: 'configured', model: 'configured', worldMode: 'mixed' }), [{ title: '雨港', content: '故事发生在常年下雨的港口，古书可以记录遗忘的梦。', realm: 'fictional' }, { title: '阅读习惯', content: '希望定期分享阅读时发现的问题。', realm: 'real' }]);
    assert.equal(role.state, 'disabled');
    assert.deepEqual(role.groups, []);
    const memories = store.memories(role.id);
    assert.equal(memories.length, 2);
    assert.equal(memories.find(memory => memory.title === '雨港')!.epistemic, 'fictional');
    assert.equal(memories.find(memory => memory.title === '阅读习惯')!.epistemic, 'inferred');
    for (const memory of memories) {
      const source = store.event(memory.sources[0]!);
      assert.equal(source.type, 'character-setting');
      assert.equal(source.source, 'manual');
      assert.equal(source.roleId, role.id);
    }
    assert.equal(store.unprocessed(role.id).length, 0, '创建时已保存的设定不重复提交模型整理');
  } finally { store.close(); }
});

test('角色创建失败时世界和来源同时撤销，生成草稿拒绝服务器配置字段', () => {
  const store = new Store(join(process.cwd(), '.artifacts/tests', randomUUID(), 'state.sqlite'));
  try {
    const input = roleInputSchema.parse({ id: 'invalid', name: '验证角色', accountId: 'main', initialPersona: '现实角色', provider: 'configured', model: 'configured', worldMode: 'real' });
    assert.throws(() => createCharacter(store, input, [{ title: '魔法', content: '虚构世界条目', realm: 'fictional' }]), /现实情境/);
    assert.equal(store.roles().length, 0);
    assert.equal(store.events(input.id).length, 0);
    assert.throws(() => createCharacter(store, input, [], randomUUID()), /生成记录/);
    assert.equal(store.roles().length, 0);
    const draft = { id: 'reader', name: '阅读角色', initialPersona: '初始设定', persona: '当前人格', selfState: '正在阅读', expressionExamples: ['这段话很有意思。', '我想再查查。'], worldMode: 'real', world: [{ title: '阅读背景', content: '偏爱自然科学。', realm: 'real' }] };
    assert.equal(characterDraftSchema.safeParse(draft).success, true);
    assert.equal(characterDraftSchema.safeParse({ ...draft, adminQQs: [10001] }).success, false);
    assert.equal(characterDraftSchema.safeParse({ ...draft, provider: 'other' }).success, false);
  } finally { store.close(); }
});
