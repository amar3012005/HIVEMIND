import test from 'node:test';
import assert from 'node:assert/strict';
import { CognitionLoop } from '../../src/memory/cognition-loop.js';

// H12: confidence must be bounded by ACTUAL SUPPORT (evidenceCountTotal), not
// just how many revisions a synthesis accrued. _capConfidence(raw, rev, evCount).
const cap = (raw, rev, ev) => CognitionLoop.prototype._capConfidence.call({}, raw, rev, ev);

test('rev4 with thin support (2 evidence) is capped at 0.85, not 0.98', () => {
  assert.equal(cap(0.99, 4, 2), 0.85);
});
test('rev4 with strong support (12 evidence) reaches 0.98', () => {
  assert.equal(cap(0.99, 4, 12), 0.98);
});
test('revision cap still binds when tighter than support (rev2 + 12 ev = 0.90)', () => {
  assert.equal(cap(0.99, 2, 12), 0.90);
});
test('6 evidence → 0.94 support band', () => {
  assert.equal(cap(0.99, 4, 6), 0.94);
});
test('null evidence count = revision-only (backward compatible)', () => {
  assert.equal(cap(0.99, 4, null), 0.98);
  assert.equal(cap(0.99, 1, null), 0.85);
});
test('rawConf below all caps passes through', () => {
  assert.equal(cap(0.50, 4, 12), 0.50);
});
