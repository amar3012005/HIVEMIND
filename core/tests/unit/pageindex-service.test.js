import test from 'node:test';
import assert from 'node:assert/strict';

import { PageIndexService } from '../../src/services/pageindex-service.js';

test('ensureRootNode atomically upserts by tenant-scoped path', async () => {
  const calls = [];
  const prisma = {
    pageIndexNode: {
      upsert: async (args) => {
        calls.push(args);
        return { id: 'root-1', ...args.create };
      },
    },
  };

  const service = new PageIndexService({ prisma });
  const root = await service.ensureRootNode('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222');

  assert.equal(root.path, '/hivemind');
  assert.deepEqual(calls[0].where, {
    userId_path: {
      userId: '11111111-1111-1111-1111-111111111111',
      path: '/hivemind',
    },
  });
  assert.deepEqual(calls[0].update, {});
});

test('createNode atomically upserts a child by tenant-scoped path', async () => {
  const calls = [];
  const prisma = {
    pageIndexNode: {
      findUnique: async () => ({
        id: 'root-1',
        userId: '11111111-1111-1111-1111-111111111111',
        depth: 1,
        path: '/hivemind',
      }),
      upsert: async (args) => {
        calls.push(args);
        return { id: 'child-1', ...args.create };
      },
    },
  };

  const service = new PageIndexService({ prisma });
  const node = await service.createNode({
    userId: '11111111-1111-1111-1111-111111111111',
    orgId: '22222222-2222-2222-2222-222222222222',
    parentId: 'root-1',
    label: 'Solvis Research',
  });

  assert.equal(node.path, '/hivemind/solvis-research');
  assert.deepEqual(calls[0].where, {
    userId_path: {
      userId: '11111111-1111-1111-1111-111111111111',
      path: '/hivemind/solvis-research',
    },
  });
});
