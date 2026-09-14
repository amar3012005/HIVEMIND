import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MemoryWriteReceiptStore,
  memoryWriteIdempotencyKey,
  memoryWriteRequestHash,
  publicMemoryWriteReceipt,
} from '../../src/memory/memory-write-receipts.js';

test('memory write request hashing is stable across object key order', () => {
  assert.equal(memoryWriteRequestHash({ b: 2, a: { d: 4, c: 3 } }), memoryWriteRequestHash({ a: { c: 3, d: 4 }, b: 2 }));
  assert.equal(memoryWriteIdempotencyKey({ 'x-idempotency-key': ' key-1 ' }, {}), 'key-1');
  assert.equal(memoryWriteIdempotencyKey({}, { idempotency_key: 'body-key' }), 'body-key');
});

test('receipt acquisition distinguishes the owning writer from a replay', async () => {
  const existing = {
    id: 'receipt-1', status: 'saved', request_hash: 'hash-1', memory_id: 'memory-1', response: { success: true },
  };
  let call = 0;
  const store = new MemoryWriteReceiptStore({
    async $queryRawUnsafe() {
      call += 1;
      return call === 1 ? [] : [existing];
    },
  });
  const result = await store.begin({ orgId: 'org', userId: 'user', idempotencyKey: 'key', requestHash: 'hash-1' });
  assert.equal(result.acquired, false);
  assert.equal(result.receipt.memory_id, 'memory-1');
});

test('receipt acquisition rejects key reuse for different content', async () => {
  const store = new MemoryWriteReceiptStore({
    async $queryRawUnsafe() {
      return [{ id: 'receipt-1', status: 'saved', request_hash: 'different' }];
    },
  });
  await assert.rejects(
    store.begin({ orgId: 'org', userId: 'user', idempotencyKey: 'key', requestHash: 'hash-1' }),
    /does not match the original request/,
  );
});

test('public receipt excludes internal request hashes while preserving the scoped replay response', () => {
  assert.deepEqual(publicMemoryWriteReceipt({
    id: 'receipt-1', status: 'saved', memory_id: 'memory-1', request_hash: 'secret-hash', response: { content: 'private' },
  }, 'key-1'), {
    status: 'saved', receipt_id: 'receipt-1', idempotency_key: 'key-1', memory_id: 'memory-1', response: { content: 'private' },
  });
});
