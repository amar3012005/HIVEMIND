import test from 'node:test';
import assert from 'node:assert/strict';
import { addLane, emitKbResults } from '../../src/vector/mneme/kb-hit-merge.mjs';

const row = (id, extra = {}) => ({ segment_id: id, content: `c-${id}`, ...extra });

test('emits shard-only candidates, not just the first lane', () => {
  // The regression this file exists for: the result set used to be rebuilt from lane A's raw
  // response, so a candidate only the shard found could never be emitted — and reaching for
  // lane A's block-scoped response variable threw ReferenceError on every non-empty recall.
  const hits = new Map();
  addLane(hits, [{ id: 'q1', score: 0.9 }]);          // lane A — Qdrant
  addLane(hits, [{ id: 'q1', score: 0.1 }, { id: 's1', score: 0.7 }]); // lane B — shard

  const allowed = new Map([['q1', row('q1')], ['s1', row('s1')]]);
  const out = emitKbResults(hits, allowed);

  assert.deepEqual(out.map((r) => r.segment_id), ['q1', 's1']);
  assert.equal(out[0].score, 0.9, 'first lane to produce an id owns its score');
  assert.equal(out[1].score, 0.7, 'a shard-only candidate keeps the shard score');
});

test('drops candidates the access join did not return, whichever lane found them', () => {
  const hits = addLane(new Map(), [
    { id: 'visible', score: 0.8 },
    { id: 'forbidden', score: 0.95 },
  ]);
  // `allowed` is the post-appendDocumentAccess set: a higher-scoring hit the caller may not
  // see must not leak just because it ranked well.
  const out = emitKbResults(hits, new Map([['visible', row('visible')]]));
  assert.deepEqual(out.map((r) => r.segment_id), ['visible']);
});

test('empty candidate set emits nothing', () => {
  assert.deepEqual(emitKbResults(new Map(), new Map([['a', row('a')]])), []);
});

test('ignores malformed lane entries instead of emitting an undefined id', () => {
  const hits = addLane(new Map(), [null, {}, { score: 1 }, { id: 'ok' }]);
  assert.deepEqual([...hits.keys()], ['ok']);
  assert.equal(hits.get('ok'), 0, 'a hit with no numeric score scores 0, never NaN/undefined');
});
