import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { Store, continuitySchema } from '@kwagent/core';
import { restoreBackup } from '@kwagent/kw-life';
const result = spawnSync(process.execPath, ['scripts/admin.mjs', 'backup'], { encoding: 'utf8' }); if (result.status !== 0) throw new Error(result.stderr);
const backup = JSON.parse(result.stdout); const target = resolve('.artifacts/restored', `continuity-${Date.now()}`);
await restoreBackup(backup.directory, target);
const report = JSON.parse(await readFile('.artifacts/verification/continuity.json', 'utf8')); const db = new Store(join(target, 'kwagent/state.sqlite'));
try {
  assert.equal(db.integrity(), 'ok'); assert.equal(db.role(report.roleId).state, 'paused');
  const records = db.list('continuity', continuitySchema, report.roleId, 200); assert.ok(records.some(record => record.data.kind === 'thread' && record.data.status === 'declined')); assert.ok(records.some(record => record.data.kind === 'reflection'));
  for (const record of records) for (const source of record.data.sources) db.validateSources(report.roleId, [source], false);
  const manifest = JSON.parse(await readFile(join(backup.directory, 'manifest.json'), 'utf8')); assert.equal(manifest.schema, 3); assert.equal(manifest.appVersion, '0.3.0');
  const output = { roleId: report.roleId, files: backup.files, restoredRecords: records.length, sourcesValid: true, schema: 3 };
  await mkdir('.artifacts/verification', { recursive: true }); await writeFile('.artifacts/verification/continuity-restore.json', JSON.stringify(output, null, 2)); console.log(JSON.stringify(output));
} finally { db.close(); }
