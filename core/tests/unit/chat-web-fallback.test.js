import test from 'node:test';
import assert from 'node:assert/strict';
import { publicWebFallbackEligible, webResultPacket } from '../../src/agent/web-fallback.js';

const plan = { needs_web: true, web_fallback: { allowed: true, query: 'current Acme pricing', reason: 'current_public' } };

test('public web is recall-first and never treats a retrieval outage as a knowledge gap', () => {
  assert.equal(publicWebFallbackEligible({ plan, coverage: { complete: false }, hasRuntime: true, remainingMs: 1000 }), true);
  assert.equal(publicWebFallbackEligible({ plan, coverage: { complete: true }, hasRuntime: true, remainingMs: 1000 }), false);
  assert.equal(publicWebFallbackEligible({ plan, coverage: { complete: false, retrieval_timed_out: true }, hasRuntime: true, remainingMs: 1000 }), false);
  assert.equal(publicWebFallbackEligible({ plan, coverage: { complete: false, retrieval_unavailable: true }, hasRuntime: true, remainingMs: 1000 }), false);
});

test('public web packet retains bounded content, URLs and retrieval time for synthesis and explicit save', () => {
  const packet = webResultPacket({
    id: 'job-1', status: 'succeeded', completed_at: '2026-08-26T10:00:00Z',
    results: [{ title: 'Pricing', url: 'https://example.com/pricing', snippet: 'Public price is EUR 10.', score: 0.9 }],
  }, 'current Acme pricing');
  assert.equal(packet.sourceSections.length, 1);
  assert.equal(packet.sourceSections[0].url, 'https://example.com/pricing');
  assert.equal(packet.citations[0].source_type, 'public_web');
  assert.equal(packet.citations[0].retrieved_at, '2026-08-26T10:00:00Z');
});
