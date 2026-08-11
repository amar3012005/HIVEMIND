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

test('stuck-turn recovery preserves the persisted Work Room mode', () => {
  assert.match(source, /SELECT project_id, goal, room_tag, room_mode FROM/);
  assert.match(source, /room_mode:\s*_sweepRoomMode/);
});

test('work rooms expose one durable work-plan projection', () => {
  assert.match(source, /hyper-rooms.*work-plan/);
  assert.match(source, /"hyper_work_orders"/);
  assert.match(source, /plan_step_id/);
  assert.match(source, /status === 'blocked' \? 'needs_attention'/);
  assert.match(source, /status === 'running' \? 'active'/);
  assert.match(source, /wo\.wait_for, wo\.handoff/);
});

test('a waiting Work Room step resumes under its existing work-order identity', () => {
  assert.match(source, /roomWorkPlanResumeMatch/);
  assert.match(source, /contract: 'work-room-resume\.v1'/);
  assert.match(source, /hq_cycle_id IS NULL/);
  assert.match(source, /status = 'queued'/);
});

test('a completed Work Room handoff enters HQ as an instruction without bypassing semantic selection', () => {
  assert.match(source, /roomWorkPlanHandoffMatch/);
  assert.match(source, /Only a completed, evidenced work step can be handed to Runtime/);
  assert.match(source, /The Room turn must complete verification before Runtime handoff/);
  assert.match(source, /event\?\.t === 'verify' && event\?\.met === true/);
  assert.match(source, /COALESCE\(resume_turn\.status, source_turn\.status\) AS effective_turn_status/);
  assert.match(source, /source: 'work_room_handoff', execution_mode: 'single_outcome'/);
  assert.match(source, /triggerType: 'instruction_updated'/);
  assert.doesNotMatch(source, /roomWorkPlanHandoffMatch[\s\S]{0,8000}hqTodo\.create/);
});
