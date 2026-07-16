import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryStorageLabel, memoryStorageModeFor } from '../../src/storage/memory-storage-policy.js';

test('new managed personal workspaces default to embedded AMR', () => {
  assert.equal(memoryStorageModeFor('free', 'managed'), 'amr_embedded');
  assert.equal(memoryStorageLabel('amr_embedded'), '.amr filesystem');
});

test('enterprise remains hybrid and self-host stays BYOD', () => {
  assert.equal(memoryStorageModeFor('enterprise', 'managed'), 'hybrid');
  assert.equal(memoryStorageModeFor('scale', 'managed'), 'hybrid');
  assert.equal(memoryStorageModeFor('free', 'self_host'), 'byod_amr');
});
