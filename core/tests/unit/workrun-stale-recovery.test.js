import test from 'node:test';
import assert from 'node:assert/strict';

import { failStaleWorkRuns, recoverStaleWorkRuns, recoverWorkRun, WORK_RUN_STATUS } from '../../src/employees/work-runs.js';

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

test('recovery reattaches to an existing AgentScope session without dispatching a second goal', async () => {
  const calls = [];
  const prisma = {
    async $queryRawUnsafe(sql, ...params) {
      calls.push({ sql, params });
      if (sql.includes('SELECT id, org_id, user_id')) {
        return [{
          id: 'run-a', org_id: 'org-a', user_id: 'user-a', employee_id: null,
          room_id: 'room-a', turn_id: 'turn-a', status: WORK_RUN_STATUS.RUNNING,
          agentscope_session_id: 'session-a', workspace_id: 'workrun:run-a',
          hyperagent_slug: 'researcher',
        }];
      }
      if (sql.startsWith('SELECT id, status FROM "hivemind"."work_runs" WHERE id')) {
        return [{ id: 'run-a', status: WORK_RUN_STATUS.RUNNING }];
      }
      if (sql.startsWith('UPDATE "hivemind"."work_runs" SET status')) return [{ id: 'run-a', status: WORK_RUN_STATUS.RUNNING }];
      if (sql.startsWith('UPDATE "hivemind"."work_runs"\n        SET events')) return [{ id: 'run-a' }];
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  let request;
  const outcome = await recoverWorkRun({
    prisma,
    workRunId: 'run-a',
    runtimeFetch: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ recovered: true }) };
    },
  });
  assert.equal(outcome.ok, true);
  assert.equal(request.url.endsWith('/workrun/recover'), true);
  assert.deepEqual(request.options.body, {
    workrun_id: 'run-a', agent_id: 'researcher', turn_id: 'turn-a', room_id: 'room-a',
    org_id: 'org-a', session_id: 'session-a', workspace_id: 'workrun:run-a',
  });
  assert.ok(calls.some(({ sql }) => sql.includes('SET status = $2')));
  assert.ok(calls.some(({ sql }) => sql.includes('SET events =')));
});

test('stale session recovery only scans AgentScope-bound active runs and refreshes them without dispatch', async () => {
  const calls = [];
  const prisma = {
    async $queryRawUnsafe(sql, ...params) {
      calls.push({ sql, params });
      if (sql.includes('agentscope_session_id IS NOT NULL')) return [{ id: 'run-a' }];
      if (sql.includes('SELECT id, org_id, user_id')) {
        return [{
          id: 'run-a', org_id: 'org-a', user_id: 'user-a', employee_id: 'agent-a',
          room_id: 'room-a', turn_id: 'turn-a', status: WORK_RUN_STATUS.RUNNING,
          agentscope_session_id: 'session-a', workspace_id: null, hyperagent_slug: null,
        }];
      }
      if (sql.startsWith('SELECT id, status FROM "hivemind"."work_runs" WHERE id')) {
        return [{ id: 'run-a', status: WORK_RUN_STATUS.RUNNING }];
      }
      if (sql.startsWith('UPDATE "hivemind"."work_runs" SET status')) return [{ id: 'run-a', status: WORK_RUN_STATUS.RUNNING }];
      if (sql.startsWith('UPDATE "hivemind"."work_runs"\n        SET events')) return [{ id: 'run-a' }];
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  let request;
  const result = await recoverStaleWorkRuns(prisma, {
    before: new Date('2026-09-19T00:00:00.000Z'),
    limit: 1,
    runtimeFetch: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ recovered: true }) };
    },
  });
  assert.deepEqual(result, { attempted: 1, recovered: 1, skipped: 0, failed: 0 });
  assert.equal(request.url.endsWith('/workrun/recover'), true);
  assert.equal(request.url.includes('/chat'), false);
  assert.deepEqual(calls[0].params, [[WORK_RUN_STATUS.STARTING, WORK_RUN_STATUS.RUNNING], '2026-09-19T00:00:00.000Z', 1]);
});
