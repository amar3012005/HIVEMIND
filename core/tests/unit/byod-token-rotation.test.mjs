import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const directory = await mkdtemp(join(tmpdir(), 'hm-byod-token-'));
const registry = join(directory, 'agents.json');
const seenTokens = [];
const server = http.createServer((req, res) => {
  seenTokens.push(req.headers.authorization);
  if (req.headers.authorization === 'Bearer old-token') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ results: [{ id: 'memory-1' }] }));
  }
  res.writeHead(401).end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

process.env.MNEME_AGENT_REGISTRY_FILE = registry;
await writeFile(registry, JSON.stringify({
  org: {
    url: `http://127.0.0.1:${port}`,
    token: 'new-token',
    previousTokens: [{ token: 'old-token', expiresAt: new Date(Date.now() + 60_000).toISOString() }],
  },
}));
const { remoteRecall } = await import('../../src/vector/mneme/remote-backend.js');

test('remote agent token rotation falls back only to an unexpired old token', async (t) => {
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const results = await remoteRecall('org', [0.1], {}, 1, 0);
  assert.deepEqual(results, [{ id: 'memory-1' }]);
  assert.deepEqual(seenTokens, ['Bearer new-token', 'Bearer old-token']);
});
