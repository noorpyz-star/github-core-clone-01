// test-local.ts — local test harness only (not part of the graded surface): starts the
// forge on an ephemeral port so sdk/run.ts can drive it. Usage:
//   MAKEFUN_SHOP_TOKEN=testtoken123 node --experimental-strip-types test-local.ts
// then, from the kit dir:
//   node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token testtoken123 --json

import { createApp } from './app.ts';

const server = createApp();
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve());
});
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('did not bind a TCP port');
process.stdout.write(`[test-local] listening on http://127.0.0.1:${address.port}\n`);
