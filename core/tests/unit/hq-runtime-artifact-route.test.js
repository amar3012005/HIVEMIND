import test from 'node:test';
import assert from 'node:assert/strict';
import { createHqRuntimeRouteHandler } from '../../src/hq-runtime/routes.js';

function fakeRes() {
  const res = { statusCode: null, body: null };
  return res;
}
function jsonResponse(res, body, status = 200) { res.statusCode = status; res.body = body; return true; }
function fakeUrl(pathname) { return { pathname, searchParams: new URLSearchParams() }; }
async function parseBody() { return {}; }

const SESSION = { session: { orgId: 'org-1', userId: 'user-1' } };
async function requireSession() { return SESSION; }
async function requirePrivilegedAgentAccess() { return true; }
function handler(prisma) { return createHqRuntimeRouteHandler({ prisma, requireSession, requirePrivilegedAgentAccess, parseBody, jsonResponse }); }

test('GET /v1/hq/artifacts/:id returns a RuntimePlaybookArtifact, org-scoped, matched by the string artifactId (never the row UUID)', async () => {
  const prisma = {
    runtimePlaybookArtifact: {
      findFirst: async ({ where }) => {
        assert.equal(where.orgId, 'org-1');
        assert.deepEqual(where, { orgId: 'org-1', artifactId: 'artifact:research_decision:1' });
        assert.equal(where.OR, undefined, 'must never OR against the UUID id column — that throws on a non-UUID string');
        return { artifactId: 'artifact:research_decision:1', artifactKey: 'research_decision', data: { decision: 'value' }, createdAt: new Date('2026-08-18T00:00:00Z') };
      },
    },
  };
  const handle = handler(prisma);
  const res = fakeRes();
  const handled = await handle({ method: 'GET' }, res, fakeUrl('/v1/hq/artifacts/artifact:research_decision:1'));
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.id, 'artifact:research_decision:1');
  assert.equal(res.body.key, 'research_decision');
  assert.deepEqual(res.body.data, { decision: 'value' });
  assert.match(res.body.content, /"decision": "value"/);
});

test('GET /v1/hq/artifacts/:id falls back to SourceArtifact when no RuntimePlaybookArtifact matches', async () => {
  const prisma = {
    runtimePlaybookArtifact: { findFirst: async () => null },
    sourceArtifact: {
      findFirst: async ({ where }) => {
        assert.equal(where.orgId, 'org-1');
        assert.equal(where.id, 'baseline-1');
        return { id: 'baseline-1', sourcePlatform: 'growth_baseline', payload: { revenue: 1 }, createdAt: new Date() };
      },
    },
  };
  const handle = handler(prisma);
  const res = fakeRes();
  await handle({ method: 'GET' }, res, fakeUrl('/v1/hq/artifacts/baseline-1'));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.key, 'growth_baseline');
});

test('GET /v1/hq/artifacts/:id is a 404, not a throw, when neither table has it', async () => {
  const prisma = {
    runtimePlaybookArtifact: { findFirst: async () => null },
    sourceArtifact: { findFirst: async () => null },
  };
  const handle = handler(prisma);
  const res = fakeRes();
  await handle({ method: 'GET' }, res, fakeUrl('/v1/hq/artifacts/does-not-exist'));
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'artifact_not_found');
});

test('GET /v1/hq/artifacts/:id never leaks another org\'s artifact — lookup is always orgId-scoped', async () => {
  let queriedOrgId = null;
  const prisma = {
    runtimePlaybookArtifact: { findFirst: async ({ where }) => { queriedOrgId = where.orgId; return null; } },
    sourceArtifact: { findFirst: async () => null },
  };
  const handle = handler(prisma);
  await handle({ method: 'GET' }, fakeRes(), fakeUrl('/v1/hq/artifacts/someone-elses-artifact'));
  assert.equal(queriedOrgId, 'org-1');
});
