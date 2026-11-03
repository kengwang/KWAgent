import test from 'node:test';
import assert from 'node:assert/strict';
import { appendPage } from '../packages/kw-panel/src/client/paging.ts';

test('后续页去重并保留不同角色的同名扩展', () => {
  const previous = { items: [{ id: 'validation', roleId: 'alice', value: '旧值' }], nextCursor: 1 };
  const next = { items: [{ id: 'validation', roleId: 'alice', value: '当前值' }, { id: 'validation', roleId: 'bob', value: '其他角色' }], nextCursor: null };
  const result = appendPage(previous, next, item => `${item.roleId}:${item.id}`);
  assert.equal(result.items.length, 2); assert.equal(result.items[0]?.value, '当前值'); assert.equal(result.items[1]?.roleId, 'bob'); assert.equal(result.nextCursor, null);
});
