import test from 'node:test';
import assert from 'node:assert/strict';

import { failStaleWorkRuns, WORK_RUN_STATUS } from '../../src/employees/work-runs.js';

test('stale recovery only targets selected active states and records a public failure', async () => {
  const calls = [];
  let selectCount = 0;
  const prisma = {
    async $queryRawUnsafe(sql, ...params) {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT id, status FROM "hivemind"."work_runs"\n       WHERE status')) {
        selectCount += 1;
        return selectCount === 1 ? [{ id: 'run-a', status: WORK_RUN_STATUS.RUNNING }] : [];
      }
      if (sql.startsWith('SELECT id, status FROM "hivemind"."work_runs" WHERE id')) {
        return [{ id: 'run-a', status: WORK_RUN_STATUS.RUNNING }];
      }
      if (sql.startsWith('UPDATE "hivemind"."work_runs" SET status')) return [{ id: 'run-a' }];
      if (sql.startsWith('UPDATE "hivemind"."work_runs"\n        SET events')) return [{ id: 'run-a' }];
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };

  const result = await failStaleWorkRuns(prisma, { before: new Date('2026-09-19T00:00:00.000Z') });
  assert.deepEqual(result, { attempted: 1, failed: 1, skipped: 0 });
  assert.deepEqual(calls[0].params[0], [WORK_RUN_STATUS.STARTING, WORK_RUN_STATUS.RUNNING]);
  assert.ok(calls.some(({ sql }) => sql.includes('SET status = $2')));
  assert.ok(calls.some(({ sql }) => sql.includes('SET events =')));
});

test('stale recovery refuses an invalid cutoff and cannot accidentally sweep every state', async () => {
  await assert.rejects(() => failStaleWorkRuns({}, { before: new Date('invalid') }), /valid Date/);
  await assert.rejects(
    () => failStaleWorkRuns({}, { before: new Date(), statuses: [] }),
    /non-empty array/,
  );
});
