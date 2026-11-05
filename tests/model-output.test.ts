import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { parseModelOutput, modelRequestFailure } from '../packages/kw-mind/src/model-output.ts';
import { EvidenceError, PersistenceError, Store } from '@kwagent/core';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

test('模型 JSON 格式可修复，语义与字段仍严格校验', () => {
  const schema = z.object({ queries: z.array(z.string()) });
  assert.deepEqual(parseModelOutput(schema, '{"queries":["人物"]}'), { value: { queries: ['人物'] }, repaired: false });
  assert.deepEqual(parseModelOutput(schema, '```json\n{"queries":["人物",],}\n```'), { value: { queries: ['人物'] }, repaired: true });
  assert.throws(() => parseModelOutput(schema, '{"queries":123}'), EvidenceError);
  assert.throws(() => parseModelOutput(schema, '{"queries":[null]}'), EvidenceError);
});

test('真实SQLite故障和持久行Schema错误不被归类为模型请求失败', () => {
  const store = new Store(join(process.cwd(), '.artifacts/tests', `${randomUUID()}.sqlite`));
  try {
    store.db.exec("CREATE TEMP TRIGGER reject_usage BEFORE INSERT ON usage BEGIN SELECT RAISE(ABORT,'拒绝本次usage写入'); END");
    assert.throws(() => store.addUsage('role', '2026-11-05', 1), error => { assert.equal(modelRequestFailure(error), false); return true; });
    assert.equal(modelRequestFailure(z.string().safeParse(1).error), false);
    store.put('corrupt-test', 'bad-record', null, { content: 123 }, null, 'owner', '检验持久行边界');
    assert.throws(() => store.get('corrupt-test', 'bad-record', z.object({ content: z.string() })), error => { assert.ok(error instanceof PersistenceError); assert.equal(modelRequestFailure(error), false); return true; });
    assert.throws(() => store.list('corrupt-test', z.object({ content: z.string() })), PersistenceError);
  } finally { store.close(); }
});
