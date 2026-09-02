import test from 'node:test';
import assert from 'node:assert/strict';
import { activateEligibleFirstLifeWork, ensureFirstLifeBootstrapProposal, projectCurrentFirstLife } from '../../src/hq-runtime/first-life-control.js';

function todo(id, status, rank, effect, recommended = false) {
  return {
    id, runtimeId: 'runtime-1', orgId: 'org-1', status, priority: rank, position: rank,
    context: {
      first_life_policy_id: 'runtime.first-life-policy',
      first_life_policy_version: 3,
      runtime_epoch: 'epoch-1',
      recommendation_rank: rank,
      effect_class: effect,
      recommended,
      planned_playbook_id: 'test.lifecycle',
      planned_playbook_version: 1,
      requested_action: 'execute',
    },
  };
}

function prismaFor(rows, authorityPolicy = { external_default: 'manual', internal_autonomy: true }) {
  return {
    $transaction: async (callback) => callback({
      $queryRawUnsafe: async () => [{ id: 'runtime-1', authority_policy: authorityPolicy }],
      hqRuntime: { updateMany: async () => ({ count: 1 }) },
      hqTodo: {
        findMany: async () => rows,
        updateMany: async ({ where, data }) => {
          const row = rows.find((item) => item.id === where.id && (
            typeof where.status === 'string' ? item.status === where.status
              : !where.status?.notIn?.includes(item.status)
          ));
          if (!row) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        },
      },
      runtimePlaybookRun: { findMany: async () => [] },
    }),
  };
}

const runtime = { id: 'runtime-1', orgId: 'org-1', epoch: 'epoch-1' };

test('v7 creates one epoch-scoped policy-selected bootstrap and never duplicates it', async () => {
  const rows = [];
  const tx = {
    $queryRawUnsafe: async () => [{ id: runtime.id, epoch: runtime.epoch }],
    hqTodo: {
      findFirst: async ({ where }) => rows.find((row) => row.context.first_life_bootstrap_key === where.context.equals) || null,
      create: async ({ data }) => {
        const row = { id: `todo-${rows.length + 1}`, ...data };
        rows.push(row);
        return row;
      },
    },
    hyperRoom: { findFirst: async () => ({ id: 'marketing-room' }) },
  };
  const prisma = { $transaction: async (callback) => callback(tx) };
  const policy = {
    policy_id: 'runtime.first-life-policy', version: 7,
    initial_lifecycle: {
      playbook_id: 'marketing.strategy-to-growth-brief', version: 5,
      supported_action: 'formulate_go_to_market_strategy', bypass_growth_plan: true,
    },
  };
  const registry = { get: () => ({
    playbook_id: policy.initial_lifecycle.playbook_id,
    version: 5,
    name: 'Marketing strategy to first-life program',
    description: 'Build one strategy program.',
    metadata: {
      owner_room_tag: 'marketing', effect_class: 'internal',
      supported_actions: ['formulate_go_to_market_strategy'],
      terminal_states_by_action: { formulate_go_to_market_strategy: ['strategy_program_ready'] },
    },
    stages: [], terminal_states: ['strategy_program_ready'],
  }) };
  const input = {
    prisma, runtime, policy, registry, company: { name: 'Example' }, baseline: { id: 'baseline-1' },
    connectedCapabilities: ['maps'], instruction: 'Run the company.',
  };
  const first = await ensureFirstLifeBootstrapProposal(input);
  const second = await ensureFirstLifeBootstrapProposal(input);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'PROPOSED');
  assert.equal(rows[0].context.execution_mode, 'first_life_bootstrap');
  assert.equal(rows[0].context.planned_playbook_id, 'marketing.strategy-to-growth-brief');
  assert.equal(rows[0].context.first_life_policy_version, 7);
});

test('v3 first start promotes only the recommendation', async () => {
  const rows = [
    todo('external-1', 'PROPOSED', 1, 'external', true),
    todo('internal-1', 'PROPOSED', 2, 'internal'),
    todo('external-2', 'PROPOSED', 3, 'external'),
    todo('internal-2', 'PROPOSED', 4, 'internal'),
  ];
  const result = await activateEligibleFirstLifeWork({
    prisma: prismaFor(rows), runtime, expansionTrigger: 'user_start',
  });
  assert.deepEqual(result.promoted.map((item) => item.id), ['external-1']);
  assert.deepEqual(rows.map((item) => item.status), ['READY', 'PROPOSED', 'PROPOSED', 'PROPOSED']);
});

