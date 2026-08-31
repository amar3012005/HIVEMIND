import crypto from 'node:crypto';

export const GROK_RUNTIME_MODES = Object.freeze([
  'off', 'shadow_roster', 'persistent_agents', 'durable_assignments',
  'real_tools', 'collaboration', 'browser', 'skills', 'routines', 'full',
]);
const RANK = new Map(GROK_RUNTIME_MODES.map((mode, index) => [mode, index]));

export function normalizeGrokRuntimeMode(value) {
  const mode = String(value || 'off').trim().toLowerCase();
  return RANK.has(mode) ? mode : 'off';
}

export function grokModeAtLeast(value, required) {
  return (RANK.get(normalizeGrokRuntimeMode(value)) || 0) >= (RANK.get(required) || 0);
}

export function grokWorkflowId(turnId, version = 1) {
  return `room-${turnId}-v${Math.max(1, Number(version) || 1)}`;
}

export function grokAssignmentWorkflowId(workOrderId, version = 1) {
  return `agent-${workOrderId}-v${Math.max(1, Number(version) || 1)}`;
}

export function grokRoomInstanceId(orgId, roomId) {
  const digest = crypto.createHash('sha256').update(`${orgId}:${roomId}`).digest('hex').slice(0, 32);
  return `hr-${digest}`;
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function createGrokRealtimeTicket({ orgId, userId, roomId, ttlSeconds = 120 }) {
  const config = configuration();
  if (!config) throw Object.assign(new Error('Grok HyperAgents runtime is disabled'), { code: 'GROK_RUNTIME_DISABLED' });
  const roomInstanceId = grokRoomInstanceId(orgId, roomId);
  const payload = base64UrlJson({
    room_instance_id: roomInstanceId, org_id: orgId, user_id: userId,
    exp: Math.floor(Date.now() / 1000) + Math.max(30, Math.min(300, Number(ttlSeconds) || 120)),
  });
  const signature = crypto.createHmac('sha256', config.secret).update(payload).digest('base64url');
  const workerUrl = new URL(config.baseUrl);
  workerUrl.protocol = workerUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  workerUrl.pathname = `/agents/hyper-room-gateway/${roomInstanceId}`;
  workerUrl.search = new URLSearchParams({ token: `${payload}.${signature}` }).toString();
  return { roomInstanceId, websocketUrl: workerUrl.toString(), expiresIn: Math.max(30, Math.min(300, Number(ttlSeconds) || 120)) };
}

export async function publishGrokRoomEvent({ orgId, roomId, event }) {
  const response = await request('/rooms/publish', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ room_instance_id: grokRoomInstanceId(orgId, roomId), event }),
  }, 5_000);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `room_gateway_http_${response.status}`);
  }
  return response.json();
}

function configuration() {
  if (process.env.HYPER_GROK_RUNTIME_ENABLED !== 'true') return null;
  const local = process.env.HIVEMIND_LOCAL_MODE === 'true';
  const environment = String(process.env.HYPER_GROK_RUNTIME_ENVIRONMENT || (local ? 'local' : '')).toLowerCase();
  if (environment === 'local' && !local) return null;
  if (environment === 'production' && (local || process.env.NODE_ENV !== 'production'
      || process.env.HYPER_GROK_PRODUCTION_ACK !== 'enable-grok-hyperagents-v1')) return null;
  const baseUrl = String(process.env.HYPER_GROK_WORKFLOW_URL || '').replace(/\/$/, '');
  const secret = String(process.env.HYPER_GROK_WORKFLOW_SECRET || '');
  return baseUrl && secret && ['local', 'production'].includes(environment)
    ? { baseUrl, secret, environment }
    : null;
}

