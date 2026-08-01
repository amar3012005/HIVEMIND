import assert from 'node:assert/strict';
import test from 'node:test';

import { MemorySaver } from '@langchain/langgraph';

import { compileHqControlCycle } from '../../src/hq-runtime/langgraph/hq-control-cycle.js';

function repository(rows) {
  const executions = new Map(rows.map((row) => [row.id, { ...row }]));
  return {
    executions,
    async listByOrganization(organizationId) {
      return [...executions.values()]
        .filter((row) => row.organizationId === organizationId)
        .map((row) => ({ ...row }));
    },
  };
}

function input(overrides = {}) {
  return {
    cycleId: 'cycle-1',
    organizationId: 'org-a',
    trigger: { type: 'scheduler_tick' },
    executionIds: [],
    runnableIds: [],
    waitingIds: [],
    terminalIds: [],
    advancedIds: [],
    status: 'LOADING',
    sleepAllowed: false,
    ...overrides,
  };
}

test('HQ advances runnable work while another lifecycle waits', async () => {
  const repo = repository([
    { id: 'email-waiting', organizationId: 'org-a', status: 'WAITING_EVENT' },
    { id: 'seo-ready', organizationId: 'org-a', status: 'READY' },
  ]);
  const graph = compileHqControlCycle({
    executionRepository: repo,
    async advanceExecution({ executionId }) {
      repo.executions.get(executionId).status = 'COMPLETED';
    },
  }, { checkpointer: new MemorySaver() });

  const result = await graph.invoke(input(), {
    configurable: { thread_id: 'hq-cycle-waiting-and-ready' },
  });
  assert.deepEqual(result.advancedIds, ['seo-ready']);
  assert.deepEqual(result.waitingIds, ['email-waiting']);
  assert.deepEqual(result.terminalIds, ['seo-ready']);
  assert.equal(result.status, 'WAITING');
  assert.equal(result.sleepAllowed, true);
});

test('HQ refuses sleep when a child produces another runnable step', async () => {
  const repo = repository([
    { id: 'email-ready', organizationId: 'org-a', status: 'READY' },
  ]);
  const graph = compileHqControlCycle({
    executionRepository: repo,
    async advanceExecution({ executionId }) {
      repo.executions.get(executionId).status = 'READY';
    },
  }, { checkpointer: new MemorySaver() });

  const result = await graph.invoke(input(), {
    configurable: { thread_id: 'hq-cycle-runnable-remains' },
  });
  assert.deepEqual(result.advancedIds, ['email-ready']);
  assert.deepEqual(result.runnableIds, ['email-ready']);
  assert.equal(result.status, 'RUNNABLE_REMAINS');
  assert.equal(result.sleepAllowed, false);
});

test('HQ advances independent runnable child lifecycles in one cycle', async () => {
  const repo = repository([
    { id: 'email-ready', organizationId: 'org-a', status: 'READY' },
    { id: 'social-event', organizationId: 'org-a', status: 'EVENT_READY' },
    { id: 'foreign-ready', organizationId: 'org-b', status: 'READY' },
  ]);
  const calls = [];
  const graph = compileHqControlCycle({
    executionRepository: repo,
    async advanceExecution({ organizationId, executionId }) {
      calls.push({ organizationId, executionId });
      repo.executions.get(executionId).status = 'WAITING_EVENT';
    },
  }, { checkpointer: new MemorySaver() });

  const result = await graph.invoke(input(), {
    configurable: { thread_id: 'hq-cycle-parallel' },
  });
  assert.deepEqual(new Set(result.advancedIds), new Set(['email-ready', 'social-event']));
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.organizationId === 'org-a'));
  assert.deepEqual(new Set(result.waitingIds), new Set(['email-ready', 'social-event']));
  assert.equal(result.sleepAllowed, true);
});

test('HQ rejects unknown child state instead of silently sleeping', async () => {
  const repo = repository([
    { id: 'broken-child', organizationId: 'org-a', status: 'SOMETHING_UNMAPPED' },
  ]);
  const graph = compileHqControlCycle({
    executionRepository: repo,
    async advanceExecution() {},
  }, { checkpointer: new MemorySaver() });

  await assert.rejects(
    graph.invoke(input(), { configurable: { thread_id: 'hq-cycle-unknown' } }),
    /hq_control_cycle_unknown_child_state:broken-child/,
  );
});