test('v5 internal bootstrap starts only the evidence-only recommendation', async () => {
  const rows = [
    todo('strategy', 'PROPOSED', 1, 'internal', true),
    todo('external-1', 'PROPOSED', 2, 'external'),
  ];
  rows.forEach((row) => { row.context.first_life_policy_version = 5; });
  const result = await activateEligibleFirstLifeWork({
    prisma: prismaFor(rows), runtime, expansionTrigger: 'internal_bootstrap',
  });
  assert.deepEqual(result.promoted.map((item) => item.id), ['strategy']);
  assert.deepEqual(rows.map((item) => item.status), ['READY', 'PROPOSED']);
});

test('v6 starts the internal strategy bootstrap without a user Start decision', async () => {
  const rows = [
    todo('strategy', 'PROPOSED', 1, 'internal', true),
    todo('external-1', 'PROPOSED', 2, 'external'),
  ];
  rows.forEach((row) => { row.context.first_life_policy_version = 6; });
  const result = await activateEligibleFirstLifeWork({
    prisma: prismaFor(rows), runtime, expansionTrigger: 'internal_bootstrap',
  });
  assert.deepEqual(result.promoted.map((item) => item.id), ['strategy']);
  assert.deepEqual(rows.map((item) => item.status), ['READY', 'PROPOSED']);
});

test('v6 strategy portfolio promotes exactly one Room lifecycle at a time', async () => {
  const rows = [
    todo('motion-1', 'PROPOSED', 1, 'external', true),
    todo('motion-2', 'PROPOSED', 2, 'external'),
    todo('motion-3', 'PROPOSED', 3, 'internal'),
  ];
  rows.forEach((row) => {
    row.context.first_life_policy_version = 6;
    row.context.proposal_origin = 'strategy_program';
  });
  const result = await activateEligibleFirstLifeWork({
    prisma: prismaFor(rows), runtime, expansionTrigger: 'strategy_program_ready', proposalOrigin: 'strategy_program',
  });
  assert.deepEqual(result.promoted.map((item) => item.id), ['motion-1']);
  assert.deepEqual(rows.map((item) => item.status), ['READY', 'PROPOSED', 'PROPOSED']);
});

// Design change (2026-08-15, per explicit request): the first-life "wow
// batch" should start every evidenced proposal from the cohort in parallel,
// not one recommendation at a time — the founder should see the company
// move on multiple fronts immediately. Every trigger AFTER that first burst
// (verified_result, capability_wait_release, verified_monitoring_checkpoint,
// daily cadence's 'operate' mode, etc.) is unaffected and still promotes one
// bounded task at a time, exactly as before.
test('v12 Growth Plan initial_plan_ready promotes the ENTIRE first-life batch in parallel', async () => {
  const rows = [
    todo('growth-1', 'PROPOSED', 1, 'external', true),
    todo('growth-2', 'PROPOSED', 2, 'external'),
    todo('growth-3', 'PROPOSED', 3, 'internal'),
  ];
  rows.forEach((row) => {
    row.context.first_life_policy_version = 12;
    row.context.proposal_origin = 'growth_plan';
    delete row.context.planned_playbook_id;
    delete row.context.planned_playbook_version;
    delete row.context.requested_action;
    delete row.context.room_tag;
  });
  const prisma = prismaFor(rows);
  const result = await activateEligibleFirstLifeWork({ prisma, runtime, expansionTrigger: 'initial_plan_ready' });
  assert.deepEqual(result.promoted.map((item) => item.id), ['growth-1', 'growth-2', 'growth-3']);
  assert.deepEqual(rows.map((item) => item.status), ['READY', 'READY', 'READY']);
});

test('v15 Growth Plan initial_plan_ready promotes only the recommended task', async () => {
  const rows = [
    todo('growth-1', 'PROPOSED', 1, 'external', true),
    todo('growth-2', 'PROPOSED', 2, 'external'),
    todo('growth-3', 'PROPOSED', 3, 'internal'),
  ];
  rows.forEach((row) => {
    row.context.first_life_policy_version = 15;
    row.context.proposal_origin = 'growth_plan';
    delete row.context.planned_playbook_id;
    delete row.context.planned_playbook_version;
    delete row.context.requested_action;
    delete row.context.room_tag;
  });
  const result = await activateEligibleFirstLifeWork({ prisma: prismaFor(rows), runtime, expansionTrigger: 'initial_plan_ready' });
  assert.deepEqual(result.promoted.map((item) => item.id), ['growth-1']);
  assert.deepEqual(rows.map((item) => item.status), ['READY', 'PROPOSED', 'PROPOSED']);
});

