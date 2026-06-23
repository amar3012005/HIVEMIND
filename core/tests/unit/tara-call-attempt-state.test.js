import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATES,
  INITIAL_STATE,
  TERMINAL_STATES,
  TRANSITIONS,
  isTerminal,
  canTransition,
  assertTransition,
  dialOutcomeToState,
} from '../../src/tara/call-attempt-state.js';

test('the documented happy path is fully traversable', () => {
  const path = ['queued', 'gated', 'dialing', 'connected', 'completed', 'done'];
  for (let i = 0; i < path.length - 1; i++) {
    assert.equal(canTransition(path[i], path[i + 1]), true, `${path[i]}→${path[i + 1]}`);
  }
});

test('gate-denied path: gated → skipped (terminal)', () => {
  assert.equal(canTransition('gated', 'skipped'), true);
  assert.equal(isTerminal('skipped'), true);
});

test('callback re-enqueues to queued', () => {
  assert.equal(canTransition('callback', 'queued'), true);
});

test('every dial outcome from dialing is legal', () => {
  for (const s of ['no_answer', 'voicemail', 'connected', 'failed']) {
    assert.equal(canTransition('dialing', s), true, `dialing→${s}`);
  }
});

test('illegal transitions are rejected', () => {
  assert.equal(canTransition('queued', 'connected'), false);
  assert.equal(canTransition('dialing', 'done'), false);
  assert.equal(canTransition('done', 'queued'), false);
  assert.equal(canTransition('skipped', 'dialing'), false);
});

test('assertTransition throws on illegal move', () => {
  assert.throws(() => assertTransition('queued', 'completed'), /illegal call-attempt transition/);
});

test('assertTransition throws on unknown states', () => {
  assert.throws(() => assertTransition('bogus', 'done'), /unknown source state/);
  assert.throws(() => assertTransition('queued', 'bogus'), /unknown target state/);
});

test('assertTransition returns the target on a legal move', () => {
  assert.equal(assertTransition('gated', 'dialing'), 'dialing');
});

test('terminal states have no outgoing transitions', () => {
  for (const s of TERMINAL_STATES) {
    assert.deepEqual(TRANSITIONS[s], []);
    assert.equal(isTerminal(s), true);
  }
});

test('initial state is queued and is non-terminal', () => {
  assert.equal(INITIAL_STATE, 'queued');
  assert.equal(isTerminal('queued'), false);
});

test('dialOutcomeToState maps Telnyx outcomes', () => {
  assert.equal(dialOutcomeToState('answered'), 'connected');
  assert.equal(dialOutcomeToState('machine'), 'voicemail');
  assert.equal(dialOutcomeToState('no-answer'), 'no_answer');
  assert.equal(dialOutcomeToState('busy'), 'no_answer');
  assert.equal(dialOutcomeToState('garbage'), 'failed');
});

test('dialOutcomeToState results are all reachable from dialing', () => {
  for (const o of ['answered', 'machine', 'no-answer', 'busy', 'weird']) {
    const s = dialOutcomeToState(o);
    assert.equal(canTransition('dialing', s), true, `dialing→${s} (from ${o})`);
  }
});

test('TRANSITIONS targets are all declared STATES (no typos)', () => {
  for (const [from, tos] of Object.entries(TRANSITIONS)) {
    assert.ok(STATES.includes(from), `source ${from} not in STATES`);
    for (const to of tos) {
      assert.ok(STATES.includes(to), `target ${to} (from ${from}) not in STATES`);
    }
  }
});

test('every non-terminal state can reach a terminal state', () => {
  // BFS from each state; assert it hits done or skipped.
  for (const start of STATES) {
    if (isTerminal(start)) continue;
    const seen = new Set([start]);
    const queue = [start];
    let reached = false;
    while (queue.length) {
      const cur = queue.shift();
      if (isTerminal(cur)) { reached = true; break; }
      for (const nxt of TRANSITIONS[cur] ?? []) {
        if (!seen.has(nxt)) { seen.add(nxt); queue.push(nxt); }
      }
    }
    assert.equal(reached, true, `${start} cannot reach a terminal state`);
  }
});
