import test from 'node:test';
import assert from 'node:assert/strict';
import { activateHqAfterOnboarding, resetHqForCompanyReplacement } from '../../src/hq-runtime/repository.js';

test('onboarding activates HQ and schedules one source-keyed wake', async () => {
  const calls = [];
  const runtime = { id: 'runtime-1', orgId: 'org-1', state: 'OBSERVING' };
  const prisma = {
    hqRuntime: {
      upsert: async (args) => { calls.push(['runtime.upsert', args]); return runtime; },
      findUnique: async () => runtime,
      updateMany: async (args) => { calls.push(['runtime.updateMany', args]); return { count: 1 }; },
    },
    hqSchedule: {
      upsert: async (args) => { calls.push(['schedule.upsert', args]); return { id: 'schedule-1' }; },
    },
    $transaction: async (fn) => fn(prisma),
  };

  await activateHqAfterOnboarding({
    prisma, orgId: 'org-1', userId: 'user-1', objective: 'Grow Acme.',
    onboardedAt: '2026-07-30T12:00:00.000Z',
  });

  const schedule = calls.find(([name]) => name === 'schedule.upsert')[1];
  assert.equal(schedule.create.triggerType, 'onboarding_complete');
  assert.equal(schedule.create.idempotencyKey, 'onboarding_complete:2026-07-30T12:00:00.000Z');
  assert.equal(schedule.create.payload.onboarded_at, '2026-07-30T12:00:00.000Z');
});

test('company replacement clears transient HQ execution state', async () => {
  const calls = [];
  const runtime = { id: 'runtime-1', orgId: 'org-1' };
  const prisma = {
    hqRuntime: {
      findUnique: async () => runtime,
      update: async (args) => { calls.push(['runtime.update', args]); return runtime; },
    },
    hyperWorkOrder: { updateMany: async (args) => { calls.push(['work.updateMany', args]); return { count: 1 }; } },
    hqCapabilityRequest: { deleteMany: async (args) => { calls.push(['capabilities.deleteMany', args]); return { count: 1 }; } },
    hqTodo: { deleteMany: async (args) => { calls.push(['todos.deleteMany', args]); return { count: 1 }; } },
    hqInstruction: { deleteMany: async (args) => { calls.push(['instructions.deleteMany', args]); return { count: 1 }; } },
    hqRuntimeEvent: { deleteMany: async (args) => { calls.push(['events.deleteMany', args]); return { count: 3 }; } },
    hqSchedule: { deleteMany: async (args) => { calls.push(['schedules.deleteMany', args]); return { count: 2 }; } },
    hqCycle: { deleteMany: async (args) => { calls.push(['cycles.deleteMany', args]); return { count: 1 }; } },
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
});
