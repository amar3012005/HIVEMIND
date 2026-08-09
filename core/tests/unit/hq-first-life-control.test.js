import test from 'node:test';
import assert from 'node:assert/strict';
import { activateEligibleFirstLifeWork, projectCurrentFirstLife } from '../../src/hq-runtime/first-life-control.js';

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
