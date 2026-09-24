import test from 'node:test';
import assert from 'node:assert/strict';
import { canAdmitMemoryEstimate } from '../src/admission.js';

test('memory admission rejects one request larger than the entire budget', () => {
  assert.equal(canAdmitMemoryEstimate({ estimatedBytes: 1_500, inFlightBytes: 0, maxBytes: 1_200 }), false);
});

test('memory admission accounts for both active work and the next request', () => {
  assert.equal(canAdmitMemoryEstimate({ estimatedBytes: 700, inFlightBytes: 500, maxBytes: 1_200 }), true);
  assert.equal(canAdmitMemoryEstimate({ estimatedBytes: 701, inFlightBytes: 500, maxBytes: 1_200 }), false);
});

test('memory admission permits an empty estimate without exceeding a zero active budget', () => {
  assert.equal(canAdmitMemoryEstimate({ estimatedBytes: 0, inFlightBytes: 0, maxBytes: 0 }), true);
});
