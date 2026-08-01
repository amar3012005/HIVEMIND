import test from 'node:test';
import assert from 'node:assert/strict';
import { activateHqAfterOnboarding, resetHqForCompanyReplacement } from '../../src/hq-runtime/repository.js';

test('onboarding initializes an inactive Runtime and waits for the invitation wake', async () => {
  const calls = [];
  const runtime = { id: 'runtime-1', orgId: 'org-1', state: 'INACTIVE' };
  const prisma = {
    hqRuntime: {
      upsert: async (args) => { calls.push(['runtime.upsert', args]); return runtime; },
      findUnique: async () => runtime,
      updateMany: async (args) => { calls.push(['runtime.updateMany', args]); return { count: 1 }; },
    },
  };

  await activateHqAfterOnboarding({
    prisma, orgId: 'org-1', userId: 'user-1', objective: 'Grow Acme.',
    onboardedAt: '2026-07-30T12:00:00.000Z',
  });

  const upsert = calls.find(([name]) => name === 'runtime.upsert')[1];
  assert.equal(upsert.create.state, 'INACTIVE');
  assert.equal(upsert.update.state, 'INACTIVE');
  assert.equal(calls.some(([name]) => name === 'schedule.upsert'), false);
});

test('company replacement clears transient HQ execution state', async () => {
  const calls = [];
  const runtime = { id: 'runtime-1', orgId: 'org-1' };
  const prisma = {
    hqRuntime: {
      findUnique: async () => runtime,
      update: async (args) => { calls.push(['runtime.update', args]); return runtime; },
    },
    hyperWorkResult: { deleteMany: async (args) => { calls.push(['results.deleteMany', args]); return { count: 1 }; } },
    hyperWorkOrder: {
      findMany: async () => [{ id: 'work-1' }],
      deleteMany: async (args) => { calls.push(['work.deleteMany', args]); return { count: 1 }; },
      count: async () => 0,
    },
    hyperTurn: { deleteMany: async (args) => { calls.push(['turns.deleteMany', args]); return { count: 1 }; } },
    growthJournal: { deleteMany: async (args) => { calls.push(['journal.deleteMany', args]); return { count: 1 }; } },
    growthHypothesis: { deleteMany: async (args) => { calls.push(['hypotheses.deleteMany', args]); return { count: 1 }; } },
    growthDelegation: { deleteMany: async (args) => { calls.push(['delegations.deleteMany', args]); return { count: 1 }; } },
    growthStage: { deleteMany: async (args) => { calls.push(['stages.deleteMany', args]); return { count: 1 }; } },
    growthGoal: { deleteMany: async (args) => { calls.push(['goals.deleteMany', args]); return { count: 1 }; }, count: async () => 0 },
    knowledgeDocument: { deleteMany: async (args) => { calls.push(['documents.deleteMany', args]); return { count: 1 }; } },
    sourceArtifact: { deleteMany: async (args) => { calls.push(['artifacts.deleteMany', args]); return { count: 1 }; }, count: async () => 0 },
    runtimePlaybookRun: { deleteMany: async (args) => { calls.push(['playbooks.deleteMany', args]); return { count: 1 }; }, count: async () => 0 },
    hqWorkflow: { deleteMany: async (args) => { calls.push(['workflows.deleteMany', args]); return { count: 1 }; }, count: async () => 0 },
    hqCapabilityRequest: { deleteMany: async (args) => { calls.push(['capabilities.deleteMany', args]); return { count: 1 }; }, count: async () => 0 },
    hqTodo: { deleteMany: async (args) => { calls.push(['todos.deleteMany', args]); return { count: 1 }; }, count: async () => 0 },
    hqInstruction: { deleteMany: async (args) => { calls.push(['instructions.deleteMany', args]); return { count: 1 }; }, count: async () => 0 },
    hqRuntimeEvent: { deleteMany: async (args) => { calls.push(['events.deleteMany', args]); return { count: 3 }; }, count: async () => 0 },
    hqSchedule: { deleteMany: async (args) => { calls.push(['schedules.deleteMany', args]); return { count: 2 }; }, count: async () => 0 },
    hqCycle: { deleteMany: async (args) => { calls.push(['cycles.deleteMany', args]); return { count: 1 }; }, count: async () => 0 },
    $transaction: async (fn) => fn(prisma),
  };

  await resetHqForCompanyReplacement({ prisma, orgId: 'org-1' });

  const update = calls.find(([name]) => name === 'runtime.update')[1];
  assert.equal(update.data.state, 'INACTIVE');
  assert.equal(update.data.eventSequence, 0);
  assert.equal(update.data.activeGoalId, null);
  assert.ok(calls.some(([name]) => name === 'events.deleteMany'));
  assert.ok(calls.some(([name]) => name === 'schedules.deleteMany'));
  assert.ok(calls.some(([name]) => name === 'todos.deleteMany'));
  assert.ok(calls.some(([name]) => name === 'instructions.deleteMany'));
  assert.ok(update.data.epoch);
  assert.ok(calls.some(([name]) => name === 'delegations.deleteMany'));
  assert.ok(calls.some(([name]) => name === 'stages.deleteMany'));
  assert.ok(calls.some(([name]) => name === 'goals.deleteMany'));
  assert.ok(calls.some(([name]) => name === 'artifacts.deleteMany'));
  assert.ok(calls.some(([name]) => name === 'playbooks.deleteMany'));
});