async function request(pathname, init = {}, timeoutMs = 10_000) {
  const config = configuration();
  if (!config) throw Object.assign(new Error('Grok HyperAgents runtime is disabled'), { code: 'GROK_RUNTIME_DISABLED' });
  return fetch(`${config.baseUrl}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${config.secret}`, ...(init.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export async function evaluateGrokRuntime({ orgId, userId }) {
  const config = configuration();
  if (!config || !orgId || !userId) return {
    mode: 'off', version: 1, reason: 'disabled', fastPlannerMode: 'off',
  };
  try {
    const response = await request(`/decision?org_id=${encodeURIComponent(orgId)}&user_id=${encodeURIComponent(userId)}`);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return {
      mode: 'off', version: 1, reason: `decision_http_${response.status}`, fastPlannerMode: 'off',
    };
    return {
      mode: normalizeGrokRuntimeMode(body.mode),
      version: Math.max(1, Number(body.processing_version) || 1),
      reason: String(body.reason || 'flagship'),
      variant: body.variant || null,
      fastPlannerMode: body.fast_planner_mode === 'glm_no_reasoning' ? 'glm_no_reasoning' : 'off',
    };
  } catch (error) {
    console.warn('[grok-hyperagents] Flagship decision failed closed:', error.message);
    return { mode: 'off', version: 1, reason: 'decision_unavailable', fastPlannerMode: 'off' };
  }
}

export async function startGrokRoomWorkflow({ turnId, roomId, orgId, userId, mode, version, fastPlannerMode = 'off' }) {
  const workflowInstanceId = grokWorkflowId(turnId, version);
  const response = await request('/start', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      turn_id: turnId, room_id: roomId, org_id: orgId, user_id: userId,
      mode: normalizeGrokRuntimeMode(mode), processing_version: Math.max(1, Number(version) || 1),
      fast_planner_mode: fastPlannerMode === 'glm_no_reasoning' ? 'glm_no_reasoning' : 'off',
    }),
  }, 15_000);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || `workflow_http_${response.status}`), {
    code: body.code || 'GROK_WORKFLOW_ADMISSION_FAILED', retryable: response.status >= 500,
  });
  return { workflowInstanceId: body.instance_id || workflowInstanceId };
}

export async function provisionGrokRoster({ turnId, roomId, orgId, userId, mode, version }) {
  const response = await request('/provision', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      turn_id: turnId, room_id: roomId, org_id: orgId, user_id: userId,
      mode: normalizeGrokRuntimeMode(mode), processing_version: Math.max(1, Number(version) || 1),
    }),
  }, 30_000);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || `provision_http_${response.status}`), {
    code: 'GROK_AGENT_PROVISION_FAILED', retryable: response.status >= 500,
  });
  return body;
}

export async function controlGrokRoomWorkflow({ workflowInstanceId, action }) {
  const response = await request(`/workflows/${encodeURIComponent(workflowInstanceId)}/control`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  }, 15_000);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `workflow_control_http_${response.status}`);
  return body;
}

export async function startGrokAssignmentWorkflow(params) {
  const response = await request('/assignments/start', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      turn_id: params.turnId, room_id: params.roomId, work_order_id: params.workOrderId,
      agent_instance_id: params.agentInstanceId, org_id: params.orgId, user_id: params.userId,
      mode: normalizeGrokRuntimeMode(params.mode), processing_version: Math.max(1, Number(params.version) || 1),
    }),
  }, 15_000);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `assignment_workflow_http_${response.status}`);
  return { workflowInstanceId: body.instance_id || grokAssignmentWorkflowId(params.workOrderId, params.version) };
}

export async function scheduleGrokRoutine(params) {
  const response = await request('/routines/schedule', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      org_id: params.orgId, user_id: params.userId, agent_instance_id: params.agentInstanceId,
      mode: normalizeGrokRuntimeMode(params.mode), routine_id: params.routineId,
      schedule_type: params.scheduleType, schedule_expression: params.scheduleExpression,
    }),
  }, 15_000);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `routine_schedule_http_${response.status}`);
  return body;
}

export function verifyGrokWorkflowSecret(req) {
  const expected = String(process.env.HYPER_GROK_WORKFLOW_SECRET || '');
  const actual = String(req?.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(actual); const b = Buffer.from(expected);
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}
