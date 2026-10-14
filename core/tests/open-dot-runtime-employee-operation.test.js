import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { readOpenDotEmployeeArtifact, relayOpenDotEmployeeOperation, verifyOpenDotRuntimeBridgeAuthorization } from '../src/employees/open-dot-runtime-employee-operation.js';

const organizationId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const employeeId = '33333333-3333-4333-8333-333333333333';
const dispatchMessageId = '44444444-4444-4444-8444-444444444444';
const dotId = 'dot_example_1';
const directOrigin = { kind: 'direct-chat', job_id: 'chat_message_example', message_id: 'msg_example',
  conversation_id: 'conv_example', content_digest: 'a'.repeat(64), claim_token: 'private-current-claim' };
const secret = 's'.repeat(40);
const tokenEnv = { OPEN_DOT_RUNTIME_BRIDGE_TOKEN: 'd'.repeat(40), HIVE_HARNESS_RUNNER_SERVICE_SECRET: secret };
const employee = { id: employeeId, createdBy: userId, teamId: null, scope: 'organization', status: 'active', archivedAt: null,
  policyRules: { native_lifecycle: { version: 1, phase: 'active' },
    open_dot_employee: { version: 1, execution_backend: 'open-dot', state: 'bound', dot_id: dotId } } };
function dbFor() {
  return { userOrganization: { findUnique: async () => ({ role: 'member', isActive: true, deactivatedAt: null }) },
    teamMember: { findMany: async () => [] }, digitalEmployee: { findFirst: async () => employee } };
}
function decodeToken(token) { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }

test('direct human chat authority is verified at the owning store and signed without a fabricated dispatch', async () => {
  const calls = [];
  const raw = { organization_id: organizationId, user_id: userId, employee_id: employeeId, dot_id: dotId,
    origin: directOrigin, operation: 'message', message_key: 'direct-question-1', recipient: 'runtime',
    kind: 'question', text: 'Please confirm receipt only.', artifact_ids: [] };
  await relayOpenDotEmployeeOperation(dbFor(), raw, { env: { ...tokenEnv, HIVE_HARNESS_INTERNAL_ORIGIN: 'http://brain:3080' },
    fetchImpl: async (url, options) => {
      calls.push({url,options});
      if (calls.length === 1) {
        const {claim_token, ...origin} = directOrigin;
        return Response.json({verified:true,organization_id:organizationId,user_id:userId,employee_id:employeeId,dot_id:dotId,origin});
      }
      return Response.json({accepted:true,receipt_id:'direct-1',delivery_state:'accepted'});
    } });
  assert.equal(calls[0].url, 'https://dots.singulancelabs.com/api/internal/hivemind/runtime/coordination-origin');
  assert.equal(JSON.parse(calls[0].options.body).origin.claim_token, directOrigin.claim_token);
  assert.equal(calls[1].url, 'http://runtime-runner:3080/internal/hivemind/open-dot/runtime/employee-operation');
  const body=JSON.parse(calls[1].options.body), claims=decodeToken(calls[1].options.headers.authorization.slice(7));
  assert.equal(Object.hasOwn(body,'dispatch_message_id'),false);
  assert.equal(Object.hasOwn(body.origin,'claim_token'),false);
  assert.equal(Object.hasOwn(body,'root_session_id'),false);
  assert.equal(claims.origin_sha256,createHash('sha256').update(JSON.stringify(body.origin)).digest('hex'));
  assert.equal(Object.hasOwn(claims,'dispatch_message_id'),false);
});

test('direct chat rejects foreign job proof, expired claims and mixed Runtime dispatch authority before native relay', async () => {
  const raw = { organization_id: organizationId, user_id: userId, employee_id: employeeId, dot_id: dotId,
    origin: directOrigin, operation:'message',message_key:'direct-1',recipient:'runtime',kind:'update',text:'Notice',artifact_ids:[] };
  for (const mismatch of ['organization_id','user_id','employee_id','dot_id','message_id','content_digest']) {
    let calls=0;
    await assert.rejects(relayOpenDotEmployeeOperation(dbFor(),raw,{env:tokenEnv,fetchImpl:async()=>{
      calls++; const {claim_token,...origin}=directOrigin;
      const proof={verified:true,organization_id:organizationId,user_id:userId,employee_id:employeeId,dot_id:dotId,origin};
      if (Object.hasOwn(proof,mismatch)) proof[mismatch]='foreign'; else proof.origin[mismatch]='foreign';
      return Response.json(proof);
    }}),/open_dot_direct_chat_origin_unverified/);
    assert.equal(calls,1);
  }
  await assert.rejects(relayOpenDotEmployeeOperation(dbFor(),raw,{env:tokenEnv,fetchImpl:async()=>Response.json({error:'expired'},{status:409})}),/open_dot_direct_chat_origin_unverified/);
  await assert.rejects(relayOpenDotEmployeeOperation(dbFor(),{...raw,dispatch_message_id:dispatchMessageId},{env:tokenEnv}),/invalid_open_dot_employee_operation/);
  await assert.rejects(relayOpenDotEmployeeOperation(dbFor(),{...raw,operation:'blocker',blocker_key:'b',question:'q'},{env:tokenEnv}),/invalid_open_dot_employee_operation/);
});

