import test from 'node:test';
import assert from 'node:assert/strict';

import {
  backfillSyncedVectors,
  isTrackableManagedMemory,
  markVectorFailed,
  markVectorPending,
  markVectorSynced,
} from '../../src/vector/managed-vector-ledger.js';

const memory = { id: '11111111-1111-4111-8111-111111111111', embedding_version: 3 };

test('only managed memory-shaped points enter the central ledger', () => {
  assert.equal(isTrackableManagedMemory(memory), true);
  assert.equal(isTrackableManagedMemory(memory, { layer: 'evidence' }), false);
  assert.equal(isTrackableManagedMemory(memory, { remote: true }), false);
  assert.equal(isTrackableManagedMemory(memory, { personal: true }), false);
  assert.equal(isTrackableManagedMemory({ id: 'not-a-uuid' }), false);
});

test('managed vector ledger records pending, synced, and failed transitions', async () => {
  const calls = [];
  const db = { vectorEmbedding: {
    upsert: async (args) => { calls.push(['upsert', args]); },
    updateMany: async (args) => { calls.push(['updateMany', args]); return { count: 1 }; },
  } };
  assert.equal(await markVectorPending(memory, 'org_1', { db }), true);
  assert.equal(await markVectorSynced(memory.id, { db }), true);
  assert.equal(await markVectorFailed(memory.id, new Error('provider secret must not leak beyond bounded error'), { db }), true);
  assert.equal(calls[0][1].create.syncStatus, 'pending');
  assert.equal(calls[0][1].create.embeddingVersion, 3);
  assert.equal(calls[1][1].data.syncStatus, 'synced');
  assert.equal(calls[2][1].data.syncStatus, 'failed');
  assert.equal(calls[2][1].data.syncErrorMessage, 'vector_sync_failed:Error');
  assert.equal(JSON.stringify(calls).includes('provider secret'), false);
});

test('ledger fails closed when the authoritative memory row is not committed yet', async () => {
  const db = { vectorEmbedding: { upsert: async () => { throw new Error('foreign key'); } } };
  assert.equal(await markVectorPending(memory, 'org_1', { db }), false);
});

test('reconciler backfills synced ledger rows in a bounded batch', async () => {
  const calls = [];
  const db = { vectorEmbedding: {
    createMany: async (args) => { calls.push(['createMany', args]); return { count: 2 }; },
    updateMany: async (args) => { calls.push(['updateMany', args]); return { count: 2 }; },
  } };
  const second = { id: '22222222-2222-4222-8222-222222222222' };
  assert.equal(await backfillSyncedVectors([memory, second], 'org_1', { db }), 2);
  assert.equal(calls[0][1].skipDuplicates, true);
  assert.deepEqual(calls[1][1].where.memoryId.in, [memory.id, second.id]);
  assert.equal(calls[1][1].data.syncStatus, 'synced');
});
