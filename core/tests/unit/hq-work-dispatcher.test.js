import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchNextHqWorkOrder } from '../../src/hq-runtime/work-dispatcher.js';

test('HQ dispatcher persists a terminal specialist result event and immediate review wake', async (t) => {
  const previousKey = process.env.HIVEMIND_MASTER_API_KEY;
  process.env.HIVEMIND_MASTER_API_KEY = 'internal-test-key';
  t.after(() => {
    if (previousKey === undefined) delete process.env.HIVEMIND_MASTER_API_KEY;
    else process.env.HIVEMIND_MASTER_API_KEY = previousKey;
  });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers['X-API-Key'], 'internal-test-key');
    return new Response(JSON.stringify({
      ok: true,
      status: 'completed',
      result: { text: 'Evidence-grounded specialist result.', owner_slug: 'researcher', tool_calls: 2 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = previousFetch; });

  const captured = { event: null, schedule: null, delegation: null };
  const transactionClient = {
    hqRuntime: {
      update: async () => ({ eventSequence: 9n }),
      updateMany: async () => ({ count: 1 }),
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
    }],
    $transaction: async (callback) => callback(transactionClient),
    growthDelegation: {
      updateMany: async ({ data }) => { captured.delegation = data; return { count: 1 }; },
    },
  };

  const result = await dispatchNextHqWorkOrder({ prisma });
  assert.deepEqual(result, { workOrderId: 'work-1', status: 'COMPLETED' });
  assert.equal(captured.delegation.status, 'COMPLETED');
  assert.equal(captured.event.eventType, 'work_order_completed');
  assert.equal(captured.event.workOrderId, 'work-1');
  assert.equal(captured.schedule.triggerType, 'work_result');
  assert.equal(captured.schedule.payload.work_order_id, 'work-1');
});

test('HQ dispatcher does not replay a claimed Work Order', async (t) => {
  const previousKey = process.env.HIVEMIND_MASTER_API_KEY;
  process.env.HIVEMIND_MASTER_API_KEY = 'internal-test-key';
  t.after(() => {
    if (previousKey === undefined) delete process.env.HIVEMIND_MASTER_API_KEY;
    else process.env.HIVEMIND_MASTER_API_KEY = previousKey;
  });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, status: 'already_claimed' }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  t.after(() => { globalThis.fetch = previousFetch; });
  const prisma = { $queryRawUnsafe: async () => [{ id: 'work-2', org_id: 'org-1', runtime_id: 'runtime-1' }] };
  assert.deepEqual(await dispatchNextHqWorkOrder({ prisma }), { workOrderId: 'work-2', status: 'ALREADY_CLAIMED' });
});
