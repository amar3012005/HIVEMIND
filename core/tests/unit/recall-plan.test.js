import test from 'node:test';
import assert from 'node:assert/strict';
import { isLiveExpansionEligible, resolveRecallPlan } from '../../src/memory/recall-router.js';

test('legacy recall modes preserve their existing event-driven behavior', () => {
  const plan = resolveRecallPlan({ mode: 'auto' });
  assert.equal(plan.legacy, true);
  assert.equal(plan.mode, 'fact');
  assert.equal(plan.expand_evidence, true);
  assert.equal(plan.include_live, true);
});

test('explicit fact stays on the fast recall path', () => {
  const plan = resolveRecallPlan({ mode: 'fact', include_live: true, temporal: 'known_at' });
  assert.equal(plan.expand_evidence, false);
  assert.equal(plan.include_live, false);
  assert.equal(plan.max_graph_hops, 0);
  assert.equal(plan.max_memories, 5);
  assert.equal(plan.context_budget, 2_000);
  assert.equal(plan.latency_budget_ms, 1_500);
  assert.equal(plan.temporal, 'known_at');
});

test('explicit explain and full plans are bounded', () => {
  const explain = resolveRecallPlan({ mode: 'explain' });
  const full = resolveRecallPlan({ mode: 'full', explicit_mode: true, include_live: true });
  assert.deepEqual(
    [explain.context_budget, explain.max_graph_hops, explain.latency_budget_ms],
    [8_000, 1, 3_000],
  );
  assert.deepEqual(
    [full.context_budget, full.max_graph_hops, full.include_live, full.latency_budget_ms],
    [24_000, 1, true, 3_000],
  );
});

test('live expansion requires a surface policy and an evidence anchor or explicit intent', () => {
  const empty = { docIds: [], platforms: [] };
  assert.equal(isLiveExpansionEligible({ includeLive: true, inspection: empty }), false);
  assert.equal(isLiveExpansionEligible({ includeLive: true, inspection: empty, liveIntent: true }), true);
  assert.equal(isLiveExpansionEligible({
    includeLive: true,
    inspection: { docIds: ['doc-1'], platforms: [] },
    surfacePolicyAllowsLive: false,
  }), false);
});

test('explicit explain and full are source-first while fact remains anchor-only', () => {
  assert.equal(resolveRecallPlan({ mode: 'fact' }).expand_evidence, false);
  assert.equal(resolveRecallPlan({ mode: 'explain' }).expand_evidence, true);
  assert.equal(resolveRecallPlan({ mode: 'full', explicit_mode: true }).expand_evidence, true);
});

test('full mode requires explicit caller provenance', () => {
  const inferred = resolveRecallPlan({ mode: 'full' });
  const explicit = resolveRecallPlan({ mode: 'full', explicit_mode: true });
  assert.equal(inferred.mode, 'explain');
  assert.equal(inferred.mode_downgraded, 'full_requires_explicit_caller');
  assert.equal(explicit.mode, 'full');
  assert.equal(explicit.mode_downgraded, null);
});

test('timeline is a bounded version-history operation on the shared plan', () => {
  const plan = resolveRecallPlan({ mode: 'explain', operation: 'timeline', limit: 1000 });
  assert.equal(plan.operation, 'timeline');
  assert.equal(plan.max_memories, 50);
});

test('typed source and time blocks normalize legacy arguments with explicit precedence', () => {
  const plan = resolveRecallPlan({
    mode: 'explain',
    source_document_id: 'explicit-doc',
    source: { document_id: 'inferred-doc', title: 'Brochure.pdf' },
    known_at: '2026-07-01T12:00:00Z',
    time: { valid_at: '2025-01-01T00:00:00Z' },
  });
  assert.deepEqual(plan.source, {
    requested: true,
    document_id: 'explicit-doc',
    title: 'Brochure.pdf',
  });
  assert.equal(plan.time.mode, 'known_at');
  assert.equal(plan.time.known_at, '2026-07-01T12:00:00.000Z');
  assert.equal(plan.temporal, 'known_at');
});

test('typed temporal ranges are validated and server-clamped', () => {
  const plan = resolveRecallPlan({
    mode: 'explain',
    time: { range: { start: '2020-01-01T00:00:00Z', end: '2026-01-01T00:00:00Z' } },
  });
  assert.equal(plan.time.mode, 'range');
  assert.equal(plan.time.range.clamped, true);
  assert.ok(new Date(plan.time.range.end) - new Date(plan.time.range.start) <= 366 * 24 * 60 * 60 * 1000);
  assert.equal(resolveRecallPlan({ mode: 'explain', time: { valid_at: 'invalid' } }).time.mode, 'current');
});

test('source identifiers are normalized and bounded by the server', () => {
  const plan = resolveRecallPlan({
    mode: 'explain',
    source_document_id: `  ${'d'.repeat(200)}  `,
    source_title: ` ${'t'.repeat(700)} `,
  });
  assert.equal(plan.source.document_id.length, 128);
  assert.equal(plan.source.title.length, 512);
  assert.equal(plan.source.requested, true);
});
