import test from 'node:test';
import assert from 'node:assert/strict';
import { HqScheduleStore } from '../../src/hq-runtime/schedule-store.js';

test('HQ schedule leasing is database-serialized and organization-safe', async () => {
  let captured = null;
  const prisma = {
    $queryRawUnsafe: async (...args) => {
      captured = args;
      return [{ id: 'schedule-1', org_id: 'org-1', status: 'LEASED' }];
    },
  };
  const store = new HqScheduleStore({ prisma });
  const row = await store.leaseNext('worker-1', { leaseMs: 45000 });
  assert.equal(row.id, 'schedule-1');
  assert.match(captured[0], /FOR UPDATE OF s SKIP LOCKED/);
  assert.match(captured[0], /r\.state NOT IN \('INACTIVE','PAUSED'\)/);
  assert.match(captured[0], /NOT EXISTS/);
  assert.deepEqual(captured.slice(1), ['worker-1', '45000']);
});

test('HQ schedule leasing returns null when no work is due', async () => {
  const store = new HqScheduleStore({ prisma: { $queryRawUnsafe: async () => [] } });
  assert.equal(await store.leaseNext('worker-1'), null);
});
