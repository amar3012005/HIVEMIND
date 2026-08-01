import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedDelegationField, compileCompletionRequirements, resolveAuthorityDecision } from '../../src/hq-runtime/native-engine.js';

test('delegation fields fit the persisted varchar boundary', () => {
  const criteria = Array.from({ length: 12 }, (_, index) => `criterion-${index}-${'x'.repeat(90)}`).join('; ');
  assert.equal(boundedDelegationField(criteria).length, 500);
});

test('HQ does not infer completion requirements from a work kind', () => {
  const requirements = compileCompletionRequirements({
    kind: 'any_domain_label',
    context: { target: { quantity: 20 } },
  });
  assert.deepEqual(requirements, []);
});

test('todo-authored completion requirements pass through unchanged', () => {
  const requirements = compileCompletionRequirements({
    kind: 'any_domain_label', context: { completion_requirements: [{ type: 'has_min_count', minimum: 4 }] },
  });
  assert.deepEqual(requirements, [{ type: 'has_min_count', minimum: 4 }]);
});

test('authority decisions are resolved only from playbook data and organization policy', () => {
  const stage = { authority_gate: 'opaque-gate', authority_policy_key: 'opaque-policy' };
  assert.deepEqual(resolveAuthorityDecision(stage, { 'opaque-policy': 'manual' }), {
    gate: 'opaque-gate', policyKey: 'opaque-policy', autoGrant: false,
  });
  assert.equal(resolveAuthorityDecision(stage, { 'opaque-policy': 'auto' }).autoGrant, true);
  assert.equal(resolveAuthorityDecision({}, { 'opaque-policy': 'auto' }).autoGrant, false);
});
