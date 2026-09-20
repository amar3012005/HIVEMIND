import test from 'node:test';
import assert from 'node:assert/strict';

import {
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
          return [{
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

test('the session-bound PlaybookList returns global, org, and local metadata only', async () => {
  const harness = routeHarness({ agentscope_session_id: SESSION_ID });
  await handleInternalPlaybookListRoute(harness.options);

  assert.equal(harness.response().status, 200);
  assert.ok(harness.response().body.playbooks.some((entry) => entry.id === 'global:general'));
  assert.ok(harness.response().body.playbooks.some((entry) => entry.id === 'org:org-sales'));
  assert.ok(harness.response().body.playbooks.some((entry) => entry.id === 'local:launch-overlay'));
  assert.ok(harness.response().body.playbooks.every((entry) => !Object.hasOwn(entry, 'instructions')));
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
    instructions: 'Use current launch constraints.',
  });
});
