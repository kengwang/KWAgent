import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { consolidationSchema, parseConsolidationOutput } from '@kwagent/kw-mind';

const path = process.argv[2];
if (!path) throw new Error('需要实际失败输出的本地JSON文件');
const samples = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
assert.ok(Array.isArray(samples) && samples.length);
const results = samples.map(sample => {
  assert.ok(sample.operationId && sample.input?.sources && typeof sample.output === 'string');
  try {
    const result = parseConsolidationOutput(consolidationSchema, sample.output, sample.input);
    return { operationId: sample.operationId, mode: sample.mode, formatAccepted: true, hostNormalized: result.repaired, memories: result.value.memories.length, continuity: result.value.continuity.length };
  } catch (error) {
    assert.equal(error.name, 'Error');
    return { operationId: sample.operationId, mode: sample.mode, formatAccepted: false, validationRejected: true };
  }
});
const report = { actualSavedFailures: true, noModelRequests: true, noDatabaseWrites: true, samples: results.length, acceptedFormat: results.filter(item => item.formatAccepted).length, rejectedFormat: results.filter(item => !item.formatAccepted).length, results };
await writeFile('.artifacts/verification/consolidation-failure-replay.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ samples: report.samples, acceptedFormat: report.acceptedFormat, rejectedFormat: report.rejectedFormat, noModelRequests: true, noDatabaseWrites: true }));
