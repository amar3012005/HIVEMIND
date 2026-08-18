import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRecoverMissedAdminCheckinStart, shouldNarrateAdminCheckinDecision } from '../../src/hq-runtime/routes.js';

// Real incident, 2026-08-18: the browser widget's 'started' notification
// never reached the server (5 duplicate 'completed' POSTs logged instead,
// zero 'started' ever recorded) — the run stayed parked at
// capture_admin_choice forever, since 'completed' doesn't match that
// stage's wait (admin_checkin.started/skipped).
test('shouldRecoverMissedAdminCheckinStart fires exactly for the confirmed stuck case: completed, still at capture_admin_choice, not terminal', () => {
  assert.equal(shouldRecoverMissedAdminCheckinStart({ decision: 'completed', currentStageId: 'capture_admin_choice', status: 'WAITING_EVENT' }), true);
});

test('shouldRecoverMissedAdminCheckinStart does not fire once the run has already moved past capture_admin_choice', () => {
  assert.equal(shouldRecoverMissedAdminCheckinStart({ decision: 'completed', currentStageId: 'observe_browser_session', status: 'WAITING_EVENT' }), false);
  assert.equal(shouldRecoverMissedAdminCheckinStart({ decision: 'completed', currentStageId: 'analyze_current_status', status: 'ACTIVE' }), false);
});

test('shouldRecoverMissedAdminCheckinStart never fires for a terminal run, even if still tagged at capture_admin_choice', () => {
  assert.equal(shouldRecoverMissedAdminCheckinStart({ decision: 'completed', currentStageId: 'capture_admin_choice', status: 'COMPLETED' }), false);
  assert.equal(shouldRecoverMissedAdminCheckinStart({ decision: 'completed', currentStageId: 'capture_admin_choice', status: 'TERMINATED' }), false);
});

test('shouldRecoverMissedAdminCheckinStart never fires for a decision other than completed', () => {
  assert.equal(shouldRecoverMissedAdminCheckinStart({ decision: 'started', currentStageId: 'capture_admin_choice', status: 'WAITING_EVENT' }), false);
  assert.equal(shouldRecoverMissedAdminCheckinStart({ decision: 'skipped', currentStageId: 'capture_admin_choice', status: 'WAITING_EVENT' }), false);
});

test('shouldNarrateAdminCheckinDecision suppresses the exact confirmed-live no-op case: completed, stage never moved, still active', () => {
  assert.equal(shouldNarrateAdminCheckinDecision({ decision: 'completed', stageBefore: 'capture_admin_choice', stageAfter: 'capture_admin_choice', status: 'WAITING_EVENT' }), false);
});

test('shouldNarrateAdminCheckinDecision narrates once the stage genuinely advances', () => {
  assert.equal(shouldNarrateAdminCheckinDecision({ decision: 'started', stageBefore: 'capture_admin_choice', stageAfter: 'observe_browser_session', status: 'WAITING_EVENT' }), true);
  assert.equal(shouldNarrateAdminCheckinDecision({ decision: 'completed', stageBefore: 'observe_browser_session', stageAfter: 'analyze_current_status', status: 'ACTIVE' }), true);
});

test('shouldNarrateAdminCheckinDecision always narrates a skip, and always narrates a terminal outcome even without a stage change', () => {
  assert.equal(shouldNarrateAdminCheckinDecision({ decision: 'skipped', stageBefore: 'capture_admin_choice', stageAfter: 'capture_admin_choice', status: 'WAITING_EVENT' }), true);
  assert.equal(shouldNarrateAdminCheckinDecision({ decision: 'completed', stageBefore: 'record_current_status', stageAfter: 'record_current_status', status: 'COMPLETED' }), true);
});
