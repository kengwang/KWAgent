import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { Store, executionOrigin, roleInputSchema } from '@kwagent/core';

test('后台执行跨越异步文件操作后仍关联发起活动', async () => {
  const root = join(process.cwd(), '.artifacts/tests', randomUUID());
  const store = new Store(join(root, 'state.sqlite'));
  try {
    store.createRole(roleInputSchema.parse({ id: 'writer', name: '写入验收', accountId: 'main', provider: 'chat', model: 'configured', initialPersona: '记录实际文件操作', state: 'disabled' }));
    const task = executionOrigin.run({ roleId: 'writer', activityId: 'activity-original', taskId: 'task-file' }, async () => {
      await mkdir(root, { recursive: true });
      const operation = store.startOperation('main', 'writer', 'write_actual_file', { path: join(root, 'actual.txt') });
      await writeFile(join(root, 'actual.txt'), '实际异步内容');
      store.finishOperation(operation.id, 'succeeded', { text: await readFile(join(root, 'actual.txt'), 'utf8') });
      return operation.id;
    });
    store.setMeta('activity:writer', 'activity-later');
    const id = await task;
    assert.ok(store.links('activity-original').some(link => link && typeof link === 'object' && !Array.isArray(link) && String(link.id).startsWith(id)));
    assert.deepEqual(store.links('activity-later'), []);
    assert.equal(executionOrigin.getStore(), undefined);
  } finally { store.close(); }
});
