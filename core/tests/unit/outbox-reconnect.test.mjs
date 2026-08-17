import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const key = crypto.randomBytes(32).toString('base64');
process.env.PUSH_OUTBOX_ENCRYPTION_KEY = key;
process.env.PUSH_OUTBOX_REQUIRE_ENCRYPTION = 'true';

const { processOutboxJob } = await import('../../src/memory/outbox.js');
const { isSealedOutboxPayload, sealOutboxPayload } = await import('../../src/memory/outbox-crypto.js');

test('offline write remains durable and is redacted only after reconnect acknowledgement', async () => {
  const unique = 'sovereign-reconnect-payload';
  const state = {
    id: '00000000-0000-4000-8000-000000000001',
    orgId: '00000000-0000-4000-8000-000000000002',
    recordId: '00000000-0000-4000-8000-000000000003',
    op: 'write',
    payload: sealOutboxPayload({
      record: { id: '00000000-0000-4000-8000-000000000003', content: unique },
      vector: [0.1, 0.2],
      rels: [],
    }),
    seq: 1n,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: new Date(),
  };
  const prisma = {
    memoryOutbox: {
      findUnique: async () => ({ ...state }),
      findFirst: async () => null,
      update: async ({ data }) => { Object.assign(state, data); return { ...state }; },
    },
  };
  const queue = { add: async () => {} };
  const runWithOrgFn = async (_org, fn) => fn();
  let online = false;
  const received = [];
  const handlers = {
    write: async (_org, record, vector) => {
      if (!online) throw new Error('ECONNREFUSED simulated box outage');
      received.push({ record, vector });
      return true;
    },
  };

  await processOutboxJob({ data: { outboxId: state.id } }, { prisma, queue, handlers, runWithOrgFn });
  assert.equal(state.status, 'pending');
  assert.equal(state.attempts, 1);
  assert.equal(isSealedOutboxPayload(state.payload), true);
  assert.equal(JSON.stringify(state.payload).includes(unique), false);

  online = true;
  await processOutboxJob({ data: { outboxId: state.id } }, { prisma, queue, handlers, runWithOrgFn });
  assert.deepEqual(received, [{
    record: { id: '00000000-0000-4000-8000-000000000003', content: unique },
    vector: [0.1, 0.2],
  }]);
  assert.equal(state.status, 'acked');
  assert.deepEqual(state.payload, { v: 1, redacted: true });
});
