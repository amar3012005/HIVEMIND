import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeImageAspectRatio } from '../../src/campaigns/image-provider.js';

test('campaign image provider maps channel ratios to supported provider ratios', () => {
  assert.equal(normalizeImageAspectRatio('16:9'), '3:2');
  assert.equal(normalizeImageAspectRatio('4:3'), '3:2');
  assert.equal(normalizeImageAspectRatio('9:16'), '2:3');
  assert.equal(normalizeImageAspectRatio('1:1'), '1:1');
  assert.equal(normalizeImageAspectRatio('unexpected'), 'auto');
});