test('Open Dot employee operation is scope-bound and signed to the fixed DSH receiver', async () => {
  let request;
  const body = { organization_id: organizationId, user_id: userId, employee_id: employeeId, dot_id: dotId,
    dispatch_message_id: dispatchMessageId, operation: 'message', message_key: 'reply-1', recipient: 'employee-2',
    kind: 'question', text: 'Can you confirm?', artifact_ids: [] };
  const result = await relayOpenDotEmployeeOperation(dbFor(), body, { env: tokenEnv, fetchImpl: async (url, options) => {
    request = { url, options }; return new Response(JSON.stringify({ accepted: true, receipt_id: 'r1', delivery_state: 'queued' }), { status: 202 });
  } });
  assert.deepEqual(result, { accepted: true, receipt_id: 'r1', delivery_state: 'queued' });
  assert.equal(request.url, 'http://runtime-runner:3080/internal/hivemind/open-dot/runtime/employee-operation');
  assert.equal(request.options.redirect, 'error');
  const claims = decodeToken(request.options.headers.authorization.slice('Bearer '.length));
  assert.equal(claims.iss, 'hivemind-control-plane');
  assert.equal(claims.aud, 'hivemind-open-dot-runtime-bridge');
  assert.equal(claims.sub, userId); assert.equal(claims.org_id, organizationId);
  assert.equal(claims.dispatch_message_id, dispatchMessageId); assert.equal(claims.operation, 'message');
  assert.equal(claims.body_sha256, createHash('sha256').update(request.options.body).digest('hex'));
  assert.equal(verifyOpenDotRuntimeBridgeAuthorization(`Bearer ${tokenEnv.OPEN_DOT_RUNTIME_BRIDGE_TOKEN}`, tokenEnv.OPEN_DOT_RUNTIME_BRIDGE_TOKEN), true);
  assert.equal(verifyOpenDotRuntimeBridgeAuthorization('Bearer wrong', tokenEnv.OPEN_DOT_RUNTIME_BRIDGE_TOKEN), false);
  await assert.rejects(relayOpenDotEmployeeOperation(dbFor(), { ...body, root_session_id: 'session-client-claimed' },
    { env: tokenEnv, fetchImpl: async () => { throw new Error('must not forward'); } }), /invalid_open_dot_employee_operation/);
});

test('artifact read derives the authenticated scope and returns only verified Dot-owned bytes', async () => {
  const bytes = Buffer.from('owned Dot file');
  const artifact = { id: 'file_0123456789abcdef', name: 'notes.txt', mime: 'text/plain', size: bytes.length,
    checksum: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') };
  let request;
  const result = await readOpenDotEmployeeArtifact(dbFor(), { sub: userId, org_id: organizationId, operating_role: 'runtime', operating_session: 'session-runtime-root' },
    { employee_id: employeeId, dot_id: dotId, dispatch_message_id: dispatchMessageId, artifact_id: artifact.id, root_session_id: 'session-runtime-root' },
    { env: tokenEnv, fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ employeeId, dotId, messageId: dispatchMessageId, rootSessionId: 'session-runtime-root', artifact }), { status: 200 });
    } });
  assert.deepEqual(result, artifact);
  assert.equal(request.url, 'https://dots.singulancelabs.com/api/internal/hivemind/runtime/artifact');
  const body = JSON.parse(request.options.body);
  assert.equal(body.userId, userId); assert.equal(body.organizationId, organizationId);
  assert.equal(body.messageId, dispatchMessageId);
  assert.equal(body.rootSessionId, 'session-runtime-root');
});

test('artifact read rejects generic runners and a different Runtime root before fetching', async () => {
  for (const claims of [{ sub: userId, org_id: organizationId }, { sub: userId, org_id: organizationId, operating_role: 'runtime', operating_session: 'session-other-root' }]) {
    await assert.rejects(readOpenDotEmployeeArtifact(dbFor(), claims, { employee_id: employeeId, dot_id: dotId,
      dispatch_message_id: dispatchMessageId, artifact_id: 'file_0123456789abcdef', root_session_id: 'session-runtime-root' },
      { env: tokenEnv, fetchImpl: async () => { throw new Error('must not fetch'); } }), /runtime_session_required/);
  }
});
