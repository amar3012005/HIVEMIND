import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchOpenDotRuntime, readOpenDotRuntimeStatus, cancelOpenDotRuntime } from '../src/employees/open-dot-runtime-bridge.js';

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

test('direct reply keeps original conversation proof under exact Runtime root and grants no assignment',async()=>{
  const claims={sub:userId,org_id:orgId,operating_role:'runtime',operating_session:rootSessionId};
  const direct_reply={jobId:'chat_message_original',messageId:'msg_original',conversationId:'conv_original',contentDigest:'a'.repeat(64),nativeMessageId:'agent-message-original'};
  const body={employee_id:employeeId,message_id:messageId,root_session_id:rootSessionId,kind:'update',text:'Hello',artifact_ids:[],direct_reply};
  let sent;
  const options={env:{OPEN_DOT_RUNTIME_BRIDGE_TOKEN:'x'.repeat(40)},fetchImpl:async(_,input)=>{sent=JSON.parse(input.body);return Response.json({accepted:true})}};
  await dispatchOpenDotRuntime(dbFor(),claims,body,options);
  assert.deepEqual(sent.directReply,direct_reply);assert.equal(sent.rootSessionId,rootSessionId);
  assert.equal(Object.hasOwn(sent,'taskId'),false);
  for(const patch of [{task_id:'invented'},{kind:'assignment'},{artifact_ids:['artifact-1']},{root_session_id:'session-foreign'}]) {
    await assert.rejects(dispatchOpenDotRuntime(dbFor(),claims,{...body,...patch},options));
  }
});

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

test('cancel relays the canonical binding and exact authenticated root only', async () => {
  let payload;
  const input = { employee_id: employeeId, dot_id: 'dot_example_1', message_id: messageId, root_session_id: rootSessionId };
  const claims = { sub: userId, org_id: orgId, operating_role: 'runtime', operating_session: rootSessionId };
  await cancelOpenDotRuntime(dbFor(), claims, input, { env: { OPEN_DOT_RUNTIME_BRIDGE_TOKEN: 'x'.repeat(40) }, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://dots.singulancelabs.com/api/internal/hivemind/runtime/cancel'); payload = JSON.parse(options.body);
    return new Response(JSON.stringify({ cancelled: true }));
  } });
  assert.deepEqual(payload, { version: 1, organizationId: orgId, userId, employeeId, dotId: 'dot_example_1', messageId, rootSessionId });
  for (const bad of [{ ...input, root_session_id: 'session-foreign' }, { ...input, task_id: 'caller-authority' }, { ...input, dot_id: 'dot_wrong' }]) {
    await assert.rejects(cancelOpenDotRuntime(dbFor(), claims, bad, { env: {}, fetchImpl: async () => { throw new Error('must not call'); } }));
  }
});
test('dispatch accepts all native receiver kinds and rejects unknown kinds', async () => {
  const claims = { sub: userId, org_id: orgId, operating_role: 'runtime', operating_session: rootSessionId };
  for (const kind of ['assignment', 'review', 'continuation', 'blocker', 'question', 'update']) {
    await dispatchOpenDotRuntime(dbFor(), claims, { employee_id: employeeId, message_id: messageId, root_session_id: rootSessionId, kind, text: 'Bound task' },
      { env: { OPEN_DOT_RUNTIME_BRIDGE_TOKEN: 'x'.repeat(40) }, fetchImpl: async (_url, options) => { assert.equal(JSON.parse(options.body).kind, kind); return new Response('{}'); } });
  }
  await assert.rejects(dispatchOpenDotRuntime(dbFor(), claims, { employee_id: employeeId, message_id: messageId, root_session_id: rootSessionId, kind: 'execute', text: 'Bound task' }, { env: {} }), /invalid_open_dot_runtime_request/);
});
