import test from 'node:test';
import assert from 'node:assert/strict';
import { entityProfileMode } from '../../src/memory/entity-profile-projection.js';
import { validateEntityProfileDecision } from '../../src/memory/entity-profile-jev.js';
import { entityProfileWorkflowInstanceId } from '../../src/memory/entity-profile-projection-attempts.js';

test('entity profile projection fails closed unless enabled and explicitly admitted', () => {
  assert.equal(entityProfileMode({ evaluatedMode: 'dynamic_auto', env: {} }), 'off');
  assert.equal(entityProfileMode({ evaluatedMode: 'dynamic_auto', env: { ENTITY_PROFILE_PROJECTION_ENABLED: 'true' } }), 'dynamic_auto');
  assert.equal(entityProfileMode({ evaluatedMode: 'dynamic_auto', env: { ENTITY_PROFILE_PROJECTION_ENABLED: 'true', ENTITY_PROFILE_PROJECTION_KILL_SWITCH: 'true' } }), 'off');
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
