import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { LiteLLMEmbedService } from '../../src/embeddings/litellm.js';

test('LiteLLM embedding validates row count, dimension, and finite values', async (t) => {
  let mode = 'valid';
  const server = http.createServer((_req, res) => {
    const vector = Array.from({ length: mode === 'short' ? 3 : 1024 }, () => 0.01);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ index: 0, embedding: vector }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const service = new LiteLLMEmbedService(
    'bge-m3',
    '',
    `http://127.0.0.1:${server.address().port}`,
    { timeoutMs: 500 },
  );
  assert.equal((await service.embedOne('valid')).length, 1024);

  mode = 'short';
  await assert.rejects(service.embedOne('short'), /invalid vector.*dim=3.*want 1024/);
});
