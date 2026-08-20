import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

test('reranker shares one total budget across primary and fallback and reports the serving model', async (t) => {
  const attempts = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      attempts.push(body.model);
      setTimeout(() => {
        if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/json' });
        if (!res.writableEnded) res.end(JSON.stringify({
          results: [
            { index: 1, relevance_score: 0.95 },
            { index: 0, relevance_score: 0.05 },
          ],
        }));
      }, body.model === 'primary-test' ? 120 : 5);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  process.env.RERANK_ENABLED = 'true';
  process.env.RERANK_PROVIDER = 'cohere';
  process.env.RERANK_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.RERANK_MODEL = 'primary-test';
  process.env.RERANK_FALLBACK_MODELS = 'fallback-test';
  process.env.RERANK_TIMEOUT_MS = '1000';
  process.env.RERANK_TOTAL_TIMEOUT_MS = '180';
  process.env.RERANK_MAX_ATTEMPTS_TOTAL = '2';
  process.env.RERANK_RETRIES = '3';
  const { rerank } = await import(`../../src/memory/reranker.js?budget=${Date.now()}`);

  const startedAt = Date.now();
  const rows = await rerank('target fact', [
    { id: 'distractor', content: 'unrelated' },
    { id: 'target', content: 'target fact' },
  ], { topN: 2 });

  assert.equal(rows[0].id, 'target');
  assert.deepEqual(attempts, ['primary-test', 'fallback-test']);
  assert.equal(rows.rerank_meta.status, 'served');
  assert.equal(rows.rerank_meta.model, 'fallback-test');
  assert.equal(rows.rerank_meta.attempts, 2);
  assert.ok(Date.now() - startedAt < 260, 'the complete provider chain must obey one wall-clock budget');
});

test('a primary timeout leaves the managed fallback a viable equal share of the total budget', async (t) => {
  const attempts = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      attempts.push(body.model);
      const delay = body.model === 'primary-timeout' ? 700 : 430;
      setTimeout(() => {
        if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/json' });
        if (!res.writableEnded) res.end(JSON.stringify({ results: [
          { index: 1, relevance_score: 0.95 }, { index: 0, relevance_score: 0.05 },
        ] }));
      }, delay);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  process.env.RERANK_ENABLED = 'true';
  process.env.RERANK_PROVIDER = 'cohere';
  process.env.RERANK_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.RERANK_MODEL = 'primary-timeout';
  process.env.RERANK_FALLBACK_URL = '';
  process.env.RERANK_FALLBACK_MODEL = '';
  process.env.RERANK_FALLBACK_MODELS = 'fallback-viable';
  process.env.RERANK_TIMEOUT_MS = '1200';
  process.env.RERANK_TOTAL_TIMEOUT_MS = '1200';
  process.env.RERANK_MAX_ATTEMPTS_TOTAL = '2';
  process.env.RERANK_RETRIES = '0';
  process.env.RERANK_FALLBACK_RESERVE_MS = '';
  const { rerank } = await import(`../../src/memory/reranker.js?equal-share=${Date.now()}`);

  const rows = await rerank('target fact', [
    { id: 'distractor', content: 'unrelated' }, { id: 'target', content: 'target fact' },
  ], { topN: 2 });

  assert.equal(rows[0].id, 'target');
  assert.deepEqual(attempts, ['primary-timeout', 'fallback-viable']);
  assert.equal(rows.rerank_meta.status, 'served');
  assert.equal(rows.rerank_meta.model, 'fallback-viable');
  assert.equal(rows.rerank_meta.attempts, 2);
});

test('reranker can fail over to a distinct endpoint and model', async (t) => {
  const primary = http.createServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'gpu unavailable' }));
  });
  const fallbackBodies = [];
  const fallback = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      fallbackBodies.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: [
        { index: 1, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.1 },
      ] }));
    });
  });
  await new Promise((resolve) => primary.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => fallback.listen(0, '127.0.0.1', resolve));
  t.after(() => Promise.all([
    new Promise((resolve) => primary.close(resolve)),
    new Promise((resolve) => fallback.close(resolve)),
  ]));

  process.env.RERANK_ENABLED = 'true';
  process.env.RERANK_PROVIDER = 'cohere';
  process.env.RERANK_URL = `http://127.0.0.1:${primary.address().port}`;
  process.env.RERANK_MODEL = 'bge-reranker-v2-m3';
  process.env.RERANK_FALLBACK_URL = `http://127.0.0.1:${fallback.address().port}`;
  process.env.RERANK_FALLBACK_PROVIDER = 'cohere';
  process.env.RERANK_FALLBACK_MODEL = 'voyageai/rerank-2.5-lite';
  process.env.RERANK_FALLBACK_MODELS = '';
  process.env.RERANK_PROJECT_TO_CHARS = '400';
  process.env.RERANK_TIMEOUT_MS = '500';
  process.env.RERANK_TOTAL_TIMEOUT_MS = '800';
  process.env.RERANK_MAX_ATTEMPTS_TOTAL = '2';
  process.env.RERANK_RETRIES = '0';
  const { rerank } = await import(`../../src/memory/reranker.js?route=${Date.now()}`);

  const rows = await rerank('target', [
    { id: 'other', content: 'unrelated'.repeat(400) },
    { id: 'target', content: 'target' },
  ], { topN: 2 });

  assert.equal(rows[0].id, 'target');
  assert.equal(rows.rerank_meta.status, 'served');
  assert.equal(rows.rerank_meta.model, 'voyageai/rerank-2.5-lite');
  assert.equal(rows.rerank_meta.route, 'fallback');
  assert.equal(fallbackBodies.length, 1);
  assert.equal(fallbackBodies[0].model, 'voyageai/rerank-2.5-lite');
  assert.equal(Object.hasOwn(fallbackBodies[0], 'project_to_chars'), false);
  assert.equal(fallbackBodies[0].documents[0].length, 2000);
});

test('self-hosted primary reranks the complete wide pool in one request', async (t) => {
  const bodies = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      bodies.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: body.documents.map((document, index) => ({
        index,
        relevance_score: document.includes('unique target') ? 0.99 : 0.01,
      })) }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  process.env.RERANK_ENABLED = 'true';
  process.env.RERANK_PROVIDER = 'cohere';
  process.env.RERANK_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.RERANK_MODEL = 'bge-reranker-v2-m3';
  process.env.RERANK_FALLBACK_URL = '';
  process.env.RERANK_FALLBACK_MODEL = '';
  process.env.RERANK_FALLBACK_MODELS = '';
  process.env.RERANK_PRIMARY_SHARDS = '1';
  process.env.RERANK_PRIMARY_SHARD_MIN_DOCS = '18';
  process.env.RERANK_PROJECT_TO_CHARS = '400';
  process.env.RERANK_TOTAL_TIMEOUT_MS = '800';
  process.env.RERANK_MAX_ATTEMPTS_TOTAL = '1';
  process.env.RERANK_RETRIES = '0';
  const { rerank } = await import(`../../src/memory/reranker.js?shards=${Date.now()}`);
  const candidates = Array.from({ length: 21 }, (_, index) => ({
    id: `row-${index}`,
    content: index === 20 ? `${'late filler '.repeat(220)}unique target` : `noise ${index}`,
  }));

  const rows = await rerank('unique target', candidates, { topN: 15 });
  assert.equal(rows[0].id, 'row-20');
  assert.equal(rows.rerank_meta.status, 'served');
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].documents.length, 21);
  assert.equal(bodies[0].project_to_chars, 400);
  assert.ok(bodies[0].documents.at(-1).length > 2000);
  assert.match(bodies[0].documents.at(-1), /unique target$/);
});
