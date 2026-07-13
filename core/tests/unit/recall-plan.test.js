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
  const full = resolveRecallPlan({ mode: 'full', include_live: true });
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
  assert.equal(resolveRecallPlan({ mode: 'full' }).expand_evidence, true);
});
