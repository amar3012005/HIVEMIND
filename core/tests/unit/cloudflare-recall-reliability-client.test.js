import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudflareRecallReliabilityClient } from '../../src/memory/cloudflare-recall-reliability-client.js';

test('recall reliability flag fails closed and returns explicit enabled state', async () => {
  const previous = { enabled: process.env.RECALL_PARALLEL_RELIABILITY_ENABLED,
    url: process.env.CANONICAL_PROJECTION_WORKFLOW_URL, secret: process.env.CANONICAL_PROJECTION_WORKFLOW_SECRET };
  process.env.RECALL_PARALLEL_RELIABILITY_ENABLED = 'true';
  process.env.CANONICAL_PROJECTION_WORKFLOW_URL = 'https://flags.example.test';
  process.env.CANONICAL_PROJECTION_WORKFLOW_SECRET = 'test-secret';
  try {
    const calls = [];
    const client = new CloudflareRecallReliabilityClient({ fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ enabled: true }) };
    } });
    assert.equal(await client.enabledFor({ orgId: 'org-1', userId: 'user-1' }), true);
    assert.match(calls[0].url, /\/recall-enabled\?/);
    assert.equal(calls[0].init.headers.authorization, 'Bearer test-secret');
    const closed = new CloudflareRecallReliabilityClient({ fetchImpl: async () => { throw new Error('down'); }, logger: { warn() {} } });
    assert.equal(await closed.enabledFor({ orgId: 'org-1', userId: 'user-1' }), false);
  } finally {
    if (previous.enabled === undefined) delete process.env.RECALL_PARALLEL_RELIABILITY_ENABLED; else process.env.RECALL_PARALLEL_RELIABILITY_ENABLED = previous.enabled;
    if (previous.url === undefined) delete process.env.CANONICAL_PROJECTION_WORKFLOW_URL; else process.env.CANONICAL_PROJECTION_WORKFLOW_URL = previous.url;
    if (previous.secret === undefined) delete process.env.CANONICAL_PROJECTION_WORKFLOW_SECRET; else process.env.CANONICAL_PROJECTION_WORKFLOW_SECRET = previous.secret;
  }
});
