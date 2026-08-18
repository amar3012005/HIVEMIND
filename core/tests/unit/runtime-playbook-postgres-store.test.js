import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresRuntimeStore } from '../../src/runtime-playbooks/postgres-store.js';

function fakePrisma(row) {
  const tx = {
    runtimePlaybookRun: {
      findFirst: async () => row,
      updateMany: async ({ where, data }) => {
        if (row.status !== where.status || row.checkpointSequence !== where.checkpointSequence) return { count: 0 };
        Object.assign(row, {
          ...data,
          checkpointSequence: row.checkpointSequence + 1,
          version: (row.version || 0) + 1,
        });
        return { count: 1 };
      },
    },
    runtimePlaybookCheckpoint: { create: async () => {} },
  };
  return {
    $transaction: async (callback) => callback(tx),
    runtimePlaybookRun: {
      findFirst: async () => ({ ...row, artifacts: [], authorities: [] }),
    },
  };
}

// Real bug, found while root-causing the same production incident that
// motivated stage-executor.js's WAITING_AUTHORITY deadline-reset fix: a
// HARD_DEADLINE intervention leaves `runtime_deadlines[stage].hard_emitted_at`
// set on the run's context. Without clearing it here, resumeIntervention
// flips status back to ACTIVE but the executor's own re-entry guard
// (stage-executor.js, checked before any work runs) sees hard_emitted_at
// still set and immediately fails the SAME run again with the exact same
// verdict — a manual "resume" that can never actually resume.
test('resumeIntervention clears the stuck stage\'s stale deadline state, not just its repair-attempt counter', async () => {
  const row = {
    id: 'run-1', orgId: 'org-1', status: 'NEEDS_INTERVENTION', checkpointSequence: 5,
    currentStageId: 'deliver_outreach',
    context: {
      runtime_repair_attempts: { deliver_outreach: 2 },
      runtime_deadlines: {
        deliver_outreach: { started_at: '2026-08-18T16:44:34.000Z', hard_emitted_at: '2026-08-18T17:07:00.883Z' },
      },
    },
  };
  const store = new PostgresRuntimeStore({ prisma: fakePrisma(row) });
  const result = await store.resumeIntervention('run-1', 'org-1', { expectedCheckpointSequence: 5, resumedBy: 'user-1', reason: 'Retrying after reviewing the drafts.' });
  assert.equal(result.status, 'ACTIVE');
  assert.equal(result.context.runtime_repair_attempts.deliver_outreach, undefined, 'repair counter is cleared (pre-existing behavior)');
  assert.equal(result.context.runtime_deadlines?.deliver_outreach, undefined, 'the stale deadline state for this stage must be cleared too');
});

test('resumeIntervention leaves OTHER stages\' deadline state untouched', async () => {
  const row = {
    id: 'run-1', orgId: 'org-1', status: 'NEEDS_INTERVENTION', checkpointSequence: 1,
    currentStageId: 'deliver_outreach',
    context: {
      runtime_deadlines: {
        deliver_outreach: { started_at: 'old', hard_emitted_at: 'old' },
        research_decision: { started_at: '2026-08-18T00:00:00.000Z' },
      },
    },
  };
  const store = new PostgresRuntimeStore({ prisma: fakePrisma(row) });
  const result = await store.resumeIntervention('run-1', 'org-1', { expectedCheckpointSequence: 1 });
  assert.equal(result.context.runtime_deadlines.deliver_outreach, undefined);
  assert.deepEqual(result.context.runtime_deadlines.research_decision, { started_at: '2026-08-18T00:00:00.000Z' });
});
