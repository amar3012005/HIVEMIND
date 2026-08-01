import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveAuthorityDecision } from '../../src/hq-runtime/native-engine.js';

test('HQ dispatch cannot bypass the checkpointed playbook executor', async () => {
  const source = await readFile(new URL('../../src/hq-runtime/native-engine.js', import.meta.url), 'utf8');
  assert.equal(source.includes('hyperWorkOrder.create'), false);
  assert.equal(source.includes('selectSpecialistRoomTag'), false);
  assert.match(source, /No checkpointed lifecycle is installed for this work/);
});

test('authority decisions are resolved only from playbook data and organization policy', () => {
  const stage = { authority_gate: 'opaque-gate', authority_policy_key: 'opaque-policy' };
  assert.deepEqual(resolveAuthorityDecision(stage, { 'opaque-policy': 'manual' }), {
    gate: 'opaque-gate', policyKey: 'opaque-policy', autoGrant: false,
  });
  assert.equal(resolveAuthorityDecision(stage, { 'opaque-policy': 'auto' }).autoGrant, true);
  assert.equal(resolveAuthorityDecision({}, { 'opaque-policy': 'auto' }).autoGrant, false);
});
