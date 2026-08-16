import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractionRetryDelayMs } from '../../src/knowledge/meeting-segment-extractor.js';

test('meeting segment extraction backoff is bounded and increases per retry', () => {
  assert.equal(extractionRetryDelayMs(1), 30_000);
  assert.equal(extractionRetryDelayMs(2), 60_000);
  assert.equal(extractionRetryDelayMs(20), 15 * 60 * 1000);
});
