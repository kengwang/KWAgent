import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Store, roleInputSchema, rolePatchSchema, ConflictError } from '@kwagent/core';

test('角色推理等级支持默认、明确档位和旧资料读取，局部保存不填充其他默认值', () => {
  const store = new Store(join(process.cwd(), '.artifacts/tests', randomUUID(), 'state.sqlite'));
  try {
    const role = store.createRole(roleInputSchema.parse({ id: 'reasoning', accountId: 'main', name: '角色模型设置', provider: 'kw-chat', model: 'configured-model', initialPersona: '保持既有人格。', state: 'paused', groups: [20001], adminQQs: [10001], worldMode: 'fictional', memoryTokens: 16384, dailyRequests: 17, preinjectSkills: ['kwagent-life'] }));
    assert.equal(role.reasoningEffort, null);
    assert.deepEqual(rolePatchSchema.parse({ reasoningEffort: 'high' }), { reasoningEffort: 'high' });
    assert.deepEqual(rolePatchSchema.parse({ name: '改名' }), { name: '改名' });
    assert.deepEqual(rolePatchSchema.parse({ reasoningEffort: null }), { reasoningEffort: null });
    assert.throws(() => rolePatchSchema.parse({ reasoningEffort: '' }));
    const high = store.updateRole(role.id, rolePatchSchema.parse({ reasoningEffort: 'high' }), role.revision, 'owner', '配置角色推理');
    for (const field of ['state', 'groups', 'adminQQs', 'preinjectSkills', 'worldMode', 'memoryTokens', 'dailyRequests', 'persona', 'selfState'] as const) assert.deepEqual(high[field], role[field]);
    const other = store.createRole(roleInputSchema.parse({ id: 'other', accountId: 'main', name: '独立配置', provider: 'kw-chat', model: 'configured-model', initialPersona: '独立。', reasoningEffort: 'off' }));
    assert.equal(other.reasoningEffort, 'off');
    assert.throws(() => store.updateRole(role.id, rolePatchSchema.parse({ reasoningEffort: 'low' }), role.revision, 'owner', '过期修改'), ConflictError);
    store.close();
    const restored = new Store(store.path);
    try {
      assert.equal(restored.role(role.id).reasoningEffort, 'high');
      const cleared = restored.updateRole(role.id, rolePatchSchema.parse({ reasoningEffort: null }), high.revision, 'owner', '跟随提供商');
      assert.equal(cleared.reasoningEffort, null); assert.equal(cleared.state, 'paused');
      restored.db.prepare("UPDATE documents SET body=json_remove(body,'$.reasoningEffort') WHERE kind='role' AND id=?").run(other.id);
      assert.equal(restored.role(other.id).reasoningEffort, null);
    } finally { restored.close(); }
  } finally { store.close(); }
});
