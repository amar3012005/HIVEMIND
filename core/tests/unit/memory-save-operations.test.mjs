import test from 'node:test';
import assert from 'node:assert/strict';
import { getSaveOperation, publicSaveStatus, upsertSaveOperation } from '../../src/memory/save-operations.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

function fakePrisma(store) {
  return {
    $queryRawUnsafe: async (_sql, orgId, userId, key) => {
      const row = store.get(`${orgId}:${userId}:${key}`);
      return row ? [row] : [];
    },
    $executeRawUnsafe: async (_sql, orgId, userId, key, operationId, status, destination, request, receipt) => {
      store.set(`${orgId}:${userId}:${key}`, {
        operation_id: operationId,
        status,
        destination_scope: destination,
        request: JSON.parse(request),
        receipt: receipt ? JSON.parse(receipt) : null,
        idempotency_key: key,
        updated_at: new Date().toISOString(),
      });
      return 1;
    },
  };
}

test('prepared save operations stay tenant-scoped and replay completed receipts', async () => {
  const store = new Map();
  const prisma = fakePrisma(store);
  await upsertSaveOperation(prisma, {
    orgId: ORG, userId: USER, idempotencyKey: 'hive-save:abc', operationId: 'saveop:1',
    status: 'prepared', request: { title: 'Note' },
  });
  const prepared = await getSaveOperation(prisma, { orgId: ORG, userId: USER, idempotencyKey: 'hive-save:abc' });
  assert.equal(prepared.status, 'prepared');
  await upsertSaveOperation(prisma, {
    orgId: ORG, userId: USER, idempotencyKey: 'hive-save:abc', operationId: 'saveop:1',
    status: 'completed', destinationScope: 'organization',
    receipt: { memory_id: 'm1', receipt_id: 'memory:m1' },
  });
  const done = publicSaveStatus(await getSaveOperation(prisma, { orgId: ORG, userId: USER, idempotencyKey: 'hive-save:abc' }));
  assert.equal(done.status, 'completed');
  assert.equal(done.replayed, true);
  assert.equal(done.receipt.memory_id, 'm1');
  assert.equal(await getSaveOperation(prisma, { orgId: ORG, userId: '33333333-3333-4333-8333-333333333333', idempotencyKey: 'hive-save:abc' }), null);
});

test('rejects an unknown status instead of writing', async () => {
  await assert.rejects(() => upsertSaveOperation(fakePrisma(new Map()), {
    orgId: ORG, userId: USER, idempotencyKey: 'k', operationId: 'o', status: 'sent',
  }), /invalid_save_operation/);
});
