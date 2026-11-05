import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { load } from 'js-yaml';

test('模型提供商使用可由设置页面保存的普通对象', async () => {
  const value = load(await readFile('packages/kw-bundle/cordis.patch.yml', 'utf8')) as Array<Record<string, unknown>>;
  const llm = value.find(entry => entry.id === 'llm-pi-ai') as { config: { providers: Record<string, unknown> } };
  assert.ok(llm.config.providers['kw-chat']);
  assert.equal(Object.hasOwn(llm.config.providers, '__jsExpr'), false);
  assert.equal((llm.config.providers['kw-chat'] as { baseURL: string }).baseURL, 'https://workbuddy2api.d1no.cn/v1');
});
