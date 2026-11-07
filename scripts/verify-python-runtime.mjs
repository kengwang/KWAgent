import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { preparePython } from '@kwagent/core';

const mode = process.argv[2];
assert.ok(['create', 'resume'].includes(mode));
assert.equal(process.getuid(), 10001);
const workspace = '/data/workspaces/python-runtime-test';
if (mode === 'resume') assert.ok(existsSync('/data/python/.venv/pyvenv.cfg'));
await mkdir(workspace, { recursive: true });
await mkdir('/data/workspaces/python-runtime-other', { recursive: true });
const [python, other] = await Promise.all([preparePython('/data'), preparePython('/data')]);
assert.equal(python, other);
function run(command, args, cwd = workspace) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
if (mode === 'create') run('uv', ['pip', 'install', '--python', python, 'idna==3.11']);
await preparePython('/data');
run(other, ['-c', 'import idna; assert idna.__version__ == "3.11"'], '/data/workspaces/python-runtime-other');
console.log(run(python, [resolve('scripts/verify-python-browser.py'), mode]));
console.log(JSON.stringify({ mode, nonRoot: true, actualUvInstall: mode === 'create', sharedEnvironment: true, concurrentPreparation: true, existingPackagesPreserved: true }));
