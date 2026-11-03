import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { join, resolve } from 'node:path';
import { Store, loadConfig } from '@kwagent/core';
import { MilkyClient } from '@kwagent/kw-lagrange';
if (existsSync('.env')) loadEnvFile('.env');
const config = loadConfig();
const store = new Store(join(resolve('.artifacts'), 'milky-verification.sqlite'));
const client = new MilkyClient(config.milky, store);
try {
  await client.connect();
  const groups = await client.call('get_group_list', {});
  console.log(JSON.stringify({ connected: true, tools: client.tools.length, accountId: client.selfId, groups: typeof groups === 'object' && groups && 'groups' in groups && Array.isArray(groups.groups) ? groups.groups.length : null }));
} finally { await client.close(); store.close(); }
