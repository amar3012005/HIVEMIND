import test from 'node:test';
import assert from 'node:assert/strict';

import { getOrgCounts } from '../../src/memory/org-counts.js';

test('central org counts use the same memory lane as the inventory', async () => {
  let memoryWhere = null;
  const prisma = {
    memory: {
      count: async ({ where }) => {
        memoryWhere = where;
        return 2;
      },
    },
    $queryRawUnsafe: async () => [{ c: 0 }],
  };

  const counts = await getOrgCounts(prisma, 'central-org');
  assert.equal(counts.memories, 2);
  assert.deepEqual(memoryWhere.layer, { in: ['memory', 'cognitive'] });
});
