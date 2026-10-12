/** Purpose-separated relay for Open Dot's employee-to-Runtime tools. */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { lifecycleError } from './native-lifecycle.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DOT_ID = /^dot_[a-zA-Z0-9_-]+$/;
const FILE_ID = /^file_[a-f0-9]{16,64}$/;
const DOT_RUNTIME_ARTIFACT_URL = 'https://dots.singulancelabs.com/api/internal/hivemind/runtime/artifact';
const DSH_ORIGIN = 'http://harness-runner:3080';
const DSH_PATH = '/internal/hivemind/open-dot/runtime/employee-operation';
const MAX_DOT_RESPONSE_BYTES = 14 * 1024 * 1024;
const MAX_DSH_RESPONSE_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

function exact(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) {
    lifecycleError('invalid_open_dot_employee_operation', 400);
  }
}
function string(value, code, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) lifecycleError(code, 400);
  return value.trim();
}
function constantEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8'); const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
export function verifyOpenDotRuntimeBridgeAuthorization(header, secret) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) return false;
  const match = /^Bearer\s+([^\s]+)$/i.exec(String(header || '').trim());
  return Boolean(match && constantEqual(match[1], secret));
}
function signedDshToken(body, secret, now = Date.now()) {
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) lifecycleError('open_dot_runtime_bridge_unavailable', 503);
  const at = Math.floor(now / 1000), encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims = { iss: 'hivemind-control-plane', aud: 'hivemind-open-dot-runtime-bridge', sub: body.user_id,
    org_id: body.organization_id, profile: 'hivemind-chat', variation: 'harness', jti: randomUUID(),
    body_sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'), iat: at, exp: at + 30,
    employee_id: body.employee_id, dot_id: body.dot_id, dispatch_message_id: body.dispatch_message_id,
    operation: body.operation };
  const signingInput = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`;
  return `${signingInput}.${createHmac('sha256', secret).update(signingInput).digest('base64url')}`;
}
function dshOrigin(env) {
  const configured = env.HIVE_HARNESS_INTERNAL_ORIGIN;
  if (configured === undefined || configured === '') return DSH_ORIGIN;
  let parsed;
  try { parsed = new URL(configured); } catch { lifecycleError('open_dot_runtime_bridge_unavailable', 503); }
  if (parsed.origin !== DSH_ORIGIN || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
    lifecycleError('open_dot_runtime_bridge_unavailable', 503);
  }
  return DSH_ORIGIN;
}
async function readBounded(response, maxBytes, code) {
  let raw;
  if (response.body?.getReader) {
    const reader = response.body.getReader(), chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > maxBytes) { await reader.cancel(); lifecycleError(code, 502); }
      chunks.push(Buffer.from(value));
    }
    raw = Buffer.concat(chunks).toString('utf8');
  } else { raw = await response.text(); if (Buffer.byteLength(raw) > maxBytes) lifecycleError(code, 502); }
  try { return JSON.parse(raw); } catch { lifecycleError(code, 502); }
}
function validateOperation(input) {
  const common = ['organization_id','user_id','employee_id','dot_id','dispatch_message_id','operation'];
  if (input?.operation === 'message') {
    exact(input, [...common,'message_key','recipient','kind','text','summary','reply_to','artifact_ids']);
    const kind = input.kind;
    if (!['question','reply','update'].includes(kind)) lifecycleError('invalid_open_dot_employee_operation', 400);
    const artifacts = input.artifact_ids ?? [];
    if (!Array.isArray(artifacts) || artifacts.length > 8 || artifacts.some(id => typeof id !== 'string' || !FILE_ID.test(id))) {
      lifecycleError('invalid_open_dot_employee_artifacts', 400);
    }
    const out = { ...Object.fromEntries(common.map(key => [key, input[key]])), operation: 'message',
      message_key: string(input.message_key,'invalid_open_dot_employee_operation',120),
      recipient: string(input.recipient,'invalid_open_dot_employee_operation',180), kind,
      text: string(input.text,'invalid_open_dot_employee_operation',12000), artifact_ids: [...artifacts] };
    if (input.summary !== undefined) out.summary = string(input.summary,'invalid_open_dot_employee_operation',1000);
    if (input.reply_to !== undefined) out.reply_to = string(input.reply_to,'invalid_open_dot_employee_operation',180);
    return out;
  }
  if (input?.operation === 'blocker') {
    exact(input, [...common,'blocker_key','question','summary']);
    const out = { ...Object.fromEntries(common.map(key => [key, input[key]])), operation: 'blocker',
      blocker_key: string(input.blocker_key,'invalid_open_dot_employee_operation',120),
      question: string(input.question,'invalid_open_dot_employee_operation',4000) };
    if (input.summary !== undefined) out.summary = string(input.summary,'invalid_open_dot_employee_operation',1000);
    return out;
  }
  lifecycleError('invalid_open_dot_employee_operation', 400);
}

async function visibleBoundEmployee(db, input) {
  for (const key of ['organization_id','user_id','employee_id','dispatch_message_id']) if (!UUID.test(input[key] || '')) lifecycleError('invalid_open_dot_employee_operation', 400);
  if (!DOT_ID.test(input.dot_id || '')) lifecycleError('invalid_open_dot_employee_operation', 400);
  const membership = await db.userOrganization.findUnique({ where: { userId_orgId: { userId: input.user_id, orgId: input.organization_id } },
    select: { role: true, isActive: true, deactivatedAt: true } });
  if (!membership?.isActive || membership.deactivatedAt) lifecycleError('organization_membership_required', 403);
  const employee = await db.digitalEmployee.findFirst({ where: { id: input.employee_id, orgId: input.organization_id },
    select: { id: true, orgId: true, createdBy: true, teamId: true, scope: true, status: true, archivedAt: true, policyRules: true } });
  if (!employee) lifecycleError('employee_not_found', 404);
  if (employee.archivedAt || employee.status === 'paused') lifecycleError('employee_not_active', 409);
  const isAdmin = ['owner','admin'].includes(membership.role);
  if (!isAdmin) {
    const teamRows = await db.teamMember.findMany({ where: { userId: input.user_id, team: { orgId: input.organization_id } }, select: { teamId: true } });
    const visible = employee.createdBy === input.user_id || employee.scope === 'organization' ||
      (employee.scope === 'team' && teamRows.some(row => row.teamId === employee.teamId));
    if (!visible) lifecycleError('employee_not_visible', 403);
  }
  const marker = employee.policyRules?.open_dot_employee, lifecycle = employee.policyRules?.native_lifecycle;
  if (marker?.version !== 1 || marker.execution_backend !== 'open-dot' || marker.state !== 'bound' || marker.dot_id !== input.dot_id ||
      lifecycle?.version !== 1 || lifecycle.phase !== 'active') lifecycleError('open_dot_employee_not_bound', 409);
  return { employeeId: employee.id, dotId: marker.dot_id };
}

export async function relayOpenDotEmployeeOperation(db, raw, { env = process.env, fetchImpl = fetch } = {}) {
  const input = validateOperation(raw);
  const identity = await visibleBoundEmployee(db, input);
  const body = { ...input, employee_id: identity.employeeId, dot_id: identity.dotId };
  const token = signedDshToken(body, env.HIVE_HARNESS_RUNNER_SERVICE_SECRET);
  let response;
  try {
    response = await fetchImpl(`${dshOrigin(env)}${DSH_PATH}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  } catch { lifecycleError('open_dot_runtime_unavailable', 503); }
  const result = await readBounded(response, MAX_DSH_RESPONSE_BYTES, 'open_dot_runtime_invalid_response');
  if (!response.ok) lifecycleError('open_dot_runtime_request_failed', response.status >= 500 ? 503 : 409);
  if (result?.accepted !== true || typeof result.receipt_id !== 'string' || !result.receipt_id.trim() ||
      result.receipt_id.length > 180 || typeof result.delivery_state !== 'string' || result.delivery_state.length > 80) {
    lifecycleError('open_dot_runtime_invalid_response', 502);
  }
  return result;
}

