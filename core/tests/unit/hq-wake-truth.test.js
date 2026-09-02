import test from 'node:test';
import assert from 'node:assert/strict';
import { wakeIdempotencyKey } from '../../src/hq-runtime/repository.js';
import { projectRuntimeLiveness } from '../../src/hq-runtime/liveness.js';
import { evaluateHqScheduleEligibility } from '../../src/hq-runtime/wake-eligibility.js';

test('one material cause produces one deterministic wake identity', () => {
  const input = { runtimeId: 'runtime-a', runtimeEpoch: 'epoch-a', materialCauseId: 'provider-event:tara:event-1' };
  assert.equal(wakeIdempotencyKey(input), wakeIdempotencyKey(input));
  assert.notEqual(wakeIdempotencyKey(input), wakeIdempotencyKey({ ...input, materialCauseId: 'provider-event:tara:event-2' }));
  assert.throws(() => wakeIdempotencyKey({ runtimeId: 'runtime-a', runtimeEpoch: 'epoch-a' }), /material_cause_required/);
});

test('waiting capability work is retained queue liveness, never queue_empty', () => {
  const liveness = projectRuntimeLiveness({
    todos: [{ id: 'todo-1', status: 'WAITING_FOR_CONNECTOR' }],
    playbookRuns: [{ id: 'run-1', status: 'WAITING_EVENT', waitingFor: { types: ['capability.connected'] } }],
  });
  assert.equal(liveness.queueEmpty, false);
  assert.equal(liveness.state, 'WAITING_CAPABILITY');
  assert.equal(liveness.capabilityTodo.id, 'todo-1');
});

test('a nonterminal Room run retains liveness even without an executable todo', () => {
  const liveness = projectRuntimeLiveness({
    playbookRuns: [{ id: 'run-1', status: 'WAITING_EVENT', waitingFor: { types: ['provider.event'] } }],
  });
  assert.equal(liveness.queueEmpty, false);
  assert.equal(liveness.state, 'WAITING_EVENT');
  assert.equal(liveness.eventRun.id, 'run-1');
});

test('an already-applied instruction wake is a silent scheduler no-op', async () => {
  const result = await evaluateHqScheduleEligibility({
    schedule: {
      material_cause_id: 'instruction:instruction-1', trigger_type: 'instruction_updated',
      payload: { instruction_id: 'instruction-1' },
    },
    prisma: { hqInstruction: { findUnique: async () => ({ status: 'APPLIED' }) } },
  });
  assert.deepEqual(result, { eligible: false, reason: 'instruction_already_applied' });
});

test('a stale deadline cannot create a Runtime cycle', async () => {
  const result = await evaluateHqScheduleEligibility({
    schedule: {
      material_cause_id: 'deadline:run-1:stage-1:old', trigger_type: 'runtime_playbook_event',
      payload: { wake_contract: { kind: 'deadline', run_id: 'run-1', checkpoint_sequence: 2, deadline: '2026-09-02T00:00:00.000Z' } },
    },
    prisma: { runtimePlaybookRun: { findUnique: async () => ({ status: 'COMPLETED', checkpointSequence: 3, waitingFor: null }) } },
  });
  assert.deepEqual(result, { eligible: false, reason: 'deadline_obsolete' });
});
