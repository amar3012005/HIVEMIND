import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceWindowSizeForDepth } from '../../src/agent/progressive-recall-session.js';

test('durable orchestration preserves Chat V2 final evidence depth contracts', () => {
  assert.equal(evidenceWindowSizeForDepth('standard'), 5);
  assert.equal(evidenceWindowSizeForDepth('detailed'), 10);
  assert.equal(evidenceWindowSizeForDepth('comprehensive'), 15);
  assert.equal(evidenceWindowSizeForDepth('detailed', { nativeSingleCall: true }), 15);
});

test('unknown depth remains the stable top-5 compatibility path', () => {
  assert.equal(evidenceWindowSizeForDepth('unexpected'), 5);
  assert.equal(evidenceWindowSizeForDepth(), 5);
});
