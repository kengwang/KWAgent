import { loadEnvFile } from 'node:process';
import { request } from 'node:http';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { Store } from '@kwagent/core';
import { restoreBackup } from '@kwagent/kw-life';

loadEnvFile('.env');
const data = resolve(process.env.KW_DATA_ROOT ?? './data');
const socketPath = process.platform === 'win32' ? String.raw`\\.\pipe\kwagent-${createHash('sha256').update(data).digest('hex').slice(0, 16)}` : join(data, 'run/admin.sock');
function call(action, payload = null) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: `/${encodeURIComponent(action)}`, method: 'POST' }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
      response.on('end', () => { const result = JSON.parse(text); result.ok ? resolve(result.result) : reject(new Error(result.error)); });
    });
    req.on('error', reject); req.end(JSON.stringify(payload));
  });
}
const id = `integration-${Date.now()}`;
const role = await call('role.create', { id, accountId: 'main', name: '持久化验收角色', initialPersona: '观察自然、阅读科学资料，用真实经历形成自己的认识。', provider: process.env.KW_LLM_PROVIDER, model: process.env.KW_LLM_MODEL });
assert.equal(role.state, 'disabled');
const prepared = await call('role.prepare', { id });
assert.equal(prepared.prepared, true);
const event = await call('event', { roleId: id, text: '本地观察笔记：窗边的向日葵在早晨朝向阳光，连续三个早晨都观察到相同现象。这条笔记保存在本次验收环境中。' });
const consolidated = await call('memory.consolidate', { roleId: id });
assert.ok(consolidated.memories > 0);
const state = await call('status', { roleId: id });
assert.ok(state.memories.some(memory => memory.sources.includes(event.id)));
const memory = state.memories.find(memory => memory.sources.includes(event.id));
const matches = await call('memory.recall', { roleId: id, query: memory.content.slice(0, 6), semantic: false });
assert.ok(matches.some(item => item.id === memory.id));
const plan = await call('plan', { roleId: id, request: { action: 'create', kind: 'time', title: '稍后阅读观察笔记', instruction: '重新查阅这条观察笔记。', timing: { kind: 'after', after_seconds: 3600 } } });
assert.equal(plan.status, 'paused');
await call('role.control', { id, state: 'paused' });
const backup = await call('backup');
const restore = resolve('.artifacts/restored', id);
await restoreBackup(backup.directory, restore);
const db = new Store(join(restore, 'kwagent/state.sqlite'));
try { assert.equal(db.role(id).state, 'paused'); assert.ok(db.memories(id).length > 0); assert.equal(db.integrity(), 'ok'); } finally { db.close(); }
await mkdir('.artifacts/verification', { recursive: true });
await writeFile('.artifacts/verification/harness.json', JSON.stringify({ roleId: id, prepared: true, memories: consolidated.memories, planStatus: plan.status, backupFiles: backup.files, restored: true }, null, 2));
console.log(JSON.stringify({ roleId: id, prepared: true, memories: consolidated.memories, planStatus: plan.status, backupFiles: backup.files, restored: true }));
