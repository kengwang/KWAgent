import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, publicConfig, redact } from '@kwagent/core';

test('部署配置检查成对的模型字段和时区，公开状态脱敏', () => {
  const config = loadConfig({ KW_CHAT_API_KEY: 'local-secret', LAGRANGE_ACCESS_TOKEN: 'milky-secret' });
  assert.equal(config.milky.baseUrl, 'https://agent-kw-milky.d1no.cn/');
  assert.equal(publicConfig(config).chat.credentialConfigured, true);
  assert.equal(JSON.stringify(publicConfig(config)).includes('local-secret'), false);
  assert.equal(redact('local-secret milky-secret Bearer other-secret', config), '[REDACTED] [REDACTED] Bearer [REDACTED]');
  assert.throws(() => loadConfig({ KW_VISION_BASE_URL: 'https://example.com/v1' }), /同时配置/);
  assert.throws(() => loadConfig({ KW_TIME_ZONE: 'not-a-timezone' }));
});
