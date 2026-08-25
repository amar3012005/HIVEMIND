import test from 'node:test';
import assert from 'node:assert/strict';

import { exactMemoryListTotal } from '../../src/memory/memory-list-contract.js';

test('accepts an exact filtered total including zero', () => {
  assert.deepEqual(exactMemoryListTotal(0), { ok: true, total: 0 });
  assert.deepEqual(exactMemoryListTotal(17), { ok: true, total: 17 });
});

test('rejects missing or invalid totals with a typed service response', () => {
  for (const value of [null, undefined, NaN, -1]) {
    const result = exactMemoryListTotal(value);
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(result.body.code, 'REMOTE_MEMORY_LIST_TOTAL_UNAVAILABLE');
  }
});
