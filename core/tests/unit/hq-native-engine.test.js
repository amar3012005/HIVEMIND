import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FIRST_LIFE_ADMIN_CHECKIN_PLAYBOOK, resolveWorkResultTodo, adminCheckinDisposition, growthPlanModeForState, isPolicyBootstrapTodo, lifecycleSelectionObjective, operatingDecisionEvidenceRefs, playbookRunOwnsCapacity, selectPendingPlaybookRun, shouldAutoStartFirstLifeBootstrap, shouldOfferFirstLifeAdminCheckin, specialistWorkObjective, dailyCadenceEnabled, nextCadenceDueAt, cadenceIdempotencyKey, projectOperatingCycleBrief, buildOperatingCycleBrief, isRepeatCapabilityWait, projectRecentDecisions, projectStrategyTrace, occupiedLaneEffectClasses, freeLaneReadyTodo, resolveQueueExhaustedDisplayWakeAt } from '../../src/hq-runtime/native-engine.js';

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

test('current policy enters initial Growth Planning after the optional admin decision', () => {
  const policy = { runtime_selects_lifecycle: true, ongoing_operation: { growth_plan_enabled: true } };
  assert.equal(growthPlanModeForState({ policy, firstLifeGate: null }), 'initial_full');
  assert.equal(growthPlanModeForState({ policy, firstLifeGate: null, latestGrowthPlan: { id: 'plan' } }), null);
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

test('Runtime gives lifecycle selection the durable task title without changing the Room objective', () => {
  const todo = { title: 'Campaign-ready title', objective: 'Prepare the bounded work.' };
  assert.equal(specialistWorkObjective(todo), 'Prepare the bounded work.');
  assert.equal(lifecycleSelectionObjective(todo), 'Campaign-ready title\n\nPrepare the bounded work.');
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

test('authority waits and undeclared event waits retain lifecycle capacity until the playbook explicitly releases it', () => {
  assert.equal(playbookRunOwnsCapacity({ status: 'ACTIVE' }), true);
  assert.equal(playbookRunOwnsCapacity({ status: 'WAITING_AUTHORITY' }), true);
  assert.equal(playbookRunOwnsCapacity({ status: 'WAITING_EVENT', waitingFor: { types: ['some_other_event'] } }), true);
  assert.equal(playbookRunOwnsCapacity({ status: 'WAITING_EVENT', waitingFor: { releases_execution_slot: true } }), false);
  assert.equal(playbookRunOwnsCapacity({ status: 'COMPLETED' }), false);
});

// Regression: a run parked waiting on a missing connector must NEVER hold the
// company's execution slot, however long the human takes to connect it — this
// was root-caused live for org DIOR (2026-08-14/15): an X campaign sat
// WAITING_EVENT on the X connector for 30+ hours and silently blocked a fully
// independent, READY "Find Clients in New York" todo the entire time.
test('a capability.connected wait always releases lifecycle capacity, even without releases_execution_slot', () => {
  assert.equal(playbookRunOwnsCapacity({ status: 'WAITING_EVENT', waitingFor: { types: ['capability.connected'] } }), false);
  assert.equal(playbookRunOwnsCapacity({ status: 'WAITING_EVENT', waitingFor: { types: ['capability.connected'], releases_execution_slot: false } }), false);
  assert.equal(playbookRunOwnsCapacity({ status: 'WAITING_EVENT', waitingFor: { types: ['campaign.connection_changed', 'capability.connected', 'wait.timeout'] } }), false);
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

// Phase 1 of the recurring-operating-cycle build (2026-08-15): daily_cadence
// is the wake driven by the passage of time, not an external event — the fix
// for HQ going permanently quiet once the first Growth Plan's todos run out.
// Default-OFF so no currently-running org is affected until explicitly enabled.

test('dailyCadenceEnabled defaults to false and only flips on an explicit true', () => {
  const original = process.env.HQ_DAILY_CADENCE_ENABLED;
  try {
    delete process.env.HQ_DAILY_CADENCE_ENABLED;
    assert.equal(dailyCadenceEnabled(), false);
    process.env.HQ_DAILY_CADENCE_ENABLED = 'false';
    assert.equal(dailyCadenceEnabled(), false);
    process.env.HQ_DAILY_CADENCE_ENABLED = 'garbage';
    assert.equal(dailyCadenceEnabled(), false);
    process.env.HQ_DAILY_CADENCE_ENABLED = 'true';
    assert.equal(dailyCadenceEnabled(), true);
    process.env.HQ_DAILY_CADENCE_ENABLED = 'TRUE';
    assert.equal(dailyCadenceEnabled(), true);
  } finally {
    if (original === undefined) delete process.env.HQ_DAILY_CADENCE_ENABLED;
    else process.env.HQ_DAILY_CADENCE_ENABLED = original;
  }
});

test('nextCadenceDueAt lands on today\'s cadence hour if not yet passed, else tomorrow', () => {
  const original = process.env.HQ_DAILY_CADENCE_HOUR_UTC;
  try {
    process.env.HQ_DAILY_CADENCE_HOUR_UTC = '13';
    const before = new Date('2026-08-15T10:00:00.000Z');
    const due1 = nextCadenceDueAt(before);
    assert.equal(due1.toISOString(), '2026-08-15T13:00:00.000Z');

    const after = new Date('2026-08-15T14:00:00.000Z');
    const due2 = nextCadenceDueAt(after);
    assert.equal(due2.toISOString(), '2026-08-16T13:00:00.000Z');

    const exact = new Date('2026-08-15T13:00:00.000Z');
    const due3 = nextCadenceDueAt(exact);
    assert.equal(due3.toISOString(), '2026-08-16T13:00:00.000Z', 'never schedules in the past — exactly-at-hour rolls to tomorrow');
  } finally {
    if (original === undefined) delete process.env.HQ_DAILY_CADENCE_HOUR_UTC;
    else process.env.HQ_DAILY_CADENCE_HOUR_UTC = original;
  }
});

test('nextCadenceDueAt clamps an out-of-range hour instead of producing an invalid date', () => {
  const original = process.env.HQ_DAILY_CADENCE_HOUR_UTC;
  try {
    process.env.HQ_DAILY_CADENCE_HOUR_UTC = '99';
    const due = nextCadenceDueAt(new Date('2026-08-15T00:00:00.000Z'));
    assert.equal(due.toISOString(), '2026-08-15T23:00:00.000Z');
  } finally {
    if (original === undefined) delete process.env.HQ_DAILY_CADENCE_HOUR_UTC;
    else process.env.HQ_DAILY_CADENCE_HOUR_UTC = original;
  }
});

test('cadenceIdempotencyKey is stable per runtime+day and distinct across days — the dedup that prevents a wake storm', () => {
  const day1 = new Date('2026-08-15T13:00:00.000Z');
  const day1Again = new Date('2026-08-15T13:00:00.000Z');
  const day2 = new Date('2026-08-16T13:00:00.000Z');
  assert.equal(cadenceIdempotencyKey('runtime-a', day1), cadenceIdempotencyKey('runtime-a', day1Again));
  assert.notEqual(cadenceIdempotencyKey('runtime-a', day1), cadenceIdempotencyKey('runtime-a', day2));
  assert.notEqual(cadenceIdempotencyKey('runtime-a', day1), cadenceIdempotencyKey('runtime-b', day1));
  assert.equal(cadenceIdempotencyKey('runtime-a', day1), 'daily_cadence:runtime-a:2026-08-15');
});

// Phase 2 source-guard: runCycle has no dedicated integration test harness
// (confirmed: no test in this repo constructs NativeHqEngine and calls
// runCycle directly — every existing test exercises its extracted pure
// functions instead, which is why Phase 1 tests dailyCadenceEnabled/
// nextCadenceDueAt/cadenceIdempotencyKey directly). This locks in the wiring
// itself: a daily_cadence cycle must re-arm tomorrow's wake before anything
// else runs, gated on the live flag (not just on having been armed once).
test('a daily_cadence cycle self-rearms tomorrow\'s wake, gated on the live flag, before any other cycle logic', () => {
  const source = fs.readFileSync(
    new URL('../../src/hq-runtime/native-engine.js', import.meta.url), 'utf8',
  );
  const gateIndex = source.indexOf("if (trigger.type === 'daily_cadence' && dailyCadenceEnabled()) {");
  assert.ok(gateIndex > 0, 'expected a self-rearm block gated on both trigger.type and the live dailyCadenceEnabled() flag');
  const rearmCallIndex = source.indexOf('scheduleHqWake({', gateIndex);
  const rearmCall = source.slice(rearmCallIndex, rearmCallIndex + 400);
  assert.match(rearmCall, /triggerType: 'daily_cadence'/);
  assert.match(rearmCall, /idempotencyKey: cadenceIdempotencyKey\(/);
  assert.match(rearmCall, /dueAt: nextDueAt/);
  // Must appear before the first-plan/baseline bootstrap gates, so a crash
  // later in a cadence cycle can never prevent tomorrow's wake from existing.
  const baselineGateIndex = source.indexOf('const baselineMissingBeforeCollection');
  assert.ok(baselineGateIndex > 0 && gateIndex < baselineGateIndex,
    'self-rearm must run before the baseline/growth-plan bootstrap gates');
});

// Phase 3 of the recurring-operating-cycle build (2026-08-15): v7's recurring
// 'operate' mode could only ever fire ONE extra time (right after first-life
// motions complete), then latestGrowthPlan being non-null blocked it forever
// — not a real recurring loop. cadenceRequested lets a daily_cadence wake
// re-enter 'operate' even with a plan on file. Every existing call site is
// unaffected: cadenceRequested defaults false.
test('a daily_cadence wake can re-enter recurring operate mode even with an existing plan', () => {
  const v7Policy = {
    initial_lifecycle: { bypass_growth_plan: true },
    ongoing_operation: { growth_plan_enabled: true, mode: 'operate' },
  };
  const gate = { motions_complete: true };
  // Non-cadence: byte-identical to pre-Phase-3 behavior — a plan blocks replanning.
  assert.equal(growthPlanModeForState({ policy: v7Policy, firstLifeGate: gate, latestGrowthPlan: { id: 'plan' } }), null);
  // Cadence: the same existing plan no longer blocks it.
  assert.equal(growthPlanModeForState({ policy: v7Policy, firstLifeGate: gate, latestGrowthPlan: { id: 'plan' }, cadenceRequested: true }), 'operate');
  // A Room mid-lifecycle (focusedOutcome) still wins over cadence, always.
  assert.equal(growthPlanModeForState({ policy: v7Policy, firstLifeGate: gate, focusedOutcome: { id: 'todo' }, cadenceRequested: true }), null);
});

test('cadenceRequested never reactivates one-time bootstrap planning', () => {
  // initial_full is genuinely one-time — cadence must never re-trigger it,
  // only the recurring 'operate' path is cadence-eligible.
  const bootstrapPolicy = { runtime_selects_lifecycle: true, ongoing_operation: { growth_plan_enabled: true } };
  assert.equal(growthPlanModeForState({ policy: bootstrapPolicy, firstLifeGate: null, latestGrowthPlan: { id: 'plan' }, cadenceRequested: true }), null);
  assert.equal(growthPlanModeForState({ policy: bootstrapPolicy, firstLifeGate: null, cadenceRequested: true }), 'initial_full', 'no plan yet at all still bootstraps normally, cadence or not');
});

// Phase 4 of the recurring-operating-cycle build (2026-08-15): the
// operating_cycle_brief must be built ONLY from persisted state — this is
// the pure projection function, independently testable without a DB.
test('projectOperatingCycleBrief classifies todos by status into the right bucket', () => {
  const periodStartedAt = new Date('2026-08-14T13:00:00.000Z');
  const periodEndedAt = new Date('2026-08-15T13:00:00.000Z');
  const todos = [
    { id: 't-done-in-window', title: 'Shipped inside window', status: 'COMPLETED', completedAt: '2026-08-15T01:00:00.000Z' },
    { id: 't-done-before-window', title: 'Shipped before window', status: 'COMPLETED', completedAt: '2026-08-10T01:00:00.000Z' },
    { id: 't-blocked', title: 'Stuck on connector', status: 'WAITING_FOR_CONNECTOR', blockedReason: 'Missing: x' },
    { id: 't-waiting', title: 'Not started yet', status: 'PROPOSED' },
    { id: 't-ready', title: 'Next up', status: 'READY' },
    { id: 't-running', title: 'In flight', status: 'RUNNING' },
  ];
  const events = [
    { id: 'e-1', eventType: 'approval_required', title: 'Approval required: X', summary: 'Needs a human decision.' },
    { id: 'e-2', eventType: 'observation', title: 'Just narration', summary: 'Not a decision.' },
  ];
  const brief = projectOperatingCycleBrief({ todos, events, periodStartedAt, periodEndedAt });
  assert.equal(brief.schema, 'operating-cycle-brief.v1');
  assert.deepEqual(brief.completed.map((item) => item.todo_id), ['t-done-in-window']);
  assert.deepEqual(brief.blocked.map((item) => item.todo_id), ['t-blocked']);
  assert.deepEqual(brief.waiting.map((item) => item.todo_id).sort(), ['t-ready', 't-waiting']);
  assert.deepEqual(brief.decisions_needed.map((item) => item.event_id), ['e-1']);
  assert.deepEqual(brief.counts, { completed: 1, blocked: 1, waiting: 2, decisions_needed: 1 });
  assert.equal(brief.period.started_at, periodStartedAt.toISOString());
  assert.equal(brief.period.ended_at, periodEndedAt.toISOString());
});

test('projectOperatingCycleBrief reports zero counts on a genuinely quiet window — the no-change cycle', () => {
  const periodStartedAt = new Date('2026-08-14T13:00:00.000Z');
  const periodEndedAt = new Date('2026-08-15T13:00:00.000Z');
  const brief = projectOperatingCycleBrief({ todos: [], events: [], periodStartedAt, periodEndedAt });
  assert.deepEqual(brief.counts, { completed: 0, blocked: 0, waiting: 0, decisions_needed: 0 });
  assert.deepEqual(brief.completed, []);
  assert.deepEqual(brief.blocked, []);
});

// Strategy→objective→artifact trace (2026-08-15): growth_stage_id/constraint_id/
// success_measure already live on todo.context at creation (operating-loop.js) —
// this proves the brief surfaces them for every completed todo, not just status.
test('projectStrategyTrace reads growth_stage_id/constraint_id/success_measure straight off todo.context', () => {
  const todo = { context: { growth_stage_id: 'stage-1', constraint_id: 'constraint-1', success_measure: '3 replies within 48h' } };
  assert.deepEqual(projectStrategyTrace(todo), {
    growth_stage_id: 'stage-1', constraint_id: 'constraint-1', success_measure: '3 replies within 48h',
  });
});

test('projectStrategyTrace defaults to null on a todo with no context, never throws', () => {
  assert.deepEqual(projectStrategyTrace({}), { growth_stage_id: null, constraint_id: null, success_measure: null });
  assert.deepEqual(projectStrategyTrace({ context: null }), { growth_stage_id: null, constraint_id: null, success_measure: null });
});

test('projectOperatingCycleBrief attaches the strategy trace to every completed todo — why it shipped, not just that it did', () => {
  const periodStartedAt = new Date('2026-08-14T13:00:00.000Z');
  const periodEndedAt = new Date('2026-08-15T13:00:00.000Z');
  const todos = [{
    id: 't-done', title: 'Sent first outreach batch', status: 'COMPLETED', completedAt: '2026-08-15T01:00:00.000Z',
    context: { growth_stage_id: 'stage-9', constraint_id: 'constraint-9', success_measure: '5 replies in 72h' },
  }];
  const brief = projectOperatingCycleBrief({ todos, events: [], periodStartedAt, periodEndedAt });
  assert.deepEqual(brief.completed, [{
    todo_id: 't-done', title: 'Sent first outreach batch', completed_at: '2026-08-15T01:00:00.000Z',
    growth_stage_id: 'stage-9', constraint_id: 'constraint-9', success_measure: '5 replies in 72h',
  }]);
});

// Phase 5 — cadence regression suite. buildOperatingCycleBrief is the async
// DB-facing wrapper; projectOperatingCycleBrief (tested above) is the pure
// core it delegates to. This exercises the actual query shape with a mocked
// prisma, matching this repo's established mocked-prisma test convention
// (see tests/unit/work-room-reconciler.test.js).
test('buildOperatingCycleBrief queries only this runtime/org, scoped to the period window, and delegates to the pure projector', async () => {
  const calls = { hqTodoWhere: null, eventWhere: null };
  const prisma = {
    hqTodo: {
      findMany: async ({ where }) => { calls.hqTodoWhere = where; return [
        { id: 'todo-1', title: 'Done thing', status: 'COMPLETED', completedAt: '2026-08-15T05:00:00.000Z' },
      ]; },
    },
    hqRuntimeEvent: {
      findMany: async ({ where }) => { calls.eventWhere = where; return [
        { id: 'evt-1', eventType: 'capability_required', title: 'Need x', summary: 'Connect x.' },
      ]; },
    },
  };
  const runtime = { id: 'runtime-1', orgId: 'org-1' };
  const periodStartedAt = new Date('2026-08-14T13:00:00.000Z');
  const brief = await buildOperatingCycleBrief({ prisma, runtime, periodStartedAt });

  assert.equal(calls.hqTodoWhere.runtimeId, 'runtime-1');
  assert.equal(calls.hqTodoWhere.orgId, 'org-1');
  assert.equal(calls.eventWhere.runtimeId, 'runtime-1');
  assert.equal(calls.eventWhere.orgId, 'org-1');
  assert.equal(calls.eventWhere.createdAt.gte, periodStartedAt);

  assert.equal(brief.schema, 'operating-cycle-brief.v1');
  assert.equal(brief.counts.completed, 1);
  assert.equal(brief.counts.decisions_needed, 1);
  assert.equal(brief.completed[0].todo_id, 'todo-1');
});

test('buildOperatingCycleBrief propagates a query failure rather than silently returning an empty brief', async () => {
  const prisma = {
    hqTodo: { findMany: async () => { throw new Error('db unreachable'); } },
    hqRuntimeEvent: { findMany: async () => [] },
  };
  await assert.rejects(
    () => buildOperatingCycleBrief({ prisma, runtime: { id: 'r', orgId: 'o' }, periodStartedAt: new Date() }),
    /db unreachable/,
  );
  // Intentional: the caller (runCycle's daily_cadence branch) wraps this in
  // its own try/catch so a brief failure never blocks the self-rearm or
  // crashes the cycle — but the function itself must not swallow the error,
  // or a real, silent data-access bug would be indistinguishable from a
  // genuinely quiet cycle.
});

// Fix for a real production noise complaint (2026-08-15, org DIOR): the
// capacity/dedup fixes shipped earlier this session made scheduling correct
// (exactly one wake/minute, zero duplicate schedule rows) — but every one of
// those legitimate wakes still re-narrated the FULL "company in view / checked
// instructions / re-ranked queue / one task at a time / waiting for access"
// block even when nothing had changed since the last identical cycle. 191
// near-duplicate cycles were observed over 2h44m for a single disconnected
// connector. isRepeatCapabilityWait is the pure signature-comparison this
// suppression is built on.
test('isRepeatCapabilityWait only fires for connector_changed with a real, matching prior wait', () => {
  assert.equal(isRepeatCapabilityWait({ triggerType: 'connector_changed', lastObservationDetails: null, openCapabilityId: 'cap-1' }), false, 'no prior observation yet — never suppress the first time');
  assert.equal(isRepeatCapabilityWait({ triggerType: 'connector_changed', lastObservationDetails: {}, openCapabilityId: null }), false, 'nothing currently blocking — never suppress');
  assert.equal(isRepeatCapabilityWait({
    triggerType: 'connector_changed', lastObservationDetails: { capability_request_id: 'cap-1' }, openCapabilityId: 'cap-1',
  }), true, 'same connector still missing as last cycle — this IS the repeat to suppress');
  assert.equal(isRepeatCapabilityWait({
    triggerType: 'connector_changed', lastObservationDetails: { capability_request_id: 'cap-1' }, openCapabilityId: 'cap-2',
  }), false, 'a DIFFERENT capability is now the blocker — real change, must narrate');
  // Never suppress a human-initiated or otherwise-meaningful trigger, even
  // with an identical blocking reason — only the automated poll-driven
  // connector_changed repeat is noise.
  for (const triggerType of ['user_wake', 'instruction_updated', 'checkpoint', 'daily_cadence', 'work_result', 'queue_advance']) {
    assert.equal(isRepeatCapabilityWait({
      triggerType, lastObservationDetails: { capability_request_id: 'cap-1' }, openCapabilityId: 'cap-1',
    }), false, `${triggerType} must always narrate in full, never suppressed`);
  }
});

// First-life parallel burst (2026-08-15, per explicit request): every
// evidenced proposal from the first-life cohort dispatches together, in
// parallel, in the SAME cycle — every subsequent cycle goes back to strict
// one-at-a-time. This locks in the burst-detection wiring in runCycle
// (source-guard, matching this repo's convention for logic embedded in the
// large if/else dispatch chain rather than an extracted pure function).
test('runCycle detects a first-life burst (multiple simultaneously-READY siblings sharing activation_sprint_id) and dispatches all of them in one cycle', () => {
  const source = fs.readFileSync(
    new URL('../../src/hq-runtime/native-engine.js', import.meta.url), 'utf8',
  );
  const gateIndex = source.indexOf("} else if (readyTodo && (!roomInFlight || freeLaneTodo)) {");
  assert.ok(gateIndex > 0, 'expected the dispatch gate (idle burst OR a free lane) to still exist');
  const burstBlock = source.slice(gateIndex, gateIndex + 4800);
  assert.match(burstBlock, /const burstSiblings = !roomInFlight && readyTodo\.context\?\.activation_sprint_id/);
  assert.match(burstBlock, /todo\.status === 'READY'/);
  assert.match(burstBlock, /todo\.context\?\.activation_sprint_id === readyTodo\.context\.activation_sprint_id/);
  assert.match(burstBlock, /const todosToDispatchThisCycle = burstSiblings\.length > 1 \? burstSiblings\n\s*: crossLaneCandidate \? \[readyTodo, crossLaneCandidate\]\n\s*: freeLaneTodo \? \[freeLaneTodo\] : \[readyTodo\]/);
  assert.match(burstBlock, /for \(const readyTodo of todosToDispatchThisCycle\) \{/);
});

// Live incident (2026-08-17, org Singulance): the burst-dispatch for-loop
// called move('DIAGNOSING') then move('DELEGATING') INSIDE the per-todo loop.
// move() tracks one shared in-memory `state` for the whole cycle, so the
// SECOND todo's move('DIAGNOSING') attempted DELEGATING->DIAGNOSING, an
// invalid transition (see contracts.js HQ_TRANSITIONS: DELEGATING only
// allows WAITING/BLOCKED/PAUSED) — it threw, the scheduler's outer safety
// wrapper caught it ("HQ cycle failed safely"), and the whole cycle aborted
// before todos 3-5 were ever touched. Only 1 of 5 first-life burst todos
// actually dispatched, while the burst's own "N tasks start together"
// narration had already fired — the exact mismatch the founder saw live.
// Fix: the state transition happens ONCE before the loop, not once per todo.
test('runCycle moves DIAGNOSING->DELEGATING exactly once for the whole burst, not once per todo', () => {
  const source = fs.readFileSync(
    new URL('../../src/hq-runtime/native-engine.js', import.meta.url), 'utf8',
  );
  const gateIndex = source.indexOf("} else if (readyTodo && (!roomInFlight || freeLaneTodo)) {");
  const dispatchIndex = source.indexOf('for (const readyTodo of todosToDispatchThisCycle) {', gateIndex);
  assert.ok(dispatchIndex > gateIndex, 'expected the dispatch loop to still exist in this branch');
  const beforeLoop = source.slice(gateIndex, dispatchIndex);
  assert.match(beforeLoop, /await move\('DIAGNOSING'\);\s*\n\s*await move\('DELEGATING'\);/,
    'the state transition must happen BEFORE the loop, once for the whole dispatch');
  // The closing brace of the branch is the next "} else if (readyTodo && roomInFlight) {".
  const waitBranchIndex = source.indexOf('} else if (readyTodo && roomInFlight) {', dispatchIndex);
  const loopBody = source.slice(dispatchIndex, waitBranchIndex);
  assert.doesNotMatch(loopBody, /await move\('DIAGNOSING'\)/,
    "move('DIAGNOSING') must not be called again inside the per-todo loop — it would throw on the 2nd todo");
});

// Cross-domain parallelism, steady state (2026-08-15): when the room is
// completely idle (roomInFlight false — reached only inside this branch)
// and a second, genuinely independent lane (different effectClass) also has
// ready work, both start together instead of one waiting on the other.
test('runCycle also starts a second, genuinely independent lane when nothing is running anywhere (not just the first-life burst)', () => {
  const source = fs.readFileSync(
    new URL('../../src/hq-runtime/native-engine.js', import.meta.url), 'utf8',
  );
  const gateIndex = source.indexOf("} else if (readyTodo && (!roomInFlight || freeLaneTodo)) {");
  const burstBlock = source.slice(gateIndex, gateIndex + 4800);
  assert.match(burstBlock, /const crossLaneCandidate = !roomInFlight && burstSiblings\.length <= 1/);
  assert.match(burstBlock, /effectClass\(todo\) !== effectClass\(readyTodo\)/);
  assert.match(burstBlock, /crossLaneCandidate \? \[readyTodo, crossLaneCandidate\]\n\s*: freeLaneTodo \? \[freeLaneTodo\] : \[readyTodo\]/);
});

// Cross-domain parallelism, steady state (shipped 2026-08-16): the harder
// case deferred above — starting lane B while lane A is already running.
// freeLaneTodo is computed once right after roomInFlight and gates BOTH the
// dispatch branch (admits the free lane alongside in-flight work) and the
// wait branch (falls through here only when no free lane exists) — source-
// guarded so a future edit can't silently decouple the two conditions.
test('runCycle admits a genuinely free lane alongside in-flight work, and the wait branch only fires without one', () => {
  const source = fs.readFileSync(
    new URL('../../src/hq-runtime/native-engine.js', import.meta.url), 'utf8',
  );
  assert.match(source, /const freeLaneTodo = roomInFlight\s*\n\s*\? freeLaneReadyTodo\(\{ readyTodo, todos: capabilityState\.todos, capacityOwningRuns \}\)\s*\n\s*: null;/);
  assert.match(source, /\} else if \(readyTodo && \(!roomInFlight \|\| freeLaneTodo\)\) \{/);
  assert.match(source, /\} else if \(readyTodo && roomInFlight\) \{/);
});

// Journal-recall (2026-08-15): confirmed by direct recon that
// planner.js never queries growthJournal/hqCycle/hqRuntimeEvent — every
// growth plan was built from scratch with no memory of prior decisions.
// projectRecentDecisions is the pure projection feeding recent history
// through the existing additionalEvidence pass-through.
test('projectRecentDecisions compacts journal entries to a stable, prompt-safe shape', () => {
  const journal = [
    { eventType: 'decision', summary: 'Prioritized X-organic awareness', decision: { chosen: 'x_organic' }, createdAt: '2026-08-10T00:00:00Z' },
    { event_type: 'decision', summary: 'Snake_case variant', decision: { chosen: 'gmail' }, created_at: '2026-08-11T00:00:00Z' },
  ];
  assert.deepEqual(projectRecentDecisions(journal), [
    { event_type: 'decision', summary: 'Prioritized X-organic awareness', decision: { chosen: 'x_organic' }, created_at: '2026-08-10T00:00:00Z' },
    { event_type: 'decision', summary: 'Snake_case variant', decision: { chosen: 'gmail' }, created_at: '2026-08-11T00:00:00Z' },
  ]);
});

test('projectRecentDecisions never throws on missing/malformed input — a recall failure must not block planning', () => {
  assert.deepEqual(projectRecentDecisions(), []);
  assert.deepEqual(projectRecentDecisions(null), []);
  assert.deepEqual(projectRecentDecisions('not an array'), []);
  assert.deepEqual(projectRecentDecisions([null, undefined, {}]), [
    { event_type: null, summary: null, decision: null, created_at: null },
    { event_type: null, summary: null, decision: null, created_at: null },
    { event_type: null, summary: null, decision: null, created_at: null },
  ]);
});

// Cross-domain parallelism, steady state (2026-08-16): the harder case
// deferred when the idle-only version shipped. occupiedLaneEffectClasses /
// freeLaneReadyTodo are the pure attribution logic — no DB, fully testable.
function runningTodo(id, { effectClass: cls = 'internal' } = {}) {
  return { id, status: 'RUNNING', context: { effect_class: cls } };
}
function readyTodoOf(id, { effectClass: cls = 'internal' } = {}) {
  return { id, status: 'READY', context: { effect_class: cls } };
}
function capacityRun({ status = 'ACTIVE', waitingFor = null, todoId = 'running-1' } = {}) {
  return { id: `run-${todoId}`, status, waitingFor, trigger: { todo_id: todoId } };
}

test('occupiedLaneEffectClasses reads the lane straight off a RUNNING todo', () => {
  const todos = [runningTodo('t1', { effectClass: 'internal' })];
  assert.deepEqual(occupiedLaneEffectClasses({ todos, capacityOwningRuns: [] }), new Set(['internal']));
});

test('occupiedLaneEffectClasses resolves a WAITING_AUTHORITY run back to its owning todo via trigger.todo_id', () => {
  const todos = [{ id: 'running-1', status: 'WAITING_FOR_AUTHORITY', context: { effect_class: 'external' } }];
  const capacityOwningRuns = [capacityRun({ status: 'WAITING_AUTHORITY', todoId: 'running-1' })];
  assert.deepEqual(occupiedLaneEffectClasses({ todos, capacityOwningRuns }), new Set(['external']));
});

test('occupiedLaneEffectClasses ignores a WAITING_EVENT run parked on a missing connector — it never occupies a lane', () => {
  const todos = [{ id: 'running-1', status: 'WAITING_FOR_CONNECTOR', context: { effect_class: 'external' } }];
  const capacityOwningRuns = [capacityRun({
    status: 'WAITING_EVENT', waitingFor: { types: ['capability.connected'] }, todoId: 'running-1',
  })];
  assert.deepEqual(occupiedLaneEffectClasses({ todos, capacityOwningRuns }), new Set());
});

test('occupiedLaneEffectClasses fails SAFE (both lanes occupied) when a capacity-owning run cannot be attributed to a todo', () => {
  const capacityOwningRuns = [capacityRun({ status: 'ACTIVE', todoId: 'todo-not-in-fetched-set' })];
  assert.deepEqual(occupiedLaneEffectClasses({ todos: [], capacityOwningRuns }), new Set(['internal', 'external']));
});

test('freeLaneReadyTodo admits a READY todo in the other lane while one lane is occupied', () => {
  const todos = [runningTodo('running-1', { effectClass: 'internal' })];
  const readyTodo = readyTodoOf('ready-1', { effectClass: 'external' });
  assert.equal(freeLaneReadyTodo({ readyTodo, todos, capacityOwningRuns: [] }), readyTodo);
});

test('freeLaneReadyTodo refuses a READY todo in the SAME lane as the in-flight work', () => {
  const todos = [runningTodo('running-1', { effectClass: 'internal' })];
  const readyTodo = readyTodoOf('ready-1', { effectClass: 'internal' });
  assert.equal(freeLaneReadyTodo({ readyTodo, todos, capacityOwningRuns: [] }), null);
});

test('freeLaneReadyTodo refuses when occupancy cannot be attributed — fail safe, never risk a same-lane collision', () => {
  const capacityOwningRuns = [capacityRun({ status: 'ACTIVE', todoId: 'unresolvable' })];
  const readyTodo = readyTodoOf('ready-1', { effectClass: 'external' });
  assert.equal(freeLaneReadyTodo({ readyTodo, todos: [], capacityOwningRuns }), null);
});

test('freeLaneReadyTodo returns null when readyTodo is absent', () => {
  assert.equal(freeLaneReadyTodo({ readyTodo: null, todos: [], capacityOwningRuns: [] }), null);
});

test('resolveQueueExhaustedDisplayWakeAt prefers a sooner daily_cadence wake over a far declared checkpoint', () => {
  const now = new Date('2026-08-18T16:00:00.000Z');
  const declaredCheckpoint = new Date('2026-08-25T13:46:00.000Z'); // 7 days out — the real production trace
  const { displayDueAt, displayDueAtIsCadence } = resolveQueueExhaustedDisplayWakeAt({
    queueExhausted: true, dueAt: declaredCheckpoint, cadenceEnabled: true, now,
  });
  assert.equal(displayDueAtIsCadence, true);
  assert.ok(displayDueAt.getTime() < declaredCheckpoint.getTime(), 'must be sooner than the 7-day checkpoint');
  assert.deepEqual(displayDueAt, nextCadenceDueAt(now));
});

test('resolveQueueExhaustedDisplayWakeAt never picks cadence if it would be LATER than the declared checkpoint', () => {
  const now = new Date('2026-08-18T12:00:00.000Z');
  const soonCheckpoint = new Date('2026-08-18T12:30:00.000Z'); // sooner than cadence's default 13:00 UTC
  const { displayDueAt, displayDueAtIsCadence } = resolveQueueExhaustedDisplayWakeAt({
    queueExhausted: true, dueAt: soonCheckpoint, cadenceEnabled: true, now,
  });
  assert.equal(displayDueAtIsCadence, false);
  assert.deepEqual(displayDueAt, soonCheckpoint);
});

test('resolveQueueExhaustedDisplayWakeAt falls back to cadence even with no declared checkpoint at all', () => {
  const now = new Date('2026-08-18T16:00:00.000Z');
  const { displayDueAt, displayDueAtIsCadence } = resolveQueueExhaustedDisplayWakeAt({
    queueExhausted: true, dueAt: null, cadenceEnabled: true, now,
  });
  assert.equal(displayDueAtIsCadence, true);
  assert.deepEqual(displayDueAt, nextCadenceDueAt(now));
});

test('resolveQueueExhaustedDisplayWakeAt is a no-op when cadence is disabled', () => {
  const declaredCheckpoint = new Date('2026-08-25T13:46:00.000Z');
  const result = resolveQueueExhaustedDisplayWakeAt({ queueExhausted: true, dueAt: declaredCheckpoint, cadenceEnabled: false });
  assert.deepEqual(result, { displayDueAt: declaredCheckpoint, displayDueAtIsCadence: false });
});

test('resolveQueueExhaustedDisplayWakeAt is a no-op when the queue is not actually exhausted', () => {
  const declaredCheckpoint = new Date('2026-08-25T13:46:00.000Z');
  const result = resolveQueueExhaustedDisplayWakeAt({ queueExhausted: false, dueAt: declaredCheckpoint, cadenceEnabled: true });
  assert.deepEqual(result, { displayDueAt: declaredCheckpoint, displayDueAtIsCadence: false });
});
