import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertHqTransition,
  normalizeAuthorityPolicy,
  validateWorkResultPacket,
} from '../../src/hq-runtime/contracts.js';

test('HQ runtime permits only explicit state transitions', () => {
  assert.doesNotThrow(() => assertHqTransition('INACTIVE', 'OBSERVING'));
  assert.doesNotThrow(() => assertHqTransition('WAITING', 'REVIEWING'));
  assert.throws(
    () => assertHqTransition('INACTIVE', 'DELEGATING'),
    /hq_runtime_invalid_transition/,
  );
});

test('HQ authority defaults external consequences to approval', () => {
  assert.deepEqual(normalizeAuthorityPolicy(), {
    internal_autonomy: true,
    external_writes: 'approval_required',
    spending: 'approval_required',
    deletion: 'approval_required',
    policy_changes: 'approval_required',
    emergency_stop: true,
  });
});

test('specialist result packets are compact and normalized', () => {
  assert.deepEqual(validateWorkResultPacket({
    result: { finding: 'conversion path missing' },
    actions: [{ type: 'research' }],
    recommendation: 'ITERATE',
    source_refs: ['baseline:1'],
  }), {
    result: { finding: 'conversion path missing' },
    actions: [{ type: 'research' }],
    metrics: {},
    cost: {},
    failures: [],
    blockers: [],
    recommendation: 'iterate',
    source_refs: ['baseline:1'],
  });
  assert.throws(
    () => validateWorkResultPacket({ recommendation: 'launch_everything' }),
    /hq_work_result_invalid_recommendation/,
  );
});
