import { Store } from '@kwagent/core';
const store = new Store(process.env.KW_TEST_DB);
store.completeChunk(process.env.KW_TEST_EVENT, 0);
process.kill(process.pid, 'SIGKILL');
