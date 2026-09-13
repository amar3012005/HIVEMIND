import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaGraphStore } from '../../src/memory/prisma-graph-store.js';

test('hard delete atomically removes canonical entity projections with the memory', async () => {
  const calls = [];
  const tx = {
    resourceEntityLink: {
      findMany: async () => [{ entityId: 'entity-1' }],
      deleteMany: async (query) => { calls.push(['resource-links', query]); return { count: 2 }; },
    },
    memoryEntityLink: {
      findMany: async () => [{ entityId: 'entity-1' }],
      deleteMany: async (query) => { calls.push(['memory-links', query]); return { count: 1 }; },
    },
    entityExtractionReceipt: {
      deleteMany: async (query) => { calls.push(['receipts', query]); return { count: 1 }; },
    },
    canonicalEntity: { deleteMany: async () => ({ count: 0 }) },
    sourceMetadata: { deleteMany: async () => ({ count: 0 }) },
    memoryVersion: { updateMany: async () => ({ count: 0 }), deleteMany: async () => ({ count: 0 }) },
    relationship: { deleteMany: async () => ({ count: 0 }) },
    memory: { deleteMany: async () => ({ count: 1 }) },
  };
  const client = {
    memory: { findMany: async () => [{ id: 'memory-1', orgId: 'org-1' }] },
    $transaction: async (fn) => { calls.push(['transaction']); return fn(tx); },
  };
  const store = new PrismaGraphStore(client);
  assert.equal(await store.hardDeleteMemories(['memory-1']), 1);
  assert.equal(calls.filter(([kind]) => kind === 'transaction').length, 1);
  assert.equal(calls.some(([kind]) => kind === 'resource-links'), true);
  assert.equal(calls.some(([kind]) => kind === 'receipts'), true);
});
