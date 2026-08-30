import test from 'node:test';
import assert from 'node:assert/strict';
import { DREAM_PIPELINE_VERSION, DREAM_STAGES, DurableDreamLifecycle, digest, mostRestrictiveVisibility, validateAdmission } from '../../src/memory/durable-dream-lifecycle.js';

test('dream v2 exposes a stable twelve-stage lifecycle', () => {
  assert.equal(DREAM_PIPELINE_VERSION, 2);
  assert.deepEqual(DREAM_STAGES, ['admit','select-subjects','walk-graph','generate-candidates','verify-candidates','persist-cognition','project-derivations','update-profiles','embed','reconcile','publish','finalize']);
});

test('stable digest ignores object insertion order', () => {
  assert.equal(digest({ b: 2, a: [1, 3] }), digest({ a: [1, 3], b: 2 }));
});

test('derived visibility inherits the most restrictive source', () => {
  assert.equal(mostRestrictiveVisibility([{ visibility: 'organization' }, { visibility: 'private' }]), 'private');
  assert.equal(mostRestrictiveVisibility([{ visibility: 'public' }, { visibility: 'project' }]), 'project');
});

test('admission rejects invalid tenant and trigger data permanently', () => {
  assert.throws(() => validateAdmission({ org_id: 'bad', trigger: 'manual', trigger_key: 'x', workflow_instance_id: 'x' }), /invalid_org_id/);
  assert.throws(() => validateAdmission({ org_id: '47e2ba84-1b9f-4e1b-804b-7bd77d4eea0f', trigger: 'unknown', trigger_key: 'x', workflow_instance_id: 'x' }), /invalid_trigger/);
});

test('admission coalesces a second trigger onto the active tenant run', async () => {
  const active = { id: '11111111-1111-4111-8111-111111111111', orgId: '47e2ba84-1b9f-4e1b-804b-7bd77d4eea0f', status: 'running', pipelineVersion: 2, currentStage: 'walk-graph', progress: 18 };
  let creates = 0;
  const lifecycle = new DurableDreamLifecycle({ prisma: {
    organization: { findUnique: async () => ({ id: active.orgId, cognitionOrgEnabled: true, cognitionPersonalEnabled: false, cognitionCrossProjectEnabled: false, profileAutomaintainEnabled: false, subscriptionStatus: 'active', memoryStorageMode: 'hybrid' }) },
    cognitionRun: { findUnique: async () => null, findFirst: async () => active, create: async () => { creates += 1; } },
  } });
  const receipt = await lifecycle.admit({ org_id: active.orgId, trigger: 'manual', trigger_key: 'manual-2', workflow_instance_id: 'dream-test-2', flags: { dream_workflow_v2: true } });
  assert.equal(receipt.run_id, active.id);
  assert.equal(creates, 0);
});
