import test from 'node:test';
import assert from 'node:assert/strict';
import { promoteWebEvidenceWindow, publicWebFallbackEligible, webResultPacket } from '../../src/agent/web-fallback.js';

const plan = { needs_web: true, web_fallback: { allowed: true, query: 'current Acme pricing', reason: 'current_public' } };

test('public web is recall-first and never treats a retrieval outage as a knowledge gap', () => {
  assert.equal(publicWebFallbackEligible({ plan, coverage: { complete: false }, hasRuntime: true, remainingMs: 1000 }), true);
  assert.equal(publicWebFallbackEligible({ plan, coverage: { complete: true }, hasRuntime: true, remainingMs: 1000 }), false);
  assert.equal(publicWebFallbackEligible({ plan, coverage: { complete: false, retrieval_timed_out: true }, hasRuntime: true, remainingMs: 1000 }), false);
  assert.equal(publicWebFallbackEligible({ plan, coverage: { complete: false, retrieval_unavailable: true }, hasRuntime: true, remainingMs: 1000 }), false);
});

test('successful web evidence is visible inside an already-full synthesis window', () => {
  const evidence = Array.from({ length: 15 }, (_, index) => ({ segment_id: `internal-${index}` }));
  evidence.push({ segment_id: 'web:job:1', content: 'current public result' });
  const ranked = evidence.slice(0, 15).map((row) => ({ kind: 'evidence', segment_id: row.segment_id }));
  promoteWebEvidenceWindow(evidence, ranked, [{ segment_id: 'web:job:1', score: 0.9 }]);
  assert.equal(evidence[0].segment_id, 'web:job:1');
  assert.equal(ranked[0].segment_id, 'web:job:1');
  assert.equal(evidence.length, 16);
});

test('an explicit web request searches once after recall even when internal context exists', () => {
  const explicit = { ...plan, web_fallback: { ...plan.web_fallback, reason: 'explicit_web' } };
  assert.equal(publicWebFallbackEligible({ plan: explicit, coverage: { complete: true }, hasRuntime: true, remainingMs: 1000 }), true);
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
