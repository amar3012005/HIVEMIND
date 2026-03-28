import test from 'node:test';
import assert from 'node:assert/strict';
import { BiTemporalEngine } from '../../src/memory/bi-temporal.js';
import { InMemoryGraphStore } from '../../src/memory/graph-engine.js';

test('bi-temporal fallback respects valid_to windows in asOfValid', async () => {
  const store = new InMemoryGraphStore();
  const engine = new BiTemporalEngine({ store });
  const userId = '00000000-0000-4000-8000-000000001001';
  const orgId = '00000000-0000-4000-8000-000000001002';

  await store.createMemory({
    id: 'm1',
    user_id: userId,
    org_id: orgId,
    content: 'User lives in Berlin.',
    memory_type: 'fact',
    is_latest: true,
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    document_date: '2026-01-01T00:00:00.000Z',
    metadata: { valid_to: '2026-02-01T00:00:00.000Z' }
  });

  await store.createMemory({
    id: 'm2',
    user_id: userId,
    org_id: orgId,
    content: 'User moved to Munich.',
    memory_type: 'fact',
    is_latest: true,
    version: 1,
    created_at: '2026-02-02T00:00:00.000Z',
    updated_at: '2026-02-02T00:00:00.000Z',
    document_date: '2026-02-02T00:00:00.000Z',
    metadata: {}
  });

  const january = await engine.asOfValid(userId, orgId, '2026-01-20T00:00:00.000Z');
  const march = await engine.asOfValid(userId, orgId, '2026-03-01T00:00:00.000Z');

  assert.equal(january.length, 1);
  assert.equal(january[0].memoryId, 'm1');
  assert.equal(march.length, 1);
  assert.equal(march[0].memoryId, 'm2');
});

test('bi-temporal prisma path appends a version when closing a valid window', async () => {
  const createdVersions = [];
  const prisma = {
    memory: {
      findUnique: async () => ({
        id: 'm1',
        isLatest: true,
        versions: [
          {
            version: 2,
            contentHash: 'abc123',
            metadata: { source: 'test' }
          }
        ]
      })
    },
    memoryVersion: {
      create: async ({ data }) => {
        createdVersions.push(data);
        return data;
      }
    }
  };

  const engine = new BiTemporalEngine({ store: { client: prisma }, prisma });
  const result = await engine.closeValidWindow('m1', '2026-03-28T00:00:00.000Z');

  assert.equal(result.success, true);
  assert.equal(createdVersions.length, 1);
  assert.equal(createdVersions[0].version, 3);
  assert.equal(createdVersions[0].reason, 'close_valid_window');
  assert.equal(createdVersions[0].metadata.source, 'test');
  assert.equal(createdVersions[0].metadata.valid_to, '2026-03-28T00:00:00.000Z');
});
