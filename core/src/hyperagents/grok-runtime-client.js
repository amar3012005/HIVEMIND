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
  if (!config || !orgId || !userId) return { mode: 'off', version: 1, reason: 'disabled' };
  try {
    const response = await request(`/decision?org_id=${encodeURIComponent(orgId)}&user_id=${encodeURIComponent(userId)}`);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { mode: 'off', version: 1, reason: `decision_http_${response.status}` };
    return {
      mode: normalizeGrokRuntimeMode(body.mode),
      version: Math.max(1, Number(body.processing_version) || 1),
      reason: String(body.reason || 'flagship'),
      variant: body.variant || null,
    };
  } catch (error) {
    console.warn('[grok-hyperagents] Flagship decision failed closed:', error.message);
    return { mode: 'off', version: 1, reason: 'decision_unavailable' };
  }
}

export async function startGrokRoomWorkflow({ turnId, roomId, orgId, userId, mode, version }) {
  const workflowInstanceId = grokWorkflowId(turnId, version);
  const response = await request('/start', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      turn_id: turnId, room_id: roomId, org_id: orgId, user_id: userId,
      mode: normalizeGrokRuntimeMode(mode), processing_version: Math.max(1, Number(version) || 1),
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

export function verifyGrokWorkflowSecret(req) {
  const expected = String(process.env.HYPER_GROK_WORKFLOW_SECRET || '');
  const actual = String(req?.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(actual); const b = Buffer.from(expected);
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}
