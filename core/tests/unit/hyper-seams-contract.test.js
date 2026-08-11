// P1 — HyperAgents seam contract: version-tolerance rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SEAM_SCHEMA_VERSION,
  buildRoomTurnPayload,
  buildWorkRoomExecutionIdentity,
  normalizeTurnEvent,
} from '../../src/contracts/hyper-seams.js';

test('buildRoomTurnPayload stamps version + drops undefined/null', () => {
  const p = buildRoomTurnPayload({
    room_id: 'r', turn_id: 't', user_id: 'u', org_id: 'o', user_message: 'hi',
    project_id: undefined, room_goal: null, unknown_future_field: 'x',
  });
  assert.equal(p.schema_version, SEAM_SCHEMA_VERSION);
  assert.ok(!('project_id' in p), 'undefined dropped');
  assert.ok(!('room_goal' in p), 'null dropped');
  assert.ok(!('unknown_future_field' in p), 'unknown key not forwarded');
});

test('work room execution identity is immutable and pins one canonical turn', () => {
  const identity = buildWorkRoomExecutionIdentity({
    room_id: 'room-1', turn_id: 'turn-1', user_id: 'user-1', org_id: 'org-1',
  });
  assert.deepEqual(identity, {
    contract: 'work-room-execution.v1', execution_id: 'turn-1', room_id: 'room-1',
    turn_id: 'turn-1', user_id: 'user-1', org_id: 'org-1', epoch: 1,
  });
  assert.equal(Object.isFrozen(identity), true);
});

test('buildRoomTurnPayload preserves a caller-supplied schema_version (negotiation)', () => {
  const p = buildRoomTurnPayload({ room_id: 'r', turn_id: 't', user_id: 'u', org_id: 'o', user_message: 'hi', schema_version: '9' });
  assert.equal(p.schema_version, '9');
});

test('buildRoomTurnPayload preserves dedicated room and campaign routing context', () => {
  const p = buildRoomTurnPayload({
    room_id: 'r', turn_id: 't', user_id: 'u', org_id: 'o', user_message: 'audit search demand',
    task_tag: 'ROOM_SEO', campaign_id: 'c', campaign_brief: { goal: 'launch' },
    display_message: 'Launch campaign', execution_context: 'private contract',
  });
  assert.equal(p.task_tag, 'ROOM_SEO');
  assert.equal(p.campaign_id, 'c');
  assert.deepEqual(p.campaign_brief, { goal: 'launch' });
  assert.equal(p.display_message, 'Launch campaign');
  assert.equal(p.execution_context, 'private contract');
});

test('buildRoomTurnPayload throws on missing required field (fail fast)', () => {
  assert.throws(() => buildRoomTurnPayload({ room_id: 'r' }), /missing required field/);
});

test('normalizeTurnEvent defaults missing fields and never throws', () => {
  const e = normalizeTurnEvent({ turn_id: 'abc', event: { t: 'seal' } });
  assert.equal(e.turn_id, 'abc');
  assert.equal(e.event.status, 'complete'); // default
  assert.equal(e.event.cost_tokens, 0);     // default
  assert.equal(e.event.t, 'seal');
  // garbage input is tolerated
  assert.doesNotThrow(() => normalizeTurnEvent(null));
  assert.equal(normalizeTurnEvent(undefined).event.t, 'unknown');
});

test('normalizeTurnEvent preserves unknown event fields (forward-tolerant)', () => {
  const e = normalizeTurnEvent({ turn_id: 't', event: { t: 'progress', future_metric: 42, cost_tokens: '150' } });
  assert.equal(e.event.future_metric, 42);
  assert.equal(e.event.cost_tokens, 150); // coerced number
});
