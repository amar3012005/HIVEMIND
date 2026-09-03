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

test('candidate generation retries when every eligible subject hits a provider failure', async () => {
  let runUpdated = false;
  const lifecycle = new DurableDreamLifecycle({
    prisma: {
      subjectProfile: { findMany: async () => [{ id: 'profile-1', displayName: 'Paolo', aliases: [], subjectType: 'person' }] },
      cognitionStep: { findUnique: async () => ({ outputReceipt: { bundles: [{ subject_profile_id: 'profile-1', memory_ids: ['memory-1', 'memory-2'] }] } }) },
      memory: { findMany: async () => [{ id: 'memory-1' }, { id: 'memory-2' }] },
      dreamCandidate: { upsert: async () => { throw new Error('candidate must not be persisted'); } },
      cognitionRun: { update: async () => { runUpdated = true; } },
    },
    cognitionLoop: { _llmCanonicalFact: async () => { throw new Error('provider unavailable'); } },
    logger: { warn: () => {} },
  });

  await assert.rejects(
    lifecycle._generate_candidates({ id: 'run-1', orgId: '47e2ba84-1b9f-4e1b-804b-7bd77d4eea0f', pipelineVersion: 2 }),
    (error) => error.message === 'candidate_generation_provider_unavailable' && error.retryable === true,
  );
  assert.equal(runUpdated, false);
});

test('workflow retry exhaustion closes the authoritative run without publishing', async () => {
  const run = { id: '11111111-1111-4111-8111-111111111111', status: 'running', currentStage: 'generate-candidates', startedAt: new Date(Date.now() - 1000) };
  let update;
  const lifecycle = new DurableDreamLifecycle({ prisma: { cognitionRun: {
    findUnique: async () => run,
    update: async ({ data }) => { update = data; return { ...run, ...data }; },
  } } });
  await lifecycle.failRun({ run_id: run.id, failed_stage: 'generate-candidates', failure_code: 'candidate_generation_provider_unavailable' });
  assert.equal(update.status, 'error');
  assert.equal(update.recoveryStatus, 'retry_exhausted');
  assert.equal(update.terminalReason, 'candidate_generation_provider_unavailable');
  assert.equal(update.currentStage, 'generate-candidates');
});

test('embed stage retries when published memories lack synced vectors', async () => {
  const lifecycle = new DurableDreamLifecycle({
    prisma: {
      dreamCandidate: { findMany: async () => [{ publishedMemoryId: 'm1' }, { publishedMemoryId: 'm2' }] },
      vectorEmbedding: { count: async () => 1 },
      cognitionRun: { update: async () => ({}) },
    },
  });
  await assert.rejects(
    lifecycle._embed({ id: 'run-1' }),
    (error) => error.message === 'vector_coverage_incomplete' && error.retryable === true,
  );
});

test('a delayed finalize retry cannot overwrite a terminal failed run', async () => {
  const run = { id: '11111111-1111-4111-8111-111111111111', status: 'error', currentStage: 'generate-candidates', pipelineVersion: 2, cancelledAt: null };
  let stepLookup = false;
  const lifecycle = new DurableDreamLifecycle({ prisma: {
    cognitionRun: { findUnique: async () => run },
    cognitionStep: { findUnique: async () => { stepLookup = true; } },
  } });
  const receipt = await lifecycle.executeStage({ run_id: run.id, stage: 'finalize' });
  assert.equal(receipt.status, 'error');
  assert.equal(receipt.stage, 'generate-candidates');
  assert.equal(stepLookup, false);
});
