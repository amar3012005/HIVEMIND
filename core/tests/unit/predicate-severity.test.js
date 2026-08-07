import test from 'node:test';
import assert from 'node:assert/strict';
import { PredicateEngine } from '../../src/runtime-playbooks/predicate-engine.js';

// Structural guarantee: only REQUIRED checks may block a stage. A 'preferred' check
// that fails must degrade to a recorded gap so a substantively complete artifact is
// never discarded (and the todo never dead-ends) over a nice-to-have field.
const engine = new PredicateEngine();
const artifacts = { marketing_strategy: [{ key: 'marketing_strategy', data: { positioning: 'a wedge' }, source_refs: ['artifact-1'] }] };

test('a failing PREFERRED check does not block, and is reported as a gap', () => {
  const verdict = engine.validateChecks([
    { predicate: 'has_min_count', select: 'marketing_strategy', value: 1 },
    { predicate: 'all_have_nonempty_field', select: 'marketing_strategy', path: 'data.positioning' },
    { predicate: 'all_have_nonempty_field', select: 'marketing_strategy', path: 'data.recommended_next_motions', severity: 'preferred' },
  ], artifacts);
  assert.equal(verdict.passed, true, 'required checks all pass -> stage passes');
  assert.equal(verdict.unmet.length, 0, 'unmet carries only blocking failures');
  assert.equal(verdict.advisory_unmet.length, 1, 'the preferred miss is retained');
  assert.equal(verdict.gaps.length, 1, 'and surfaces as a gap');
});

test('a failing REQUIRED check still blocks', () => {
  const verdict = engine.validateChecks([
    { predicate: 'all_have_nonempty_field', select: 'marketing_strategy', path: 'data.audience' },
  ], artifacts);
  assert.equal(verdict.passed, false);
  assert.equal(verdict.unmet.length, 1);
  assert.equal(verdict.unmet[0].severity, 'required');
});

test('severity defaults to required (backward compatible)', () => {
  const verdict = engine.validateChecks([
    { predicate: 'all_have_nonempty_field', select: 'marketing_strategy', path: 'data.missing' },
  ], artifacts);
  assert.equal(verdict.passed, false, 'an unflagged check must keep blocking');
  assert.equal(verdict.results[0].severity, 'required');
});
