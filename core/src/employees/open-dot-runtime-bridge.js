/** Narrow authenticated relay from a scoped Harness principal to the fixed Open Dot runtime API. */
import { lifecycleError } from './native-lifecycle.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DOT_ID = /^dot_[a-zA-Z0-9_-]+$/;
const RUNTIME_SESSION_ID = /^session-[a-z0-9-]{1,120}$/;
const DOT_RUNTIME_URL = 'https://dots.singulancelabs.com/api/internal/hivemind/runtime';
const MAX_RESPONSE_BYTES = 64 * 1024;
const TIMEOUT_MS = 8000;

function exactObject(input, allowed, code = 'invalid_open_dot_runtime_request') {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !allowed.includes(key))) lifecycleError(code, 400);
}

function boundedText(value, code, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) lifecycleError(code, 400);
  return value;
}

export function requireRuntimeSession(claims, rootSessionId) {
  if (!RUNTIME_SESSION_ID.test(rootSessionId || '') || claims.operating_role !== 'runtime'
      || claims.operating_session !== rootSessionId) lifecycleError('runtime_session_required', 403);
}

async function visibleBoundEmployee(db, claims, employeeId, requestedDotId) {
  if (!UUID.test(employeeId || '')) lifecycleError('invalid_employee_id', 400);
  const membership = await db.userOrganization.findUnique({
    where: { userId_orgId: { userId: claims.sub, orgId: claims.org_id } },
    select: { role: true, isActive: true, deactivatedAt: true },
  });
  if (!membership?.isActive || membership.deactivatedAt) lifecycleError('organization_membership_required', 403);
  const employee = await db.digitalEmployee.findFirst({
    where: { id: employeeId, orgId: claims.org_id },
    select: { id: true, orgId: true, createdBy: true, teamId: true, scope: true, status: true,
      archivedAt: true, policyRules: true },
  });
  if (!employee) lifecycleError('employee_not_found', 404);
  if (employee.archivedAt || employee.status === 'paused') lifecycleError('employee_not_active', 409);
  const isAdmin = ['owner', 'admin'].includes(membership.role);
  if (!isAdmin) {
    const teamRows = await db.teamMember.findMany({
      where: { userId: claims.sub, team: { orgId: claims.org_id } }, select: { teamId: true },
    });
    const visible = employee.createdBy === claims.sub
      || (employee.scope === 'organization')
      || (employee.scope === 'team' && teamRows.some(row => row.teamId === employee.teamId));
    if (!visible) lifecycleError('employee_not_visible', 403);
  }
  const marker = employee.policyRules?.open_dot_employee;
  const lifecycle = employee.policyRules?.native_lifecycle;
  if (marker?.version !== 1 || marker.execution_backend !== 'open-dot' || marker.state !== 'bound'
      || lifecycle?.version !== 1 || lifecycle.phase !== 'active') lifecycleError('open_dot_employee_not_bound', 409);
  if (typeof marker.dot_id !== 'string' || !DOT_ID.test(marker.dot_id)
      || (requestedDotId !== undefined && requestedDotId !== marker.dot_id)) lifecycleError('open_dot_binding_mismatch', 409);
  return { employeeId: employee.id, dotId: marker.dot_id };
}

