import test from 'node:test';
import assert from 'node:assert/strict';
import { privatePath } from '../scripts/publication.mjs';

test('发布清单拒绝凭据与运行文件并保留公开配置模板', () => {
  const paths = ['.env', '.env.production', 'deploy/.env.example', 'secrets/key.json', '.artifacts/report.json', 'data/dsh/session.jsonl', 'workspaces/role/notes.md', 'backups/state.sqlite', 'media/image.png', 'state.sqlite-wal', 'config.local.json', 'tls/private.key', 'compose.override.yaml', 'scripts/verify-social.mjs', '.playwright-cli/page.yml', 'output/playwright/screenshot.png'];
  for (const path of paths) {
    assert.equal(privatePath(path), true, path);
  }
  for (const path of ['.venv/pyvenv.cfg', 'browser-profile/Default/Cookies', 'browser-output/page.png', 'nested/__pycache__/module.pyc']) assert.equal(privatePath(path), true);
  for (const path of ['.env.example', 'Dockerfile', 'packages/core/src/config.ts', '.github/workflows/ci.yml', 'scripts/publication.mjs']) assert.equal(privatePath(path), false, path);
});