test('post-burst work still advances strictly one-by-one — the parallel burst is a one-time exception, not the new steady state', async () => {
  // Simulates cadence-driven daily operation: new proposals arriving AFTER
  // the first-life burst already ran (different activation_sprint_id / no
  // burst context at all). A non-initial_plan_ready trigger must still only
  // ever promote one recommendation at a time.
  const rows = [
    todo('daily-1', 'PROPOSED', 1, 'external', true),
    todo('daily-2', 'PROPOSED', 2, 'external'),
    todo('daily-3', 'PROPOSED', 3, 'internal'),
  ];
  rows.forEach((row) => {
    row.context.first_life_policy_version = 12;
    row.context.proposal_origin = 'growth_plan';
    delete row.context.planned_playbook_id;
    delete row.context.planned_playbook_version;
    delete row.context.requested_action;
    delete row.context.room_tag;
  });
  const prisma = prismaFor(rows);
  const first = await activateEligibleFirstLifeWork({ prisma, runtime, expansionTrigger: 'verified_result' });
  assert.deepEqual(first.promoted.map((item) => item.id), ['daily-1']);
  assert.deepEqual(rows.map((item) => item.status), ['READY', 'PROPOSED', 'PROPOSED']);

  rows[0].status = 'COMPLETED';
  const second = await activateEligibleFirstLifeWork({ prisma, runtime, expansionTrigger: 'verified_result' });
  assert.deepEqual(second.promoted.map((item) => item.id), ['daily-2']);
  assert.deepEqual(rows.map((item) => item.status), ['COMPLETED', 'READY', 'PROPOSED']);
});

test('v2 first start retains the historical companion-work policy', async () => {
  const rows = [
    todo('external-1', 'PROPOSED', 1, 'external', true),
    todo('internal-1', 'PROPOSED', 2, 'internal'),
  ];
  rows.forEach((row) => { row.context.first_life_policy_version = 2; });
  const result = await activateEligibleFirstLifeWork({
    prisma: prismaFor(rows), runtime, expansionTrigger: 'user_start',
  });
  assert.deepEqual(result.promoted.map((item) => item.id), ['external-1', 'internal-1']);
});

test('first start leaves an unbound proposal dormant instead of guessing a lifecycle', async () => {
  const external = todo('external-1', 'PROPOSED', 1, 'external', true);
  const internal = todo('internal-1', 'PROPOSED', 2, 'internal');
  delete internal.context.planned_playbook_id;
  delete internal.context.planned_playbook_version;
  delete internal.context.requested_action;
  const result = await activateEligibleFirstLifeWork({
    prisma: prismaFor([external, internal]), runtime, expansionTrigger: 'user_start',
  });
  assert.deepEqual(result.promoted.map((item) => item.id), ['external-1']);
  assert.equal(internal.status, 'PROPOSED');
});

test('waiting authority and capability retain external ownership', async () => {
  for (const occupiedStatus of ['WAITING_FOR_AUTHORITY', 'WAITING_FOR_CONNECTOR']) {
    const rows = [
      todo('occupied', occupiedStatus, 1, 'external'),
      todo('next', 'PROPOSED', 2, 'external', true),
    ];
    const result = await activateEligibleFirstLifeWork({
      prisma: prismaFor(rows), runtime, expansionTrigger: 'verified_result',
    });
    assert.deepEqual(result.promoted, []);
    assert.equal(rows[1].status, 'PROPOSED');
  }
});

test('only a verified monitoring checkpoint can release monitoring capacity', async () => {
  const retained = [todo('monitoring', 'MONITORING', 1, 'external'), todo('next', 'PROPOSED', 2, 'external', true)];
  assert.deepEqual((await activateEligibleFirstLifeWork({
    prisma: prismaFor(retained), runtime, expansionTrigger: 'verified_result',
  })).promoted, []);

  const released = [todo('monitoring', 'MONITORING', 1, 'external'), todo('next', 'PROPOSED', 2, 'external', true)];
  const result = await activateEligibleFirstLifeWork({
    prisma: prismaFor(released), runtime, expansionTrigger: 'verified_monitoring_checkpoint',
  });
  assert.deepEqual(result.promoted.map((item) => item.id), ['next']);
});