export async function postDot(path, payload, { env, fetchImpl = fetch } = {}) {
  const token = env.OPEN_DOT_RUNTIME_BRIDGE_TOKEN;
  if (typeof token !== 'string' || token.length < 32) lifecycleError('open_dot_runtime_bridge_unavailable', 503);
  let response;
  try {
    response = await fetchImpl(`${DOT_RUNTIME_URL}/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch { lifecycleError('open_dot_runtime_unavailable', 503); }
  let raw;
  try {
    if (response.body?.getReader) {
      const reader = response.body.getReader(); const chunks = []; let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); lifecycleError('open_dot_runtime_response_too_large', 502); }
        chunks.push(Buffer.from(value));
      }
      raw = Buffer.concat(chunks).toString('utf8');
    } else {
      raw = await response.text();
      if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) lifecycleError('open_dot_runtime_response_too_large', 502);
    }
    const value = JSON.parse(raw);
    if (!response.ok) lifecycleError('open_dot_runtime_request_failed', response.status >= 500 ? 503 : 409);
    return value;
  } catch (error) {
    if (error?.status) throw error;
    lifecycleError('open_dot_runtime_invalid_response', 502);
  }
}

export async function dispatchOpenDotRuntime(db, claims, input, { env, fetchImpl } = {}) {
  exactObject(input, ['employee_id', 'message_id', 'root_session_id', 'task_id', 'task_revision', 'kind', 'text', 'artifact_ids','direct_reply']);
  if (!UUID.test(input.message_id || '')) lifecycleError('invalid_open_dot_runtime_request', 400);
  requireRuntimeSession(claims, input.root_session_id);
  if (!['assignment', 'review', 'continuation', 'blocker', 'question', 'update'].includes(input.kind)) lifecycleError('invalid_open_dot_runtime_request', 400);
  const text = boundedText(input.text, 'invalid_open_dot_runtime_text', 12000);
  const artifactIds = input.artifact_ids ?? [];
  if (!Array.isArray(artifactIds) || artifactIds.length > 32 || artifactIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 180)) {
    lifecycleError('invalid_open_dot_runtime_artifacts', 400);
  }
  if (input.task_id !== undefined && (typeof input.task_id !== 'string' || !input.task_id.trim() || input.task_id.length > 180)) lifecycleError('invalid_open_dot_runtime_request', 400);
  if (input.task_revision !== undefined && (!Number.isSafeInteger(input.task_revision) || input.task_revision < 0)) lifecycleError('invalid_open_dot_runtime_request', 400);
  const binding = await visibleBoundEmployee(db, claims, input.employee_id);
  if (input.direct_reply!==undefined) {
    exactObject(input.direct_reply,['jobId','messageId','conversationId','contentDigest','nativeMessageId']);
    if (input.kind!=='update' || input.task_id!==undefined || input.task_revision!==undefined || artifactIds.length ||
      !/^[a-f0-9]{64}$/.test(input.direct_reply.contentDigest||'')) lifecycleError('invalid_open_dot_runtime_request',400);
    for (const key of ['jobId','messageId','conversationId','nativeMessageId']) boundedText(input.direct_reply[key],'invalid_open_dot_runtime_request',240);
  }
  return postDot('dispatch', { version: 1, organizationId: claims.org_id, userId: claims.sub,
    employeeId: binding.employeeId, dotId: binding.dotId, messageId: input.message_id,
    rootSessionId: input.root_session_id, ...(input.task_id === undefined ? {} : { taskId: input.task_id }),
    ...(input.task_revision === undefined ? {} : { taskRevision: input.task_revision }),
    kind: input.kind, text, artifactIds,...(input.direct_reply?{directReply:input.direct_reply}:{}) }, { env, fetchImpl });
}

export async function readOpenDotRuntimeStatus(db, claims, input, { env, fetchImpl } = {}) {
  exactObject(input, ['employee_id', 'dot_id', 'message_id', 'root_session_id']);
  if (!UUID.test(input.message_id || '')) lifecycleError('invalid_open_dot_runtime_request', 400);
  requireRuntimeSession(claims, input.root_session_id);
  const binding = await visibleBoundEmployee(db, claims, input.employee_id, input.dot_id);
  return postDot('status', { version: 1, organizationId: claims.org_id, userId: claims.sub,
    employeeId: binding.employeeId, dotId: binding.dotId, messageId: input.message_id,
    rootSessionId: input.root_session_id }, { env, fetchImpl });
}

/** Cancel only the dispatch bound to the authenticated Runtime root. */
export async function cancelOpenDotRuntime(db, claims, input, { env, fetchImpl } = {}) {
  exactObject(input, ['employee_id', 'dot_id', 'message_id', 'root_session_id']);
  if (!UUID.test(input.message_id || '')) lifecycleError('invalid_open_dot_runtime_request', 400);
  requireRuntimeSession(claims, input.root_session_id);
  const binding = await visibleBoundEmployee(db, claims, input.employee_id, input.dot_id);
  return postDot('cancel', { version: 1, organizationId: claims.org_id, userId: claims.sub,
    employeeId: binding.employeeId, dotId: binding.dotId, messageId: input.message_id,
    rootSessionId: input.root_session_id }, { env, fetchImpl });
}

/**
 * Delivers one coalesced employee wake (routed connected-app events) to OpenDot over the same bearer-authenticated bridge
 * that carries Runtime dispatches. OpenDot answers a replay of the same wake id with the saved receipt.
 * @param {object} payload Wake: version 1, organizationId, userId, employeeId, dotId, wakeId, events[], omitted?.
 * @param {{env?:object,fetchImpl?:Function}} [options] Environment and fetch for tests.
 * @returns {Promise<object>} OpenDot's receipt.
 */
export async function dispatchOpenDotEvent(payload, { env = process.env, fetchImpl } = {}) {
  return postDot('event', payload, { env, fetchImpl });
}
