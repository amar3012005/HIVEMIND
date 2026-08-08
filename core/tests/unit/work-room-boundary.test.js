import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve('src/control-plane-server.js'), 'utf8');

test('human company tasks open neutral Work Rooms rather than tagged Company Rooms', () => {
  assert.match(source, /roomMode:\s*'work',\s*\n\s*roomTag:\s*'general'/);
  assert.match(source, /room_mode:\s*'work',\s*task_tag:\s*'WORK'/);
  assert.match(source, /task\.legacy_room_id\s*=\s*task\.room_id/);
  assert.match(source, /function roomExecutionMode\(room\)/);
});

test('follow-up turns preserve the persisted execution boundary', () => {
  assert.match(source, /room_mode:\s*roomExecutionMode\(room\)/);
  assert.match(source, /task_tag:\s*roomExecutionTag\(room\)/);
  assert.match(source, /roomMode:\s*'runtime'/);
});

test('work rooms expose one durable work-plan projection', () => {
  assert.match(source, /hyper-rooms.*work-plan/);
  assert.match(source, /"hyper_work_orders"/);
  assert.match(source, /plan_step_id/);
  assert.match(source, /status === 'blocked' \? 'needs_attention' : status/);
});
