import test from 'node:test';
import assert from 'node:assert/strict';
import { autoExecuteEnabled } from '../../src/growth/operating-loop.js';

// Auto-execute removes the first-life Start gate: opportunities commit READY and the
// queue drains without a human click (outward sends stay approval-gated elsewhere).
// Default OFF preserves the first-life "propose then Start" behaviour exactly.
test('autoExecuteEnabled: default off keeps the first-life Start gate', () => {
  delete process.env.HQ_AUTO_EXECUTE;
  assert.equal(autoExecuteEnabled({}), false);
  assert.equal(autoExecuteEnabled({ policy: { autonomy_mode: 'MANUAL_REVIEW' } }), false);
});

test('autoExecuteEnabled: AUTONOMOUS policy auto-executes (case-insensitive)', () => {
  delete process.env.HQ_AUTO_EXECUTE;
  assert.equal(autoExecuteEnabled({ policy: { autonomy_mode: 'AUTONOMOUS' } }), true);
  assert.equal(autoExecuteEnabled({ policy: { autonomy_mode: 'autonomous' } }), true);
});

test('autoExecuteEnabled: env flag forces auto-execute and overrides a manual policy', () => {
  process.env.HQ_AUTO_EXECUTE = 'true';
  try {
    assert.equal(autoExecuteEnabled({}), true);
    assert.equal(autoExecuteEnabled({ policy: { autonomy_mode: 'MANUAL_REVIEW' } }), true);
  } finally {
    delete process.env.HQ_AUTO_EXECUTE;
  }
});
