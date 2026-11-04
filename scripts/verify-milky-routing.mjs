import assert from 'node:assert/strict';
import { loadEnvFile } from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Store, loadConfig } from '@kwagent/core';
import { MilkyClient, milkyId, toolConversation } from '@kwagent/kw-lagrange';
import { Ajv } from 'ajv';

loadEnvFile('.env');
const groupId = milkyId(process.argv[2]);
const contactId = milkyId(process.argv[3]);
const root = resolve('.artifacts/milky-routing', String(Date.now()));
const store = new Store(join(root, 'state.sqlite'));
const client = new MilkyClient(loadConfig().milky, store);
try {
  await client.connect(AbortSignal.timeout(60000));
  const ajv = new Ajv({ strict: false, validateFormats: false });
  const verified = [];
  for (const [tool, args, context] of [
    ['send_group_message', { group_id: String(groupId), message: [{ type: 'text', data: { text: '预取消校验，不发送。' } }] }, { scene: 'group', peerId: groupId }],
    ['send_private_message', { user_id: String(contactId), message: [{ type: 'text', data: { text: '预取消校验，不发送。' } }] }, { scene: 'private', peerId: contactId }],
    ['send_temp_message', { group_id: String(groupId), user_id: String(contactId), message: [{ type: 'text', data: { text: '预取消校验，不发送。' } }] }, { scene: 'private', peerId: contactId }],
  ]) {
    const definition = client.tools.find(item => item.name === tool);
    assert.ok(definition);
    const validate = ajv.compile(definition.inputSchema);
    assert.ok(validate(args), ajv.errorsText(validate.errors));
    assert.deepEqual(toolConversation(args, tool), context);
    const abort = new AbortController();
    abort.abort(new Error('验收在远程派发前取消'));
    await assert.rejects(client.execute(tool, args, null, abort.signal), /远程派发前取消/);
    const operation = store.operations().find(item => item.tool === tool);
    assert.equal(operation.state, 'failed');
    assert.deepEqual(operation.context, context);
    assert.deepEqual(operation.arguments, args);
    verified.push({ tool, remoteSchemaAcceptedStringId: true, contextSaved: true, cancelledBeforeDispatch: true });
  }
  const report = { actualMcpDiscovery: true, actualSqlite: true, verified, noSocialSends: true };
  await mkdir('.artifacts/verification', { recursive: true });
  await writeFile('.artifacts/verification/milky-routing.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await client.close(); store.close(); }