test('organization policy cannot pregrant an unconfigured first-life proposal', async () => {
  const rows = [todo('external-1', 'PROPOSED', 1, 'external', true)];
  const result = await activateEligibleFirstLifeWork({
    prisma: prismaFor(rows, { external_default: 'unconfigured' }), runtime,
    expansionTrigger: 'organization_policy',
  });
  assert.equal(result.reason, 'no_eligible_capacity');
  assert.equal(rows[0].status, 'PROPOSED');
});

test('a direct instruction can claim free capacity without pregranting external authority', async () => {
  const direct = todo('direct-1', 'PROPOSED', -100, 'external');
  direct.context.proposal_origin = 'user_instruction';
  delete direct.context.first_life_policy_id;
  const result = await activateEligibleFirstLifeWork({
    prisma: prismaFor([direct], { external_default: 'unconfigured' }), runtime,
    expansionTrigger: 'user_instruction',
  });
  assert.deepEqual(result.promoted.map((item) => item.id), ['direct-1']);
  assert.equal(direct.status, 'READY');
});

test('retained direct-instruction evaluation cannot promote autonomous proposals', async () => {
  const direct = todo('direct-1', 'PROPOSED', -100, 'external');
  direct.context.proposal_origin = 'user_instruction';
  delete direct.context.first_life_policy_id;
  const autonomous = todo('autonomous-1', 'PROPOSED', 1, 'internal', true);
  const result = await activateEligibleFirstLifeWork({
    prisma: prismaFor([direct, autonomous]), runtime,
    expansionTrigger: 'user_instruction', proposalOrigin: 'user_instruction',
  });
  assert.deepEqual(result.promoted.map((item) => item.id), ['direct-1']);
  assert.equal(autonomous.status, 'PROPOSED');
});

test('a direct external instruction preempts ordering but not an occupied external slot', async () => {
  const active = todo('active-1', 'WAITING_FOR_AUTHORITY', 1, 'external');
  const direct = todo('direct-1', 'PROPOSED', -100, 'external');
  direct.context.proposal_origin = 'user_instruction';
  delete direct.context.first_life_policy_id;
  const result = await activateEligibleFirstLifeWork({
    prisma: prismaFor([active, direct]), runtime, expansionTrigger: 'user_instruction',
  });
  assert.deepEqual(result.promoted, []);
  assert.equal(direct.status, 'PROPOSED');
});

test('repeated evaluator wakes cannot promote the same proposal twice', async () => {
  const rows = [todo('internal-1', 'PROPOSED', 1, 'internal', true)];
  const prisma = prismaFor(rows);
  const first = await activateEligibleFirstLifeWork({ prisma, runtime, expansionTrigger: 'user_start' });
  const second = await activateEligibleFirstLifeWork({ prisma, runtime, expansionTrigger: 'user_start' });
  assert.equal(first.promoted.length, 1);
  assert.equal(second.promoted.length, 0);
});

test('first-life projection exposes evidence and requested outcomes without dispatching proposals', async () => {
  const rows = [todo('proposal-1', 'PROPOSED', 1, 'external', true)];
  rows[0].title = 'Localized proposal title';
  rows[0].objective = 'Localized proposal objective';
  rows[0].context.activation_sprint_id = 'first-life-1';
  rows[0].context.response_locale = 'de-DE';
  rows[0].context.evidence_refs = ['baseline-1', 'signal-2'];
  rows[0].context.requested_terminal_outcome = 'verified_outcome';
  const prisma = {
    hqTodo: { findMany: async () => rows },
    hqRuntime: { findUnique: async () => ({ id: 'runtime-1', epoch: 'epoch-1', authorityPolicy: { external_default: 'unconfigured' } }) },
    runtimePlaybookRun: { findMany: async () => [] },
  };

  const result = await projectCurrentFirstLife({ prisma, orgId: 'org-1' });
  assert.equal(result.status, 'AWAITING_START');
  assert.equal(result.response_locale, 'de-DE');
  assert.equal(result.proposal_count, 1);
  assert.equal(result.proposed_count, 1);
  assert.equal(result.active_external_count, 0);
  assert.deepEqual(result.items[0].evidence_refs, ['baseline-1', 'signal-2']);
  assert.equal(result.items[0].requested_outcome, 'verified_outcome');
  assert.equal(result.items[0].execution, null);
});

