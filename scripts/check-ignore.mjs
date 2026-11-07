import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const paths = ['.env', '.env.production', 'deploy/.env.example', 'secrets/key.json', '.artifacts/report.json', 'data/dsh/session.jsonl', 'workspaces/role/notes.md', 'backups/state.sqlite', 'media/image.png', 'state.sqlite-wal', 'config.local.json', 'tls/private.key', 'compose.override.yaml', 'scripts/verify-social.mjs'];
paths.push('.playwright-cli/session.json', 'output/playwright/auth-state.json');
paths.push('.venv/pyvenv.cfg', 'browser-profile/Default/Cookies', 'browser-output/page.png', 'packages/core/__pycache__/module.pyc');
for (const path of paths) {
  const result = spawnSync('git', ['check-ignore', '--no-index', '--', path], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${path}: ${result.stderr}`);
}
assert.equal(spawnSync('git', ['check-ignore', '--no-index', '--', '.env.example']).status, 1);
console.log('Git 私密文件忽略规则检查通过');
