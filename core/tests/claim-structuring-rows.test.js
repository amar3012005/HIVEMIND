import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeClaimStructuringRows } from '../src/knowledge/document-first-ingestion.js';

test('claim structuring accepts at most one valid row per input memory', () => {
  const rows = normalizeClaimStructuringRows({ claims: [
    { i: 1, subject: 'Solvis', predicate: 'has_product', qualifiers: {} },
    { i: 1, subject: 'duplicate', predicate: 'must_not_overwrite' },
    { i: 2, subject: 'SolvisLeo', predicate: 'launches_on' },
    { i: 3, subject: 'outside batch', predicate: 'ignored' },
    { owner: 'nested qualifier object' },
  ] }, 2);
  assert.deepEqual(rows.map((row) => row.subject), ['Solvis', 'SolvisLeo']);
});

test('claim structuring rejects nested salvage objects without claim shape', () => {
  const rows = normalizeClaimStructuringRows([
    { scope: 'Germany' },
    { i: 1, qualifiers: { scope: 'Germany' } },
    { i: 1, subject: 'Solvis', predicate: 'operates_in' },
  ], 1);
  assert.deepEqual(rows, [{ i: 1, subject: 'Solvis', predicate: 'operates_in' }]);
});
