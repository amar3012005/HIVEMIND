import test from 'node:test';
import assert from 'node:assert/strict';
import { hyperPlannerModeFor } from '../../src/employees/cloudflare-hyper-planner-client.js';

test('hyper planner mode is targeted through the authenticated worker and fails closed', async () => {
  const previous = {
    url: process.env.CANONICAL_PROJECTION_WORKFLOW_URL,
    secret: process.env.CANONICAL_PROJECTION_WORKFLOW_SECRET,
  };
  process.env.CANONICAL_PROJECTION_WORKFLOW_URL = 'https://flags.example.test';
  process.env.CANONICAL_PROJECTION_WORKFLOW_SECRET = 'test-secret';
  try {
    const calls = [];
    const enabled = await hyperPlannerModeFor({ orgId: 'org-1', userId: 'user-1', fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ mode: 'glm_no_reasoning' }) };
    } });
    assert.equal(enabled, 'glm_no_reasoning');
    assert.match(calls[0].url, /\/hyper-planner-mode\?org_id=org-1&user_id=user-1/);
    assert.equal(calls[0].init.headers.authorization, 'Bearer test-secret');
    assert.equal(await hyperPlannerModeFor({ orgId: 'org-1', userId: 'user-1',
      fetchImpl: async () => ({ ok: true, json: async () => ({ mode: 'unknown' }) }) }), 'off');
    assert.equal(await hyperPlannerModeFor({ orgId: 'org-1', userId: 'user-1',
      fetchImpl: async () => { throw new Error('down'); }, logger: { warn() {} } }), 'off');
  } finally {
    if (previous.url === undefined) delete process.env.CANONICAL_PROJECTION_WORKFLOW_URL;
    else process.env.CANONICAL_PROJECTION_WORKFLOW_URL = previous.url;
    if (previous.secret === undefined) delete process.env.CANONICAL_PROJECTION_WORKFLOW_SECRET;
    else process.env.CANONICAL_PROJECTION_WORKFLOW_SECRET = previous.secret;
  }
});
