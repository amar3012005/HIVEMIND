import test from 'node:test';
import assert from 'node:assert/strict';

import { handleInternalRecordArtifactRoute } from '../../src/routes/internal-hivemind.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const WORKRUN_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = 'agentscope-session-1';

test('artifact registration resolves the authenticated AgentScope session to its WorkRun', async () => {
  const queries = [];
  const prisma = {
    userOrganization: {
      findFirst: async () => ({ orgId: ORG_ID }),
    },
    $queryRawUnsafe: async (sql, ...params) => {
      queries.push({ sql, params });
      if (sql.includes('FROM "hivemind"."work_runs"')) return [{ id: WORKRUN_ID }];
      if (sql.includes('INSERT INTO "hivemind"."source_artifacts"')) return [{ id: 'artifact-1' }];
      throw new Error(`unexpected query: ${sql}`);
    },
    $executeRawUnsafe: async () => 1,
  };
  let response;

  await handleInternalRecordArtifactRoute({
    req: {
      headers: {
        'x-hm-user-id': USER_ID,
        'x-hm-org-id': ORG_ID,
      },
    },
    res: {},
    parseBody: async () => ({
      path: 'deliverables/report.md',
      title: 'Report',
      agentscope_session_id: SESSION_ID,
    }),
    jsonResponse: (_res, body, status = 200) => {
      response = { body, status };
      return response;
    },
    prisma,
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.artifact_id, 'artifact-1');
  assert.deepEqual(queries[0].params, [SESSION_ID, USER_ID, ORG_ID]);
  assert.equal(queries[1].params[0], USER_ID);
  assert.equal(queries[1].params[1], ORG_ID);
  assert.equal(queries[1].params[2], WORKRUN_ID);
  assert.equal(queries[1].params[6], JSON.stringify({ title: 'Report', path: 'deliverables/report.md', workrun_id: WORKRUN_ID }));
});