export async function readOpenDotEmployeeArtifact(db, claims, raw, { env = process.env, fetchImpl = fetch } = {}) {
  exact(raw, ['employee_id','dot_id','dispatch_message_id','artifact_id']);
  const identityInput = { organization_id: claims.org_id, user_id: claims.sub, ...raw, operation: 'artifact' };
  for (const key of ['organization_id','user_id','employee_id','dispatch_message_id']) if (!UUID.test(identityInput[key] || '')) lifecycleError('invalid_open_dot_employee_operation', 400);
  if (!DOT_ID.test(identityInput.dot_id || '') || !FILE_ID.test(identityInput.artifact_id || '')) lifecycleError('invalid_open_dot_employee_operation', 400);
  const identity = await visibleBoundEmployee(db, identityInput);
  const payload = { version: 1, organizationId: claims.org_id, userId: claims.sub, employeeId: identity.employeeId,
    dotId: identity.dotId, dispatchMessageId: identityInput.dispatch_message_id, artifactId: identityInput.artifact_id };
  const secret = env.OPEN_DOT_RUNTIME_BRIDGE_TOKEN;
  if (typeof secret !== 'string' || Buffer.byteLength(secret,'utf8') < 32) lifecycleError('open_dot_runtime_bridge_unavailable', 503);
  let response;
  try { response = await fetchImpl(DOT_RUNTIME_ARTIFACT_URL, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(payload) }); }
  catch { lifecycleError('open_dot_runtime_unavailable', 503); }
  const artifactResult = await readBounded(response, MAX_DOT_RESPONSE_BYTES, 'open_dot_runtime_invalid_artifact');
  if (!response.ok) lifecycleError('open_dot_artifact_unavailable', response.status >= 500 ? 503 : 409);
  if (artifactResult.employeeId !== identity.employeeId || artifactResult.dotId !== identity.dotId ||
      artifactResult.dispatchMessageId !== identityInput.dispatch_message_id || artifactResult.artifact?.id !== identityInput.artifact_id) {
    lifecycleError('open_dot_artifact_unverified', 409);
  }
  const artifact = artifactResult.artifact;
  if (!artifact || typeof artifact.name !== 'string' || !artifact.name.trim() || artifact.name.length > 240 ||
      typeof artifact.mime !== 'string' || artifact.mime.length > 160 || !Number.isSafeInteger(artifact.size) ||
      artifact.size < 0 || artifact.size > MAX_ARTIFACT_BYTES || !/^[a-f0-9]{64}$/.test(artifact.checksum || '') ||
      typeof artifact.dataBase64 !== 'string') lifecycleError('open_dot_artifact_invalid', 409);
  const bytes = Buffer.from(artifact.dataBase64, 'base64');
  if (bytes.length !== artifact.size || createHash('sha256').update(bytes).digest('hex') !== artifact.checksum) {
    lifecycleError('open_dot_artifact_invalid', 409);
  }
  return { ...artifact, dataBase64: bytes.toString('base64') };
}
