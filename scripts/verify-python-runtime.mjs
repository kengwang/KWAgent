import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { prepareRolePython } from '@kwagent/core';

const mode = process.argv[2];
assert.ok(['create', 'resume'].includes(mode));
assert.equal(process.getuid(), 10001);
const workspace = '/data/workspaces/python-runtime-test';
if (mode === 'resume') assert.ok(existsSync(join(workspace, '.venv/pyvenv.cfg')));
const python = await prepareRolePython(workspace);
function run(command, args, cwd = workspace) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
if (mode === 'create') run('uv', ['pip', 'install', '--python', python, 'idna==3.11']);
await prepareRolePython(workspace);
const other = await prepareRolePython('/data/workspaces/python-runtime-other');
run(other, ['-c', 'import importlib.util; assert importlib.util.find_spec("idna") is None']);
console.log(run(python, [resolve('scripts/verify-python-browser.py'), mode]));
console.log(JSON.stringify({ mode, nonRoot: true, actualUvInstall: mode === 'create', isolatedRolePackages: true, existingPackagesPreserved: true }));
