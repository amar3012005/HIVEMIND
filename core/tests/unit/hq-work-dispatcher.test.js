import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dispatchNextHqWorkOrder,
  reconcileExpiredWorkOrders,
  specialistEventSummary,
  workOrderDisplayMessage,
} from '../../src/hq-runtime/work-dispatcher.js';

function transportResponse(body, status = 200) {
  return async (_url, options) => {
    assert.equal(options.headers['X-API-Key'], 'internal-test-key');
    return {
      ok: status >= 200 && status < 300,
      status,
      body,
      classification: status === 408 || status === 429 || status >= 500
        ? 'transient_response' : 'deterministic_response',
      retryable: status === 408 || status === 429 || status >= 500,
      reconciliation_required: status === 408 || status === 429 || status >= 500,
    };
  };
}

test('HQ Room turn visibly carries scope, authority, dependency, and completion checks', () => {
  const message = workOrderDisplayMessage({
    title: 'Prepare Berlin outreach',
    objective: 'Write one grounded draft for every accepted prospect.',
    input_snapshot: {
      target: { quantity: 10, location: 'Berlin, Germany', sector: 'regulated finance' },
      authority: { mode: 'PREPARE' },
      upstream_result: { deliverables: [{ kind: 'prospect_records' }] },
      completion_requirements: [
        { type: 'email_drafts', minimum: 10, maximum: 10, entity: 'prospect' },
        { type: 'external_actions', maximum: 0 },
      ],
    },
    acceptance_criteria: ['One verified-recipient draft per accepted prospect.'],
  });

  assert.match(message, /HQ WORK ORDER \| Prepare Berlin outreach/);
  assert.match(message, /Quantity: 10/);
  assert.match(message, /Location: Berlin, Germany/);
  assert.match(message, /Use the accepted upstream result/);
  assert.match(message, /Prepare and persist internal deliverables only/);
  assert.match(message, /email drafts: at least 10 and at most 10 prospect/);
  assert.match(message, /external actions: at most 0/);
});

test('specialist Runtime events acknowledge outcomes without dumping the full report', () => {
  const summary = specialistEventSummary({
    status: 'blocked', orderTitle: 'SEO foundations',
    packet: { blockers: ['keyword evidence missing'], artifacts: [{ title: 'draft' }], source_refs: ['source-1'] },
  });
  assert.match(summary, /stopped without claiming completion/);
  assert.match(summary, /keyword evidence missing/);
  assert.doesNotMatch(summary, /HQ Work-Order Summary/);
  assert.ok(summary.length < 500);
});

test('HQ dispatcher persists a terminal specialist result event and immediate review wake', async (t) => {
  const previousKey = process.env.HIVEMIND_MASTER_API_KEY;
  process.env.HIVEMIND_MASTER_API_KEY = 'internal-test-key';
  t.after(() => {
    if (previousKey === undefined) delete process.env.HIVEMIND_MASTER_API_KEY;
    else process.env.HIVEMIND_MASTER_API_KEY = previousKey;
  });
  const transport = transportResponse({
    ok: true,
    status: 'completed',
    result: { text: 'Evidence-grounded specialist result.', owner_slug: 'researcher', tool_calls: 2 },
  });

  const captured = { event: null, schedule: null, delegation: null };
  const transactionClient = {
    $queryRawUnsafe: async (query) => String(query).includes('MAX(sequence)')
      ? [{ max_sequence: 8n }] : [{ epoch: 'epoch-1', event_sequence: 8n }],
    hqRuntime: {
      update: async () => ({ eventSequence: 9n }),
      updateMany: async () => ({ count: 1 }),
      findFirst: async () => ({ id: 'runtime-1' }),
    },
    hqRuntimeEvent: {
      create: async ({ data }) => { captured.event = data; return data; },
    },
    hqSchedule: {
      upsert: async ({ create }) => { captured.schedule = create; return create; },
    },
  };
  const prisma = {
    $queryRawUnsafe: async () => [{
      id: 'work-1', org_id: 'org-1', hq_cycle_id: 'cycle-1',
      growth_delegation_id: 'delegation-1', title: 'Validate the market', runtime_id: 'runtime-1',
      runtime_epoch: 'epoch-1', input_snapshot: { runtime_epoch: 'epoch-1' },
    }],
    $transaction: async (callback) => callback(transactionClient),
    growthDelegation: {
      updateMany: async ({ data }) => { captured.delegation = data; return { count: 1 }; },
    },
    hqRuntime: { findFirst: async () => ({ epoch: 'epoch-1' }) },
  };

  const result = await dispatchNextHqWorkOrder({ prisma, transport });
  assert.deepEqual(result, { workOrderId: 'work-1', status: 'COMPLETED' });
  assert.equal(captured.delegation.status, 'COMPLETED');
  assert.equal(captured.event.eventType, 'work_order_completed');
  assert.equal(captured.event.workOrderId, 'work-1');
  assert.equal(captured.schedule.triggerType, 'work_result');
  assert.equal(captured.schedule.payload.work_order_id, 'work-1');
});

