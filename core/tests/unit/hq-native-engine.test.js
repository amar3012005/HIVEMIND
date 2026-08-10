import test from 'node:test';
import assert from 'node:assert/strict';
import { FIRST_LIFE_ADMIN_CHECKIN_PLAYBOOK, resolveWorkResultTodo, adminCheckinDisposition, growthPlanModeForState, isPolicyBootstrapTodo, operatingDecisionEvidenceRefs, playbookRunOwnsCapacity, selectPendingPlaybookRun, shouldAutoStartFirstLifeBootstrap, shouldOfferFirstLifeAdminCheckin } from '../../src/hq-runtime/native-engine.js';

test('first-life admin check-in always declares its immutable playbook identity', () => {
  assert.deepEqual(FIRST_LIFE_ADMIN_CHECKIN_PLAYBOOK, {
    id: 'operations.browser-admin-checkin-to-status',
    version: 1,
  });
});

test('optional first-life check-in never freezes the company: unverified/terminated runs proceed to planning', () => {
  // A run still in progress holds planning (administrator may add context).
  assert.equal(adminCheckinDisposition('WAITING_EVENT'), 'wait');
  assert.equal(adminCheckinDisposition('ACTIVE'), 'wait');
  assert.equal(adminCheckinDisposition('WAITING_AUTHORITY'), 'wait');
  // A completed run proceeds with its captured status.
  assert.equal(adminCheckinDisposition('COMPLETED'), 'proceed');
  // The regression: an exhausted/terminated optional check-in must proceed
  // (previously it moved the runtime to BLOCKED forever → wake-loop).
  assert.equal(adminCheckinDisposition('NEEDS_INTERVENTION'), 'proceed_unverified');
  assert.equal(adminCheckinDisposition('TERMINATED'), 'proceed_unverified');
  assert.equal(adminCheckinDisposition('FAILED'), 'proceed_unverified');
  // Defensive: unknown/absent status must never block; wait rather than freeze.
  assert.equal(adminCheckinDisposition(null), 'wait');
  assert.equal(adminCheckinDisposition('nEeDs_InTeRvEnTiOn'), 'proceed_unverified');
});

test('first-life admin check-in gates diagnosis only while the initial plan is absent', () => {
  assert.equal(shouldOfferFirstLifeAdminCheckin({
    initialPlanAbsent: true, optionalAdminCheckin: true, runtimePlaybooksAvailable: true,
  }), true);
  assert.equal(shouldOfferFirstLifeAdminCheckin({
    initialPlanAbsent: false, optionalAdminCheckin: true, runtimePlaybooksAvailable: true,
  }), false);
});

test('v7 bypasses initial Growth Planning and enables operate mode only after first-life outcomes', () => {
  const policy = {
    initial_lifecycle: { bypass_growth_plan: true },
    ongoing_operation: { growth_plan_enabled: true, mode: 'operate' },
  };
  assert.equal(growthPlanModeForState({ policy, firstLifeGate: null }), null);
  assert.equal(growthPlanModeForState({ policy, firstLifeGate: { motions_complete: false } }), null);
  assert.equal(growthPlanModeForState({ policy, firstLifeGate: { motions_complete: true } }), 'operate');
  assert.equal(growthPlanModeForState({ policy, firstLifeGate: { motions_complete: true }, latestGrowthPlan: { id: 'plan' } }), null);
  assert.equal(growthPlanModeForState({ policy, firstLifeGate: { motions_complete: true }, focusedOutcome: { id: 'todo' } }), null);
});

test('admin check-in result wakes can auto-start the durable internal bootstrap', () => {
  const todo = { context: {
    effect_class: 'internal',
    planned_playbook_id: 'marketing.strategy-to-growth-brief',
    planned_playbook_version: 5,
  } };
  assert.equal(shouldAutoStartFirstLifeBootstrap({
    activationStatus: 'AWAITING_START', policy: { auto_start_internal_bootstrap: true }, todo,
  }), true);
  assert.equal(shouldAutoStartFirstLifeBootstrap({
    activationStatus: 'READY', policy: { auto_start_internal_bootstrap: true }, todo,
  }), true);
  assert.equal(shouldAutoStartFirstLifeBootstrap({
    activationStatus: 'OPERATING', policy: { auto_start_internal_bootstrap: true }, todo,
  }), false);
  assert.equal(shouldAutoStartFirstLifeBootstrap({
    activationStatus: 'READY', policy: { auto_start_internal_bootstrap: false }, todo,
  }), false);
});

test('only a policy-created bootstrap may retain a preselected lifecycle', () => {
  assert.equal(isPolicyBootstrapTodo({ context: { proposal_origin: 'first_life_bootstrap', planned_playbook_id: 'marketing.strategy-to-growth-brief' } }), true);
  assert.equal(isPolicyBootstrapTodo({ context: { proposal_origin: 'strategy_program', planned_playbook_id: 'outreach.direct-message' } }), false);
  assert.equal(isPolicyBootstrapTodo({ context: { proposal_origin: 'user_instruction' } }), false);
});

test('first-life fallback narration does not require a Growth Plan artifact', () => {
  assert.deepEqual(operatingDecisionEvidenceRefs({ baseline: { id: 'baseline-1' }, latest_growth_plan: null }), ['baseline-1']);
  assert.deepEqual(operatingDecisionEvidenceRefs({ baseline: null, latest_growth_plan: null }), []);
});

test('active Room work outranks an older lifecycle wait in Runtime narration', () => {
  const waiting = { id: 'old-wait', status: 'WAITING_EVENT' };
  const authority = { id: 'approval', status: 'WAITING_AUTHORITY' };
  const active = { id: 'current-room', status: 'ACTIVE' };
  assert.equal(selectPendingPlaybookRun([waiting, authority, active]), active);
  assert.equal(selectPendingPlaybookRun([waiting, authority]), authority);
});

test('capability and authority waits retain lifecycle capacity until the playbook explicitly releases it', () => {
  assert.equal(playbookRunOwnsCapacity({ status: 'ACTIVE' }), true);
  assert.equal(playbookRunOwnsCapacity({ status: 'WAITING_AUTHORITY' }), true);
  assert.equal(playbookRunOwnsCapacity({ status: 'WAITING_EVENT', waitingFor: { types: ['capability.connected'] } }), true);
  assert.equal(playbookRunOwnsCapacity({ status: 'WAITING_EVENT', waitingFor: { releases_execution_slot: true } }), false);
  assert.equal(playbookRunOwnsCapacity({ status: 'COMPLETED' }), false);
});

test('HQ work-result reconciliation never reads a missing work order or result', () => {
  assert.equal(resolveWorkResultTodo({ order: null, result: null }), null);
  assert.equal(resolveWorkResultTodo({ order: { inputSnapshot: { todo_id: 'todo-1' } }, result: null }), null);
  assert.equal(resolveWorkResultTodo({ order: null, result: { output: { todo_id: 'todo-1' } } }), null);
});

test('HQ work-result reconciliation prefers returned todo ownership and falls back to the Work Order snapshot', () => {
  const order = { inputSnapshot: { todo_id: 'todo-from-order' } };
  assert.deepEqual(
    resolveWorkResultTodo({ order, result: { output: { todo_id: 'todo-from-result', evidence: ['resource-1'] } } }),
    { todoId: 'todo-from-result', resultOutput: { todo_id: 'todo-from-result', evidence: ['resource-1'] } },
  );
  assert.deepEqual(
    resolveWorkResultTodo({ order, result: { output: null } }),
    { todoId: 'todo-from-order', resultOutput: {} },
  );
});