test('first-life projection does not call an incompatible terminal outcome completed', async () => {
  const rows = [todo('proposal-1', 'BLOCKED', 1, 'external', true)];
  const prisma = {
    hqTodo: { findMany: async () => rows },
    hqRuntime: { findUnique: async () => ({ id: 'runtime-1', epoch: 'epoch-1', authorityPolicy: {} }) },
    runtimePlaybookRun: { findMany: async () => [{
      id: 'run-1', status: 'COMPLETED', terminalState: 'campaign_needs_input',
      trigger: { todo_id: 'proposal-1' }, context: {
        playbook_selection: { acceptable_terminal_states: ['reviewed'] },
      }, artifacts: [], checkpoints: [], authorities: [], completedStageIds: [], stageAttempts: {},
    }] },
  };

  const result = await projectCurrentFirstLife({ prisma, orgId: 'org-1' });
  assert.equal(result.items[0].status, 'NEEDS_ATTENTION');
  assert.equal(result.completed_count, 0);
});

// Root-caused live (2026-08-15, orgs DIOR and Brdteengal): a promoted
// external task parks WAITING_FOR_CONNECTOR on a missing capability — a wait
// on a HUMAN that can take days — and nothing ever released its execution
// slot, so other evidenced, independent proposals sat PROPOSED forever.
// capability_wait_release is the parallel case to verified_monitoring_checkpoint
// (test above): only THIS specific new trigger may release a
// WAITING_FOR_CONNECTOR slot; every other trigger's behavior toward it is
// unchanged (see "waiting authority and capability retain external ownership"
// above, still passing with expansionTrigger: 'verified_result').
test('only capability_wait_release can release a WAITING_FOR_CONNECTOR EXTERNAL slot (internal capacity was never blocked by it)', async () => {
  const version14 = (row) => { row.context.first_life_policy_version = 14; return row; };
  // Mirrors "only a verified monitoring checkpoint can release monitoring
  // capacity" above, exactly, but for WAITING_FOR_CONNECTOR — both candidates
  // are EXTERNAL so the external_execution_limit (1) is the only thing that
  // can block 'next'; internal capacity is a separate limit and was never
  // the real gap (an internal candidate promotes under any allowed trigger
  // regardless of the external slot's release state — this test isolates
  // the actual new behavior instead of that pre-existing one).
  const retained = [
    version14(todo('waiting', 'WAITING_FOR_CONNECTOR', 1, 'external')),
    version14(todo('next', 'PROPOSED', 2, 'external', true)),
  ];
  assert.deepEqual((await activateEligibleFirstLifeWork({
    prisma: prismaFor(retained), runtime, expansionTrigger: 'verified_result',
  })).promoted, [], 'a non-release trigger must not promote while the connector wait is still occupying the external slot');
  assert.equal(retained[1].status, 'PROPOSED');

  const released = [
    version14(todo('waiting', 'WAITING_FOR_CONNECTOR', 1, 'external')),
    version14(todo('next', 'PROPOSED', 2, 'external', true)),
  ];
  const result = await activateEligibleFirstLifeWork({
    prisma: prismaFor(released), runtime, expansionTrigger: 'capability_wait_release',
  });
  assert.deepEqual(result.promoted.map((item) => item.id), ['next']);
  assert.equal(released[1].status, 'READY');
  // The occupied external todo itself is untouched — only marked internally
  // as no longer counting against the execution-slot limit.
  assert.equal(released[0].status, 'WAITING_FOR_CONNECTOR');
  assert.equal(released[0].context.execution_slot_released, true);
});

test('capability_wait_release unblocks a dormant INTERNAL proposal too — this is the real-world case (DIOR/Brdteengal): the sole active task is an external connector wait, and independent internal prep work was never re-checked for promotion at all', async () => {
  const version14 = (row) => { row.context.first_life_policy_version = 14; return row; };
  const rows = [
    version14(todo('waiting', 'WAITING_FOR_CONNECTOR', 1, 'external')),
    version14(todo('prospect-list', 'PROPOSED', 2, 'internal', true)),
  ];
  const result = await activateEligibleFirstLifeWork({
    prisma: prismaFor(rows), runtime, expansionTrigger: 'capability_wait_release',
  });
  assert.deepEqual(result.promoted.map((item) => item.id), ['prospect-list']);
  assert.equal(rows[1].status, 'READY');
});

