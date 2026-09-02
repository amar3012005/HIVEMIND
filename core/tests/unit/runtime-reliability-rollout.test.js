import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RUNTIME_RELIABILITY_RELEASE_0,
  collectRuntimeReliabilityBaseline,
  getRuntimeRollout,
  isRuntimeReliabilityKillSwitched,
  recordRuntimeReleaseEvidence,
  setRuntimeRollout,
} from '../../src/hq-runtime/reliability-rollout.js';

test('Runtime reliability rollout defaults OFF and the global kill switch wins', async () => {
  const prisma = {
    runtimeRolloutPolicy: { findUnique: async () => ({ mode: 'ENFORCE', metadata: { canary: true }, updatedAt: 'now' }) },
  };
  const rollout = await getRuntimeRollout({ prisma, orgId: 'org-1', env: { RUNTIME_RELIABILITY_KILL_SWITCH: 'true' } });
  assert.equal(rollout.feature, RUNTIME_RELIABILITY_RELEASE_0);
  assert.equal(rollout.configuredMode, 'ENFORCE');
  assert.equal(rollout.effectiveMode, 'KILL_SWITCHED');
  assert.equal(isRuntimeReliabilityKillSwitched({ RUNTIME_RELIABILITY_KILL_SWITCH: 'yes' }), true);
  assert.equal(isRuntimeReliabilityKillSwitched({ RUNTIME_RELIABILITY_KILL_SWITCH: 'false' }), false);
});

test('Runtime reliability rollout persists only recognized configured modes', async () => {
  let call = null;
  const prisma = {
    runtimeRolloutPolicy: {
      upsert: async (args) => {
        call = args;
        return { mode: args.create.mode, metadata: args.create.metadata, updatedAt: 'now' };
      },
    },
  };
  const result = await setRuntimeRollout({ prisma, orgId: 'org-1', requestedMode: 'shadow', metadata: { release: 0 } });
  assert.equal(result.configuredMode, 'SHADOW');
  assert.deepEqual(call.where, { orgId_feature: { orgId: 'org-1', feature: RUNTIME_RELIABILITY_RELEASE_0 } });
  assert.equal(call.create.mode, 'SHADOW');
});

test('Runtime baseline records current counts as metrics and evidence is append-only', async () => {
  const metrics = [];
  let evidence = null;
  const count = async () => 2;
  const prisma = {
    hqRuntime: { findFirst: async () => ({ id: 'runtime-1', epoch: 'epoch-1', state: 'PAUSED' }) },
    hqSchedule: { count },
    hqRuntimeEvent: { count },
    hqCycle: { count },
    runtimePlaybookRun: { count },
    hyperWorkOrder: { count },
    campaignActionAttempt: { count },
    taraCallAttempt: { count },
    runtimePerformanceMetric: {
      aggregate: async ({ where }) => where.metric === 'hq_cycle_latency'
        ? { _avg: { value: 12.5 } }
        : { _sum: { value: 4 } },
      create: async ({ data }) => { metrics.push(data); return data; },
    },
    runtimeReleaseEvidence: { create: async ({ data }) => { evidence = data; return { id: 'evidence-1', ...data }; } },
  };
  const baseline = await collectRuntimeReliabilityBaseline({ prisma, orgId: 'org-1', now: new Date('2026-09-02T00:00:00Z') });
  assert.equal(baseline.runtime.state, 'PAUSED');
  assert.equal(baseline.metrics.wakes, 2);
  assert.equal(baseline.metrics.avg_cycle_latency_ms, 12.5);
  assert.equal(baseline.metrics.noop_cycles, 4);
  assert.equal(metrics.length, Object.keys(baseline.metrics).length);
  await recordRuntimeReleaseEvidence({
    prisma,
    orgId: 'org-1',
    releaseSha: '0123456789abcdef',
    metrics: baseline,
    observedFrom: baseline.observedFrom,
    observedTo: baseline.observedTo,
  });
  assert.equal(evidence.feature, RUNTIME_RELIABILITY_RELEASE_0);
  assert.equal(evidence.releaseSha, '0123456789abcdef');
});
