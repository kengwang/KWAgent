import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, publicConfig, redact } from '@kwagent/core';
import { APP_VERSION } from '@kwagent/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('部署配置检查成对的模型字段和时区，公开状态脱敏', () => {
  const config = loadConfig({ KW_CHAT_API_KEY: 'local-secret', LAGRANGE_ACCESS_TOKEN: 'milky-secret' });
  assert.equal(config.milky.baseUrl, 'http://127.0.0.1:3000/');
  assert.equal(publicConfig(config).chat.credentialConfigured, true);
  assert.equal(JSON.stringify(publicConfig(config)).includes('local-secret'), false);
  assert.equal(redact('local-secret milky-secret Bearer other-secret', config), '[REDACTED] [REDACTED] Bearer [REDACTED]');
  assert.throws(() => loadConfig({ KW_VISION_BASE_URL: 'https://example.com/v1' }), /同时配置/);
  assert.throws(() => loadConfig({ KW_TIME_ZONE: 'not-a-timezone' }));
  assert.equal(config.asyncForegroundWaitMs, 5000);
  assert.equal(loadConfig({ KW_ASYNC_FOREGROUND_WAIT_MS: '15000' }).asyncForegroundWaitMs, 15000);
  assert.throws(() => loadConfig({ KW_ASYNC_FOREGROUND_WAIT_MS: '0' }));
});
test('运行版本与全部生产包元数据一致，连续性预算明确校验', () => {
  const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(APP_VERSION, read('package.json').version);
  for (const name of ['core', 'kw-mind', 'kw-life', 'kw-lagrange', 'kw-panel', 'kw-bundle']) assert.equal(read(join('packages', name, 'package.json')).version, APP_VERSION);
  assert.equal(loadConfig({}).continuityTokens, 3072);
  assert.throws(() => loadConfig({ KW_CONTINUITY_CONTEXT_TOKENS: '0' }));
});
