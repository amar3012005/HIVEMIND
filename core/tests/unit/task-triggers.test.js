import test from 'node:test';
import assert from 'node:assert/strict';
import { nextDailyDue, normalizeTriggerInput } from '../../src/employees/task-triggers.js';

test('daily trigger honors a named timezone and skips the repeated DST hour', () => {
  const before = new Date('2026-10-25T00:00:00Z');
  const first = nextDailyDue(before, 'Europe/Berlin', '02:30');
  assert.equal(first.toISOString(), '2026-10-25T00:30:00.000Z');
  const next = nextDailyDue(first, 'Europe/Berlin', '02:30');
  assert.equal(next.toISOString(), '2026-10-26T01:30:00.000Z');
});

test('nonexistent spring DST minute runs on the next valid day', () => {
  const due = nextDailyDue(new Date('2026-03-29T00:00:00Z'), 'Europe/Berlin', '02:30');
  assert.equal(due.toISOString(), '2026-03-30T00:30:00.000Z');
});

test('trigger input bounds time, task, mode and event key', () => {
  const now = new Date('2026-09-28T12:00:00Z');
  assert.equal(normalizeTriggerInput({ kind: 'once', task: 'Write a report', run_at: '2026-09-28T12:01:00Z' }, now).kind, 'once');
  assert.throws(() => normalizeTriggerInput({ kind: 'once', task: 'Write a report', run_at: '2026-09-28T11:59:00Z' }, now), /invalid_run_at/);
  assert.throws(() => normalizeTriggerInput({ kind: 'event', task: 'Write a report', event_key: '../bad' }, now), /invalid_event_key/);
  assert.throws(() => normalizeTriggerInput({ kind: 'daily', task: 'Write a report', timezone: 'Invalid/Place', local_time: '00:00' }, now), /invalid_timezone/);
});

test('scheduled packet retains brief, expected format, and acceptance criteria', () => {
  const packet = normalizeTriggerInput({
    kind: 'once', task: 'Write a short status report', brief: 'Use current UTC time.',
    output_format: 'plain_text', acceptance_criteria: 'One sentence with a verified date.',
    run_at: '2026-09-28T12:01:00Z',
  }, new Date('2026-09-28T12:00:00Z')).packet;
  assert.deepEqual(packet, {
    version: 1, task: 'Write a short status report', brief: 'Use current UTC time.',
    output_format: 'plain_text', acceptance_criteria: 'One sentence with a verified date.',
  });
  assert.throws(() => normalizeTriggerInput({
    kind: 'manual', task: 'Write a report', output_format: '../invalid',
  }), /invalid_task_packet/);
});