// This is the exact live-verification miss: every other test in this file uses
// prismaFor()'s DEFAULT authority policy (external_default: 'manual'), which
// resolveAuthorityPreference treats as "configured" — so the first attempt at
// this fix passed every test here yet silently no-op'd in production, because
// the REAL org's authority_policy.external_default was 'unconfigured' (its
// actual, common first-life default — confirmed live via the dashboard
// showing "Not configured" for every gate). With policyConfigured===false,
// capability_wait_release fell through to directProposals only
// (user_instruction-origin todos), which never includes growth-plan-
// originated proposals at all — so it silently promoted nothing. Any future
// test for a first-life expansion trigger MUST include this unconfigured case.
test('capability_wait_release still reaches first-life proposals when the org has never configured its authority policy (the real DIOR/Brdteengal state)', async () => {
  const version14 = (row) => { row.context.first_life_policy_version = 14; return row; };
  const rows = [
    version14(todo('waiting', 'WAITING_FOR_CONNECTOR', 1, 'external')),
    version14(todo('prospect-list', 'PROPOSED', 2, 'internal', true)),
  ];
  const result = await activateEligibleFirstLifeWork({
    prisma: prismaFor(rows, { external_default: 'unconfigured', gate_overrides: {} }),
    runtime, expansionTrigger: 'capability_wait_release',
  });
  assert.deepEqual(result.promoted.map((item) => item.id), ['prospect-list'],
    'must promote even though policyConfigured is false — this is exactly what silently failed live');
  assert.equal(rows[1].status, 'READY');
});

test('capability_wait_release is rejected on an older policy version that never declared it (purely additive to v14, not retroactive)', async () => {
  // The default todo() helper uses first_life_policy_version: 3 — proves
  // this trigger was added to v14's fixture specifically, not silently
  // accepted everywhere regardless of which policy version a todo committed
  // under.
  const rows = [todo('waiting', 'WAITING_FOR_CONNECTOR', 1, 'external'), todo('next', 'PROPOSED', 2, 'external', true)];
  const result = await activateEligibleFirstLifeWork({
    prisma: prismaFor(rows), runtime, expansionTrigger: 'capability_wait_release',
  });
  assert.deepEqual(result.promoted, []);
  assert.equal(result.reason, 'trigger_not_allowed');
});

test('capability_wait_release does nothing when a todo is already READY — it only unblocks dormant PROPOSED work', async () => {
  const version14 = (row) => { row.context.first_life_policy_version = 14; return row; };
  const rows = [
    version14(todo('waiting', 'WAITING_FOR_CONNECTOR', 1, 'external')),
  ];
  const result = await activateEligibleFirstLifeWork({
    prisma: prismaFor(rows), runtime, expansionTrigger: 'capability_wait_release',
  });
  assert.deepEqual(result.promoted, []);
  assert.equal(result.reason, 'no_eligible_capacity');
});

// Root-caused live (2026-08-15, Singulance's own org): the same gap as the
// connector-wait case above, but for MONITORING — an outreach task watching
// for provider replies never released its slot for the dormant TARA-calls
// task, because the outreach playbook's observe_responses stage never
// declares waitingFor.releases_execution_slot, so the EXISTING
// verified_monitoring_checkpoint path's own gate (native-engine.js, only
// attempts promotion when that flag is true) never even tried. capability_wait_release
// must release a MONITORING slot too, unconditionally — it must not depend
// on any per-playbook authoring decision, unlike verified_monitoring_checkpoint.
test('capability_wait_release also releases a MONITORING slot, unlike verified_monitoring_checkpoint which depends on the playbook opting in', async () => {
  const version14 = (row) => { row.context.first_life_policy_version = 14; return row; };
  const rows = [
    version14(todo('monitoring-outreach', 'MONITORING', 1, 'external')),
    version14(todo('tara-calls', 'PROPOSED', 2, 'external', true)),
  ];
  const result = await activateEligibleFirstLifeWork({
    prisma: prismaFor(rows, { external_default: 'unconfigured', gate_overrides: {} }),
    runtime, expansionTrigger: 'capability_wait_release',
  });
  assert.deepEqual(result.promoted.map((item) => item.id), ['tara-calls']);
  assert.equal(rows[1].status, 'READY');
  assert.equal(rows[0].context.execution_slot_released, true);
});
