import test from 'node:test';
import assert from 'node:assert/strict';
import {
  admitProjectionAttempt,
  beginProjectionStage,
  finishProjectionStage,
  projectionFailureCode,
  projectionAttemptStatus,
  projectionWorkflowInstanceId,
} from '../../src/memory/canonical-projection-attempts.js';

const memoryId = '74fb72fc-08da-41cc-8c56-598eae67bfee';
const orgId = '22222222-2222-4222-8222-222222222222';

function attempt(overrides = {}) {
  return {
    id: 'a1', memoryId, organizationId: orgId, processingVersion: 1,
    admittedMode: 'shadow', executor: 'cloudflare', workflowInstanceId: projectionWorkflowInstanceId(memoryId, 1),
    status: 'ADMISSION_PENDING', currentStage: null, stageReceipts: {}, retryCount: 0,
    createdAt: new Date('2026-09-02T00:00:00Z'), updatedAt: new Date('2026-09-02T00:00:00Z'), completedAt: null, lastError: null,
    ...overrides,
  };
}

test('projection attempt identity is stable per memory processing version', async () => {
  const row = attempt();
  const prisma = { memoryProjectionAttempt: {
    create: async () => { const error = new Error('unique'); error.code = 'P2002'; throw error; },
    findUnique: async ({ where }) => {
      assert.deepEqual(where, { memoryId_processingVersion: { memoryId, processingVersion: 1 } });
      return row;
    },
  } };
  const result = await admitProjectionAttempt({ prisma, memoryId, organizationId: orgId, admittedMode: 'shadow' });
  assert.equal(result.reused, true);
  assert.equal(result.attempt.workflowInstanceId, 'claim-74fb72fc-08da-41cc-8c56-598eae67bfee-v1');
});

test('stages advance once, return stable duplicate receipts, and reject stale callbacks', async () => {
  const load = attempt();
  const prisma = { memoryProjectionAttempt: {
    findUnique: async () => load,
    updateMany: async () => ({ count: 1 }),
    update: async ({ data }) => ({ ...load, ...data }),
  } };
  const admitted = await beginProjectionStage({ prisma, memoryId, processingVersion: 1, organizationId: orgId, admittedMode: 'shadow', stage: 'load' });
  assert.equal(admitted.accepted, true);
  const afterLoad = await finishProjectionStage({ prisma, attempt: load, stage: 'load', receipt: { ok: true } });
  assert.equal(afterLoad.status, 'ACTIVE');
  const duplicate = await beginProjectionStage({ prisma: { memoryProjectionAttempt: { findUnique: async () => attempt({ currentStage: 'load', stageReceipts: { load: { ok: true } }, status: 'ACTIVE' }) } }, memoryId, processingVersion: 1, organizationId: orgId, admittedMode: 'shadow', stage: 'load' });
  assert.equal(duplicate.duplicate, true);
  const stale = await beginProjectionStage({ prisma: { memoryProjectionAttempt: { findUnique: async () => load } }, memoryId, processingVersion: 1, organizationId: orgId, admittedMode: 'shadow', stage: 'persist' });
  assert.equal(stale.reason, 'stale_stage');
});

test('a concurrent stage callback loses the database claim before any projection work starts', async () => {
  const result = await beginProjectionStage({
    prisma: { memoryProjectionAttempt: {
      findUnique: async () => attempt({ status: 'ACTIVE' }),
      updateMany: async () => ({ count: 0 }),
    } },
    memoryId, processingVersion: 1, organizationId: orgId, admittedMode: 'shadow', stage: 'load',
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'stage_busy');
});

test('status projection contains operational metadata only', () => {
  const status = projectionAttemptStatus(attempt({ status: 'FAILED', lastError: 'projection_failed' }));
  assert.deepEqual(Object.keys(status).sort(), ['completed_at', 'created_at', 'current_stage', 'executor', 'failure_code', 'memory_id', 'mode', 'processing_version', 'retry_count', 'status', 'updated_at', 'workflow_instance_id']);
  assert.equal(status.failure_code, 'projection_failed');
});

test('attempt status records a bounded code rather than arbitrary Worker text', () => {
  assert.equal(projectionFailureCode('workflow_failed: provider response included confidential content'), 'workflow_failed');
  assert.equal(projectionFailureCode('', 'stage_execution_failed'), 'stage_execution_failed');
});
