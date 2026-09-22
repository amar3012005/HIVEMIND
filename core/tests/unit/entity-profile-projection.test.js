import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEntityProfileTimeline, entityProfileMode } from '../../src/memory/entity-profile-projection.js';
import { validateEntityProfileDecision } from '../../src/memory/entity-profile-jev.js';
import { entityProfileWorkflowInstanceId } from '../../src/memory/entity-profile-projection-attempts.js';

test('entity profile projection accepts only an explicit Worker admission mode', () => {
  assert.equal(entityProfileMode(), 'off');
  assert.equal(entityProfileMode({ evaluatedMode: 'dynamic_auto' }), 'dynamic_auto');
  assert.equal(entityProfileMode({ evaluatedMode: 'untrusted' }), 'off');
});

test('JEV decisions are constrained to the narrow entity-profile contract', () => {
  assert.deepEqual(validateEntityProfileDecision({ durable: true, fact_class: 'dynamic', duplicate: false, confidence_tier: 'high', contradiction: false, action: 'auto_apply' }), {
    durable: true, fact_class: 'dynamic', duplicate: false, confidence_tier: 'high', contradiction: false, action: 'auto_apply',
  });
  assert.equal(validateEntityProfileDecision({ fact_class: 'invented', action: 'write_everything' }), null);
});

test('attempt workflow identity is stable per entity and source watermark', () => {
  const one = entityProfileWorkflowInstanceId('00000000-0000-4000-8000-000000000001', 'memory-a-v1');
  assert.equal(one, entityProfileWorkflowInstanceId('00000000-0000-4000-8000-000000000001', 'memory-a-v1'));
  assert.notEqual(one, entityProfileWorkflowInstanceId('00000000-0000-4000-8000-000000000001', 'memory-b-v1'));
});

test('entity profile timeline preserves valid time separately from HIVE recorded time', () => {
  const timeline = buildEntityProfileTimeline([{
    id: 'fact-1', factClass: 'relationship', factKey: 'works_with', status: 'review', decision: 'review',
    value: { predicate: 'works_with' }, freshnessAt: new Date('2026-01-15T00:00:00Z'),
    createdAt: new Date('2026-02-01T00:00:00Z'), updatedAt: new Date('2026-02-01T00:00:00Z'),
    evidence: [{ id: 'evidence-1' }], claim: { predicate: { name: 'works_with' } },
    reviews: [{ id: 'review-1', kind: 'relationship', status: 'approved', createdAt: new Date('2026-02-01T00:00:00Z'), resolvedAt: new Date('2026-02-03T00:00:00Z') }],
  }]);
  assert.equal(timeline[0].kind, 'fact');
  assert.equal(timeline[0].valid_at.toISOString(), '2026-01-15T00:00:00.000Z');
  assert.equal(timeline[0].recorded_at.toISOString(), '2026-02-01T00:00:00.000Z');
  assert.deepEqual(timeline.map((event) => event.kind), ['fact', 'review_requested', 'review_resolved']);
});
