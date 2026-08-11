import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runSingletonMaintenanceJob,
  scheduleRecurringMaintenanceJob,
} from '../../src/runtime/maintenance-job.js';

test('runSingletonMaintenanceJob runs inline without prisma', async () => {
  let runs = 0;
  const result = await runSingletonMaintenanceJob({
    jobName: 'inline-job',
    run: async () => { runs += 1; },
  });
  assert.equal(result, true);
  assert.equal(runs, 1);
});

test('runSingletonMaintenanceJob skips when governance lock is busy', async () => {
  let runs = 0;
  const prisma = {
    async $transaction(fn) {
      const tx = {
        async $queryRawUnsafe(sql) {
          if (sql.includes('hashtext')) return [{ h: 123 }];
          if (sql.includes('pg_try_advisory_xact_lock')) return [{ got: false }];
          throw new Error(`unexpected query: ${sql}`);
        },
      };
      return fn(tx);
    },
  };
  const result = await runSingletonMaintenanceJob({
    prisma,
    jobName: 'busy-job',
    run: async () => { runs += 1; },
  });
  assert.equal(result, false);
  assert.equal(runs, 0);
});

test('scheduleRecurringMaintenanceJob invokes scheduled work', async () => {
  let runs = 0;
  const stop = scheduleRecurringMaintenanceJob({
    jobName: 'scheduled-job',
    singleton: false,
    initialDelayMs: 5,
    intervalMs: 0,
    run: async () => { runs += 1; },
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(runs, 1);
  } finally {
    stop();
  }
});
