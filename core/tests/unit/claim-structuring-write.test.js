import test from 'node:test';
import assert from 'node:assert/strict';

import { applyClaimPatchIfLive } from '../../src/knowledge/claim-structuring-write.js';

test('claim structuring skips a memory deleted before its response is applied', async () => {
  let updates = 0;
  const applied = await applyClaimPatchIfLive({
    getMemory: async () => null,
    updateMemory: async () => { updates += 1; },
  }, 'deleted-memory', { claimSubject: 'contract' });
  assert.equal(applied, false);
  assert.equal(updates, 0);
});

test('claim structuring closes the delete race without masking real failures', async () => {
  const missing = new Error('Record to update not found.');
  missing.code = 'P2025';
  assert.equal(await applyClaimPatchIfLive({
    getMemory: async () => ({ id: 'racing-memory' }),
    updateMemory: async () => { throw missing; },
  }, 'racing-memory', { claimPredicate: 'has_code' }), false);

  await assert.rejects(() => applyClaimPatchIfLive({
    getMemory: async () => ({ id: 'live-memory' }),
    updateMemory: async () => { throw new Error('database unavailable'); },
  }, 'live-memory', { claimSubject: 'agreement' }), /database unavailable/);
});

test('claim structuring applies a patch to a live memory', async () => {
  const seen = [];
  assert.equal(await applyClaimPatchIfLive({
    getMemory: async () => ({ id: 'live-memory' }),
    updateMemory: async (id, patch) => seen.push({ id, patch }),
  }, 'live-memory', { claimSubject: 'agreement' }), true);
  assert.deepEqual(seen, [{ id: 'live-memory', patch: { claimSubject: 'agreement' } }]);
});
