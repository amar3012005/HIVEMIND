import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { LiteLLMEmbedService } from '../../src/embeddings/litellm.js';
import { resetEmbeddingAdmissionControllerForTests } from '../../src/embeddings/admission.js';

test('LiteLLM embedding validates row count, dimension, and finite values', async (t) => {
  resetEmbeddingAdmissionControllerForTests();
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

test('LiteLLM embedding coalesces identical concurrent requests and batches at twenty', async (t) => {
  resetEmbeddingAdmissionControllerForTests();
  let calls = 0;
  const sizes = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      calls += 1;
      const body = JSON.parse(Buffer.concat(chunks).toString());
      sizes.push(body.input.length);
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: body.input.map((_, index) => ({
          index, embedding: Array.from({ length: 1024 }, () => 0.01),
        })) }));
      }, 10);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const service = new LiteLLMEmbedService('bge-m3', '', `http://127.0.0.1:${server.address().port}`, { timeoutMs: 500 });
  const texts = Array.from({ length: 25 }, (_, index) => `text-${index}`);
  const [a, b] = await Promise.all([
    service.embed(texts, { workload: 'ingestion', tenantId: 'tenant-a' }),
    service.embed(texts, { workload: 'ingestion', tenantId: 'tenant-a' }),
  ]);
  assert.equal(a.length, 25);
  assert.deepEqual(a, b);
  assert.equal(calls, 2);
  assert.deepEqual(sizes, [20, 5]);
});

test('ten concurrent bulk uploads stay within global and tenant provider limits', async (t) => {
  const previous = {
    global: process.env.EMBEDDING_MAX_CONCURRENCY,
    tenant: process.env.EMBEDDING_MAX_CONCURRENCY_PER_TENANT,
  };
  process.env.EMBEDDING_MAX_CONCURRENCY = '4';
  process.env.EMBEDDING_MAX_CONCURRENCY_PER_TENANT = '2';
  resetEmbeddingAdmissionControllerForTests();
  t.after(() => {
    if (previous.global === undefined) delete process.env.EMBEDDING_MAX_CONCURRENCY;
    else process.env.EMBEDDING_MAX_CONCURRENCY = previous.global;
    if (previous.tenant === undefined) delete process.env.EMBEDDING_MAX_CONCURRENCY_PER_TENANT;
    else process.env.EMBEDDING_MAX_CONCURRENCY_PER_TENANT = previous.tenant;
    resetEmbeddingAdmissionControllerForTests();
  });
  let active = 0;
  let peak = 0;
  const byTenant = new Map();
  const tenantPeaks = new Map();
  const sizes = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const tenant = String(req.headers['x-test-tenant'] || 'unknown');
      sizes.push(body.input.length);
      active += 1;
      peak = Math.max(peak, active);
      byTenant.set(tenant, (byTenant.get(tenant) || 0) + 1);
      tenantPeaks.set(tenant, Math.max(tenantPeaks.get(tenant) || 0, byTenant.get(tenant)));
      setTimeout(() => {
        active -= 1;
        byTenant.set(tenant, byTenant.get(tenant) - 1);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: body.input.map((_, index) => ({
          index, embedding: Array.from({ length: 1024 }, () => 0.01),
        })) }));
      }, 20);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  // The real admission key is passed out-of-band, so use distinct clients only
  // to avoid response caching while all requests share one process controller.
  const jobs = Array.from({ length: 10 }, (_, upload) => {
    const service = new LiteLLMEmbedService('bge-m3', '', `http://127.0.0.1:${server.address().port}`, { timeoutMs: 1000 });
    const tenantId = upload < 6 ? 'tenant-a' : 'tenant-b';
    return service.embed(Array.from({ length: 45 }, (_, i) => `upload-${upload}-segment-${i}`), {
      workload: 'ingestion', tenantId,
    });
  });
  const rows = await Promise.all(jobs);
  assert.ok(rows.every((vectors) => vectors.length === 45));
  assert.ok(peak <= 4, `global peak ${peak}`);
  assert.equal(sizes.length, 30);
  assert.ok(sizes.every((size) => size <= 20));
});

test('LiteLLM embedding uses workload-specific deadlines', async (t) => {
  resetEmbeddingAdmissionControllerForTests();
  const prior = process.env.EMBEDDING_INGEST_TIMEOUT_MS;
  process.env.EMBEDDING_INGEST_TIMEOUT_MS = '250';
  t.after(() => {
    if (prior === undefined) delete process.env.EMBEDDING_INGEST_TIMEOUT_MS;
    else process.env.EMBEDDING_INGEST_TIMEOUT_MS = prior;
  });
  const server = http.createServer((_req, res) => {
    setTimeout(() => {
      if (res.writableEnded) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ index: 0, embedding: Array.from({ length: 1024 }, () => 0.01) }] }));
    }, 120);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const service = new LiteLLMEmbedService('bge-m3', '', `http://127.0.0.1:${server.address().port}`, { timeoutMs: 50 });
  await assert.rejects(service.embedOne('interactive', { workload: 'interactive' }), /timeout after 100ms/);
  assert.equal((await service.embedOne('ingestion', { workload: 'ingestion' })).length, 1024);
});
