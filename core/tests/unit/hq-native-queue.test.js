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
  assert.deepEqual(resolveAuthorityDecision(stage, { gate_overrides: { 'opaque-policy': 'manual' } }), {
    gate: 'opaque-gate', policyKey: 'opaque-policy', preference: 'manual', autoGrant: false, manualOnly: false, autoWithheld: false,
  });
  // Unattended external writes require an explicit opt-in; a stored 'auto' alone
  // must NOT authorise a publish with no human present.
  assert.equal(resolveAuthorityDecision(stage, { gate_overrides: { 'opaque-policy': 'auto' } }).autoGrant, false);
  assert.equal(resolveAuthorityDecision(stage, { gate_overrides: { 'opaque-policy': 'auto' } }).autoWithheld, true);
  process.env.HQ_ALLOW_UNATTENDED_EXTERNAL = 'true';
  try {
    assert.equal(resolveAuthorityDecision(stage, { gate_overrides: { 'opaque-policy': 'auto' } }).autoGrant, true);
  } finally { delete process.env.HQ_ALLOW_UNATTENDED_EXTERNAL; }
  assert.equal(resolveAuthorityDecision({}, { gate_overrides: { 'opaque-policy': 'auto' } }).autoGrant, false);
});
