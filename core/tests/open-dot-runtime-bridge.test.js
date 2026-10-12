import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchOpenDotRuntime, readOpenDotRuntimeStatus } from '../src/employees/open-dot-runtime-bridge.js';

const orgId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const employeeId = '33333333-3333-4333-8333-333333333333';
const messageId = '44444444-4444-4444-8444-444444444444';
const rootSessionId = 'session-46d220df35a3f985de773d7832c82d8e';

function dbFor({ role = 'member', state = 'bound', phase = 'active', dotId = 'dot_example_1', visible = true } = {}) {
  return {
    userOrganization: { findUnique: async () => ({ role, isActive: true, deactivatedAt: null }) },
    teamMember: { findMany: async () => [] },
    digitalEmployee: { findFirst: async () => visible ? ({
      id: employeeId, orgId, createdBy: userId, teamId: null, scope: 'organization', status: 'draft', archivedAt: null,
      policyRules: {
        native_lifecycle: { version: 1, phase },
        open_dot_employee: { version: 1, execution_backend: 'open-dot', state, dot_id: dotId },
      },
    }) : null },
  };
}

test('dispatch forwards only verified scoped identity and the canonical binding to fixed Dot runtime', async () => {
  let request;
  const claims = { sub: userId, org_id: orgId, operating_role: 'runtime', operating_session: rootSessionId };
  const result = await dispatchOpenDotRuntime(dbFor(), claims, {
    employee_id: employeeId, message_id: messageId, root_session_id: rootSessionId,
    kind: 'question', text: 'Please review this.', artifact_ids: ['artifact-1'],
  }, { env: { OPEN_DOT_RUNTIME_BRIDGE_TOKEN: 'x'.repeat(40) }, fetchImpl: async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { 'Content-Type': 'application/json' } });
  } });

  assert.equal(result.accepted, true);
  assert.equal(request.url, 'https://dots.singulancelabs.com/api/internal/hivemind/runtime/dispatch');
  assert.equal(request.options.headers.Authorization, `Bearer ${'x'.repeat(40)}`);
  assert.equal(request.options.redirect, 'error');
  assert.deepEqual(JSON.parse(request.options.body), {
    version: 1, organizationId: orgId, userId, employeeId, dotId: 'dot_example_1',
    messageId, rootSessionId, kind: 'question', text: 'Please review this.', artifactIds: ['artifact-1'],
  });
});

test('status uses the persisted Dot binding and rejects a caller supplied mismatch', async () => {
  let request;
  const claims = { sub: userId, org_id: orgId, operating_role: 'runtime', operating_session: rootSessionId };
  const result = await readOpenDotRuntimeStatus(dbFor(), claims, {
    employee_id: employeeId, dot_id: 'dot_example_1', message_id: messageId, root_session_id: rootSessionId,
  }, { env: { OPEN_DOT_RUNTIME_BRIDGE_TOKEN: 'x'.repeat(40) }, fetchImpl: async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ status: 'queued' }), { status: 200 });
  } });
  assert.deepEqual(result, { status: 'queued' });
  assert.equal(request.url, 'https://dots.singulancelabs.com/api/internal/hivemind/runtime/status');
  assert.equal(JSON.parse(request.options.body).dotId, 'dot_example_1');
  assert.equal(JSON.parse(request.options.body).rootSessionId, rootSessionId);
  await assert.rejects(readOpenDotRuntimeStatus(dbFor(), claims, {
    employee_id: employeeId, dot_id: 'dot_other', message_id: messageId, root_session_id: rootSessionId,
  }, { env: { OPEN_DOT_RUNTIME_BRIDGE_TOKEN: 'x'.repeat(40) }, fetchImpl: async () => { throw new Error('must not call'); } }), /open_dot_binding_mismatch/);
  await assert.rejects(readOpenDotRuntimeStatus(dbFor(), { sub: userId, org_id: orgId }, {
    employee_id: employeeId, dot_id: 'dot_example_1', message_id: messageId, root_session_id: rootSessionId,
  }, { env: { OPEN_DOT_RUNTIME_BRIDGE_TOKEN: 'x'.repeat(40) }, fetchImpl: async () => { throw new Error('must not call'); } }), /runtime_session_required/);
});

test('relay fails closed for unbound employees and identities outside the visible roster', async () => {
  for (const db of [dbFor({ state: 'provisioning' }), dbFor({ visible: false })]) {
    await assert.rejects(dispatchOpenDotRuntime(db, { sub: userId, org_id: orgId, operating_role: 'runtime', operating_session: rootSessionId }, {
      employee_id: employeeId, message_id: messageId, root_session_id: rootSessionId,
      kind: 'update', text: 'Do this.', artifact_ids: [],
    }, { env: { OPEN_DOT_RUNTIME_BRIDGE_TOKEN: 'x'.repeat(40) }, fetchImpl: async () => { throw new Error('must not call'); } }));
  }
});
