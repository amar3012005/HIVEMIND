// Regression test for event-time ranking shipped in commits 5599e33 → 8c120e3.
// Pins the public contract of normalizeQueryTemporalTokens (the query → ingest-side
// ts:/time: tag mapping that drives the in-window pass and the answerStep trim).
//
// Why this test exists: the feature shipped + flipped default-ON before a unit
// test landed. Lock the behavior so future refactors can't silently regress it.
// All date math is UTC; `nowMs` is injected so tests are deterministic
// (`Date.now()` is the production default).

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQueryTemporalTokens } from '../../src/memory/persisted-retrieval.js';

// Reference moment: 2026-06-12 12:00 UTC = Friday. Picked because:
//   - has a known dow (friday)
//   - "yesterday" = thursday, 06-11
//   - "tomorrow" = saturday, 06-13
//   - middle of a normal month so "last month" doesn't straddle a year
const NOW = Date.parse('2026-06-12T12:00:00Z');

test('non-temporal query → returns [] (zero cost no-op)', () => {
  assert.deepEqual(normalizeQueryTemporalTokens('what is the recall architecture', NOW), []);
  assert.deepEqual(normalizeQueryTemporalTokens('Zephyr Dynamics Berlin office', NOW), []);
  assert.deepEqual(normalizeQueryTemporalTokens('', NOW), []);
  assert.deepEqual(normalizeQueryTemporalTokens(null, NOW), []);
  assert.deepEqual(normalizeQueryTemporalTokens(undefined, NOW), []);
});

test('"yesterday" → ts/time for 06-11 + dow:thursday', () => {
  const t = normalizeQueryTemporalTokens('what did we ship yesterday', NOW);
  assert.ok(t.includes('ts:2026-06-11'), 'must emit ts:2026-06-11');
  assert.ok(t.includes('time:2026-06-11'), 'must emit time:2026-06-11');
  assert.ok(t.includes('time:thursday'), 'must emit time:thursday (dow of yesterday)');
});

test('"today" / "today\'s" / "tonight" all resolve to today + dow:friday', () => {
  for (const q of ["what did we do today", "today's standup", 'tonight plan']) {
    const t = normalizeQueryTemporalTokens(q, NOW);
    assert.ok(t.includes('ts:2026-06-12'), `today phrase "${q}" must include ts:2026-06-12`);
    assert.ok(t.includes('time:friday'));
  }
});

test('"last week" → 7 trailing days (no future days)', () => {
  const t = normalizeQueryTemporalTokens('summarize last week', NOW);
  // 06-05 .. 06-11 (last 7 days BEFORE today)
  for (const day of ['2026-06-05', '2026-06-06', '2026-06-09', '2026-06-11']) {
    assert.ok(t.includes(`ts:${day}`), `last week must include ts:${day}`);
  }
  assert.ok(!t.includes('ts:2026-06-12'), 'last week MUST NOT include today');
  assert.ok(!t.includes('ts:2026-06-13'), 'last week MUST NOT include tomorrow');
});

test('"this week" → today + 6 prior (no future days)', () => {
  const t = normalizeQueryTemporalTokens('this week progress', NOW);
  assert.ok(t.includes('ts:2026-06-12'), 'this week must include today');
  assert.ok(t.includes('ts:2026-06-06'), 'this week must include today - 6');
  assert.ok(!t.includes('ts:2026-06-13'), 'this week MUST NOT include tomorrow');
  assert.ok(!t.includes('ts:2026-06-05'), 'this week MUST NOT extend past 7 days');
});

test('explicit ISO date in query → exact ts: + time: pair, nothing else date-wise', () => {
  const t = normalizeQueryTemporalTokens('what did we work on around 2026-06-06', NOW);
  assert.ok(t.includes('ts:2026-06-06'), 'must echo the ISO date as ts:');
  assert.ok(t.includes('time:2026-06-06'), 'must also emit time: form');
  // Should NOT emit a date range — single explicit date stays single
  const ts = t.filter(x => x.startsWith('ts:'));
  assert.equal(ts.length, 1, `explicit ISO should produce exactly one ts: tag, got ${ts.length}: ${ts.join(',')}`);
});

test('day-of-week mention → dow tag + most-recent occurrence date', () => {
  // NOW is Friday 06-12; "on monday" → previous Monday = 06-08
  const t = normalizeQueryTemporalTokens('what happened on monday', NOW);
  assert.ok(t.includes('time:monday'), 'must emit time:monday');
  assert.ok(t.includes('ts:2026-06-08'), 'must resolve to most-recent Monday (06-08)');
});

test('day-of-week today → resolves to today (0-diff branch)', () => {
  // "friday" on a Friday → today
  const t = normalizeQueryTemporalTokens('any updates friday', NOW);
  assert.ok(t.includes('time:friday'));
  assert.ok(t.includes('ts:2026-06-12'), 'friday on a Friday must resolve to today');
});

test('modal "may" must NOT be parsed as a month/day reference', () => {
  // Guard against the obvious false-positive — "may" the verb is everywhere.
  // The function intentionally does NOT parse bare month names (that lives in
  // expandTemporalQuery). normalizeQueryTemporalTokens only emits ts:/time:
  // tag candidates, and "may ship" should return [].
  assert.deepEqual(normalizeQueryTemporalTokens('we may ship next week', NOW).filter(t => t.includes('may')), [],
    'modal "may" must not produce a "may"-tagged candidate');
});

test('tag form matches ingest stamp (graph-engine.js writes ts:YYYY-MM-DD)', () => {
  // The recall pass filters on these tags via Qdrant any-match. If the format
  // ever diverges from graph-engine.js:511 (`ts:${day}` where day = ISO slice
  // 0..10), the filter silently drops everything. Pin the exact shape.
  const t = normalizeQueryTemporalTokens('yesterday', NOW);
  for (const tag of t) {
    assert.ok(/^(ts|time):/.test(tag), `every tag must start with ts: or time:, got "${tag}"`);
    if (tag.startsWith('ts:')) {
      assert.ok(/^ts:\d{4}-\d{2}-\d{2}$/.test(tag), `ts: tag must be ts:YYYY-MM-DD, got "${tag}"`);
    }
  }
});

test('"recently" / "lately" → trailing 4 days inclusive of today', () => {
  for (const q of ['recently', 'lately', 'past few days', 'last few days']) {
    const t = normalizeQueryTemporalTokens(`what happened ${q}`, NOW);
    assert.ok(t.includes('ts:2026-06-12'), `${q} must include today`);
    assert.ok(t.includes('ts:2026-06-09'), `${q} must include today - 3`);
    assert.ok(!t.includes('ts:2026-06-08'), `${q} MUST NOT extend past 4 days`);
  }
});

test('deterministic: same query + same nowMs ⇒ same tag set (order-insensitive)', () => {
  const a = normalizeQueryTemporalTokens('what did we do yesterday and last monday', NOW);
  const b = normalizeQueryTemporalTokens('what did we do yesterday and last monday', NOW);
  assert.deepEqual([...a].sort(), [...b].sort());
});
