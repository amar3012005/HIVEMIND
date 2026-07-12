import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRecallPlan } from '../../src/memory/recall-router.js';

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
  assert.equal(plan.context_budget, 2_000);
  assert.equal(plan.temporal, 'known_at');
});

test('explicit explain and full plans are bounded', () => {
  const explain = resolveRecallPlan({ mode: 'explain' });
  const full = resolveRecallPlan({ mode: 'full', include_live: true });
  assert.deepEqual(
    [explain.context_budget, explain.max_graph_hops, explain.latency_budget_ms],
    [8_000, 1, 2_000],
  );
  assert.deepEqual(
    [full.context_budget, full.max_graph_hops, full.include_live, full.latency_budget_ms],
    [24_000, 1, true, 3_000],
  );
});
