import test from 'node:test';
import assert from 'node:assert/strict';

import {
  handleInternalCompanyRecordsRoute,
  handleInternalPlaybookGetRoute,
  handleInternalPlaybookListRoute,
} from '../../src/routes/internal-hivemind.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = 'agentscope-session-1';

function routeHarness(body) {
  const queries = [];
  let response;
  return {
    queries,
    options: {
      req: {
        headers: { 'x-hm-user-id': USER_ID, 'x-hm-org-id': ORG_ID },
      },
      res: {},
      parseBody: async () => body,
      jsonResponse: (_res, responseBody, status = 200) => {
        response = { body: responseBody, status };
        return response;
      },
      prisma: {
        userOrganization: { findFirst: async () => ({ orgId: ORG_ID }) },
        $queryRawUnsafe: async (sql, ...params) => {
          queries.push({ sql, params });
          if (sql.includes('UPDATE "hivemind"."work_runs"')) return [];
          return [{
            id: '33333333-3333-4333-8333-333333333333',
            room_playbook: {
              id: 'org-sales',
              name: 'Organization sales',
              instructions: 'Use organization approval gates.',
            },
            scope: {
              local_playbooks: {
                id: 'launch-overlay',
                name: 'Launch overlay',
                instructions: 'Use current launch constraints.',
              },
            },
          }];
        },
      },
    },
    response: () => response,
  };
}

test('focused company record reads are organization-scoped and do not expose artifact bytes', async () => {
  let response;
  const calls = [];
  const options = {
    req: { headers: { 'x-hm-user-id': USER_ID, 'x-hm-org-id': ORG_ID } },
    res: {},
    jsonResponse: (_res, body, status = 200) => {
      response = { body, status };
      return response;
    },
    prisma: {
      userOrganization: {
        findFirst: async () => ({ orgId: ORG_ID }),
        findMany: async (query) => {
          calls.push({ kind: 'people', query });
          return [{ userId: USER_ID, role: 'owner', roles: ['owner'], user: { displayName: 'Amar' } }];
        },
      },
      project: { findMany: async (query) => { calls.push({ kind: 'projects', query }); return [{ id: 'project-1' }]; } },
      growthGoal: { findMany: async (query) => { calls.push({ kind: 'objectives', query }); return [{ id: 'goal-1' }]; } },
      hyperWorkOrder: { findMany: async (query) => { calls.push({ kind: 'work', query }); return [{ id: 'work-1' }]; } },
      sourceArtifact: { findMany: async (query) => { calls.push({ kind: 'artifacts', query }); return [{ id: 'artifact-1', payload: 'must not escape' }]; } },
    },
  };

  for (const kind of ['people', 'projects', 'objectives', 'work', 'artifacts']) {
    await handleInternalCompanyRecordsRoute({ ...options, kind });
    assert.equal(response.status, 200);
    assert.equal(response.body.kind, kind);
    assert.equal(response.body.status, 'completed');
  }
  assert.deepEqual(response.body.items, [{ id: 'artifact-1', payload: 'must not escape' }]);
  assert.equal(calls.length, 5);
  for (const call of calls) {
    assert.deepEqual(call.query.where.orgId, ORG_ID);
    assert.equal(call.query.take, 25);
  }
  const artifactCall = calls.find((call) => call.kind === 'artifacts');
  assert.equal(Object.hasOwn(artifactCall.query.select, 'payload'), false);
  assert.equal(Object.hasOwn(artifactCall.query.select, 'storageLocation'), false);
});

test('the session-bound PlaybookList returns global, org, and local metadata only', async () => {
  const harness = routeHarness({ agentscope_session_id: SESSION_ID });
  await handleInternalPlaybookListRoute(harness.options);

  assert.equal(harness.response().status, 200);
  assert.ok(harness.response().body.playbooks.some((entry) => entry.id === 'global:general'));
  assert.ok(harness.response().body.playbooks.some((entry) => entry.id === 'org:org-sales'));
  assert.ok(harness.response().body.playbooks.some((entry) => entry.id === 'local:launch-overlay'));
  assert.ok(harness.response().body.playbooks.every((entry) => !Object.hasOwn(entry, 'instructions')));
  assert.ok(harness.response().body.playbooks.every((entry) => entry.version === '1.0.0'));
  assert.deepEqual(harness.queries[0].params, [SESSION_ID, USER_ID, ORG_ID]);
});

test('the session-bound PlaybookGet loads only the selected local body', async () => {
  const harness = routeHarness({ id: 'local:launch-overlay', agentscope_session_id: SESSION_ID });
  await handleInternalPlaybookGetRoute(harness.options);

  assert.equal(harness.response().status, 200);
  assert.deepEqual(harness.response().body.playbook, {
    id: 'local:launch-overlay',
    name: 'Launch overlay',
    description: 'WorkRun-local operating guidance.',
    scope: 'local',
    version: '1.0.0',
    instructions: 'Use current launch constraints.',
  });
  assert.match(harness.queries[1].sql, /SET playbook_id = \$2, playbook_version = \$3/);
  assert.deepEqual(harness.queries[1].params, [
    '33333333-3333-4333-8333-333333333333',
    'local:launch-overlay',
    '1.0.0',
    JSON.stringify({
      local_playbooks: {
        id: 'launch-overlay',
        name: 'Launch overlay',
        instructions: 'Use current launch constraints.',
      },
    }),
    USER_ID,
    ORG_ID,
  ]);
});

test('the selected global playbook stores its resolved completion contract on the WorkRun', async () => {
  const harness = routeHarness({ id: 'global:market-research', agentscope_session_id: SESSION_ID });
  await handleInternalPlaybookGetRoute(harness.options);

  assert.equal(harness.response().status, 200);
  assert.deepEqual(harness.response().body.playbook.completion_contract, {
    tasks: { min_completed: 1, require_all_completed: true },
    artifacts: { min_count: 1 },
  });
  assert.deepEqual(JSON.parse(harness.queries[1].params[3]).completion_contract,
    harness.response().body.playbook.completion_contract);
});