test('a completed Room work order carries its real artifact urls into the event, marked ready for the Runtime terminal popup', async (t) => {
  const previousKey = process.env.HIVEMIND_MASTER_API_KEY;
  process.env.HIVEMIND_MASTER_API_KEY = 'internal-test-key';
  t.after(() => {
    if (previousKey === undefined) delete process.env.HIVEMIND_MASTER_API_KEY;
    else process.env.HIVEMIND_MASTER_API_KEY = previousKey;
  });
  const transport = transportResponse({
    ok: true,
    summary: 'Market research complete.',
    result: {
      contract_version: 'work-order-result.v2',
      status: 'completed',
      acceptance: [{ met: true }],
      subtasks: [{ status: 'completed', checks: [{ type: 'evidence', passed: true }] }],
      gaps: [],
      deliverables: [{ title: 'Market research report', url: 'https://cdn.example.com/reports/market.pdf' }],
    },
  });
  const captured = { event: null };
  const transactionClient = {
    $queryRawUnsafe: async (query) => String(query).includes('MAX(sequence)')
      ? [{ max_sequence: 8n }] : [{ epoch: 'epoch-1', event_sequence: 8n }],
    hqRuntime: { update: async () => ({ eventSequence: 9n }), updateMany: async () => ({ count: 1 }), findFirst: async () => ({ id: 'runtime-1' }) },
    hqRuntimeEvent: { create: async ({ data }) => { captured.event = data; return data; } },
    hqSchedule: { upsert: async ({ create }) => create },
  };
  const prisma = {
    $queryRawUnsafe: async () => [{
      id: 'work-2', org_id: 'org-1', hq_cycle_id: 'cycle-1', room_id: 'room-1',
      title: 'Research the Berlin regulated-finance market', runtime_id: 'runtime-1',
      runtime_epoch: 'epoch-1', input_snapshot: { runtime_epoch: 'epoch-1' },
    }],
    $transaction: async (callback) => callback(transactionClient),
    $executeRawUnsafe: async () => {},
    hyperWorkOrder: { updateMany: async () => ({ count: 1 }) },
    hqRuntime: { findFirst: async () => ({ epoch: 'epoch-1' }) },
  };

  const result = await dispatchNextHqWorkOrder({ prisma, transport });
  assert.deepEqual(result, { workOrderId: 'work-2', status: 'COMPLETED' });
  assert.equal(captured.event.eventType, 'work_order_completed');
  assert.equal(captured.event.details.type, 'work.artifact_ready');
  assert.deepEqual(captured.event.details.artifacts, [{ title: 'Market research report', url: 'https://cdn.example.com/reports/market.pdf' }]);
});

