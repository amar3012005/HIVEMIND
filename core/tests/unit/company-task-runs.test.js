import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCompanyTaskContext,
  buildCompanyTaskInstruction,
  clearHumanAgentRoomRuns,
  resolveCompanyTaskRoomType,
} from '../../src/employees/company-task-runs.js';

test('company task becomes a direct human instruction without routing copy', () => {
  const message = buildCompanyTaskInstruction({
    title: 'Review our customer onboarding',
    detail: 'Find the largest source of avoidable friction.',
    deliverable: 'Prioritized findings',
  });
  assert.equal(message, [
    'Review our customer onboarding',
    'Find the largest source of avoidable friction.',
    'Expected deliverable: Prioritized findings',
  ].join('\n\n'));
  assert.doesNotMatch(message, /runtime|specialist|room|director|debate/i);
});

test('company tasks preserve every canonical Room type without keyword routing', () => {
  const roomTypes = [
    'general', 'seo', 'marketing', 'outreach', 'campaign', 'branding',
    'fundraising', 'research', 'product', 'design', 'legal_finance',
  ];
  for (const roomType of roomTypes) {
    assert.equal(resolveCompanyTaskRoomType({ room_tag: roomType, title: 'unrelated vocabulary' }), roomType);
  }
  assert.equal(resolveCompanyTaskRoomType({ room_tag: 'LEGAL-FINANCE' }), 'legal_finance');
  assert.equal(resolveCompanyTaskRoomType({ room_tag: 'general', room_name: 'Research' }), 'research');
  assert.equal(resolveCompanyTaskRoomType({ room_tag: 'unknown' }), 'general');
});

test('company task context carries persisted onboarding truth outside the visible instruction', () => {
  const context = buildCompanyTaskContext({
    company: 'Acme', website: 'https://acme.example', company_location: 'Berlin',
    mission: 'Make regulated work safer.',
    profile: {
      what_it_does: 'Builds compliance software.',
      icp: 'European banks', offer: 'Auditable automation',
      evidence_gaps: ['Current social activity not observed'],
    },
  });
  assert.match(context, /^Company: Acme/m);
  assert.match(context, /ICP: European banks/);
  assert.match(context, /Known evidence gaps: Current social activity not observed/);
});

test('clearing human Room runs preserves Runtime-owned turns and work', async () => {
  const calls = { turnDelete: null, orderDelete: null, resultDelete: null, activityTurnIds: null };
  const tx = {
    hyperRoom: { findMany: async () => [{ id: 'room-1' }] },
    hyperTurn: {
      findMany: async () => [
        { id: 'human-turn', idempotencyKey: 'task-kickoff-company-task', runtimePlaybookRunId: null },
        { id: 'runtime-turn', idempotencyKey: 'shared-key', runtimePlaybookRunId: 'run-1' },
        { id: 'legacy-runtime-turn', idempotencyKey: 'hq-wo:stage-1', runtimePlaybookRunId: null },
        { id: 'linked-runtime-turn', idempotencyKey: 'shared-key-2', runtimePlaybookRunId: null },
      ],
      deleteMany: async (args) => { calls.turnDelete = args; return { count: 1 }; },
    },
    hyperWorkOrder: {
      findMany: async (args) => {
        if (args.where.OR?.some((entry) => entry.hqCycleId || entry.runtimeEpoch)) {
          return [{ turnId: 'linked-runtime-turn' }];
        }
        return [{ id: 'human-order' }];
      },
      deleteMany: async (args) => { calls.orderDelete = args; return { count: 1 }; },
    },
    hyperWorkResult: {
      deleteMany: async (args) => { calls.resultDelete = args; return { count: 1 }; },
    },
    $executeRawUnsafe: async (_sql, _orgId, ...turnIds) => {
      calls.activityTurnIds = turnIds;
      return 1;
    },
  };
  const prisma = { $transaction: async (fn) => fn(tx) };

  const result = await clearHumanAgentRoomRuns({ prisma, orgId: 'org-1' });

  assert.deepEqual(result, { turns: 1, work_orders: 1, work_results: 1, activity: 1 });
  assert.deepEqual(calls.turnDelete.where.id.in, ['human-turn']);
  assert.deepEqual(calls.activityTurnIds, ['human-turn']);
  assert.deepEqual(calls.orderDelete.where.id.in, ['human-order']);
  assert.deepEqual(calls.resultDelete.where.workOrderId.in, ['human-order']);
});