test('expired Room work reconciles a durable result instead of replaying the Room', async () => {
  let update = null;
  const prisma = {
    hyperWorkOrder: {
      findMany: async () => [{ id: 'work-lease', attempt: 1, turnId: 'turn-1' }],
      updateMany: async (args) => { update = args; return { count: 1 }; },
    },
    hyperWorkResult: {
      findFirst: async () => ({ status: 'completed', createdAt: new Date('2026-08-02T00:00:00Z') }),
    },
    hyperTurn: { findUnique: async () => ({ status: 'complete' }) },
  };
  const result = await reconcileExpiredWorkOrders({ prisma, logger: { warn: () => {} } });
  assert.deepEqual(result, [{ id: 'work-lease', outcome: 'result_reconciled' }]);
  assert.equal(update.data.status, 'completed');
  assert.equal(update.data.leaseOwner, null);
});

test('expired Room work is requeued only while infrastructure attempts remain', async () => {
  let update = null;
  const prisma = {
    hyperWorkOrder: {
      findMany: async () => [{ id: 'work-retry', attempt: 1, turnId: null }],
      updateMany: async (args) => { update = args; return { count: 1 }; },
    },
    hyperWorkResult: { findFirst: async () => null },
    hyperTurn: { findUnique: async () => null },
  };
  const result = await reconcileExpiredWorkOrders({ prisma, logger: { warn: () => {} } });
  assert.deepEqual(result, [{ id: 'work-retry', outcome: 'requeued' }]);
  assert.equal(update.data.status, 'queued');
});

test('HQ dispatcher does not replay a claimed Work Order', async (t) => {
  const previousKey = process.env.HIVEMIND_MASTER_API_KEY;
  process.env.HIVEMIND_MASTER_API_KEY = 'internal-test-key';
  t.after(() => {
    if (previousKey === undefined) delete process.env.HIVEMIND_MASTER_API_KEY;
    else process.env.HIVEMIND_MASTER_API_KEY = previousKey;
  });
  const transport = transportResponse({ ok: false, status: 'already_claimed' });
  const prisma = {
    $queryRawUnsafe: async () => [{ id: 'work-2', org_id: 'org-1', runtime_id: 'runtime-1', runtime_epoch: 'epoch-1', input_snapshot: { runtime_epoch: 'epoch-1' } }],
    hqRuntime: { findFirst: async () => ({ epoch: 'epoch-1' }) },
  };
  assert.deepEqual(await dispatchNextHqWorkOrder({ prisma, transport }), { workOrderId: 'work-2', status: 'ALREADY_CLAIMED' });
});

test('HQ dispatcher discards a result returned from an obsolete Runtime epoch', async (t) => {
  const previousKey = process.env.HIVEMIND_MASTER_API_KEY;
  process.env.HIVEMIND_MASTER_API_KEY = 'internal-test-key';
  t.after(() => {
    if (previousKey === undefined) delete process.env.HIVEMIND_MASTER_API_KEY;
    else process.env.HIVEMIND_MASTER_API_KEY = previousKey;
  });
  const transport = transportResponse({ ok: true, status: 'completed', result: { text: 'Late result.' } });

  let cancelled = null;
  const prisma = {
    $queryRawUnsafe: async () => [{
      id: 'work-old', org_id: 'org-1', runtime_id: 'runtime-1',
      runtime_epoch: 'epoch-old', input_snapshot: {},
    }],
    hqRuntime: { findFirst: async () => ({ epoch: 'epoch-new' }) },
    hyperWorkOrder: {
      updateMany: async (args) => { cancelled = args; return { count: 1 }; },
    },
  };

  assert.deepEqual(await dispatchNextHqWorkOrder({ prisma, transport, logger: { warn: () => {} } }), {
    workOrderId: 'work-old', status: 'OBSOLETE_EPOCH',
  });
  assert.equal(cancelled.where.runtimeEpoch, 'epoch-old');
  assert.equal(cancelled.data.status, 'cancelled');
});
