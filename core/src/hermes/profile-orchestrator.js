/**
 * Hermes per-tenant PROFILE orchestrator — HTTP CLIENT (Phase 6h transport).
 *
 * SECURITY CHANGE (6h): hm-control is public-facing and has NO docker / no
 * docker.sock. The previous 6c implementation shelled out to `docker exec
 * hm-hermes hermes …` from here — impossible in the deployed container, and the
 * only way to make it work (mounting the host socket into a public container)
 * is a host-root escalation we explicitly rejected.
 *
 * Instead, lifecycle now runs INSIDE hm-hermes via its in-container management
 * server (services/hm-hermes/mgmt-server.mjs, an s6 longrun). This module is a
 * thin authenticated HTTP client to that server, reachable only on the internal
 * `hmtest` network (the mgmt port is never published to the host). No docker,
 * no socket, no shell — fixed hermes subcommands run locally on the hm-hermes
 * side. Exported function signatures are unchanged so profile-manager (6d) and
 * profile orchestration callers need no edits.
 *
 * @module hermes/profile-orchestrator
 */
const MGR_URL = (process.env.HERMES_MGR_URL || 'http://hm-hermes:8650').replace(/\/+$/, '');
const MGMT_KEY = process.env.HERMES_MGMT_KEY || '';
const TIMEOUT_MS = Number(process.env.HERMES_MGR_TIMEOUT_MS || 60000);

/** profile name for a tenant: org-<sanitized>. (Must match the server side.) */
export function profileName(tenantId) {
  const s = String(tenantId).toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `org-${s}`;
}

/** Provider base URLs for the OpenAI-compatible `custom` provider. */
export const PROVIDER_BASE_URLS = {
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};

/**
 * Build a profile config.yaml (model + HiveMind MCP). model.api_key MUST be a
 * literal (Hermes does NOT resolve env-refs for model.api_key; it DOES for MCP
 * headers). Used by fresh-create (profile-manager) and the model-switch route.
 * @param {{ provider?: 'groq'|'openrouter', model: string, apiKeyLiteral: string, mcpUrl: string }} o
 */
export function buildConfigYaml({ provider = 'groq', model, apiKeyLiteral, mcpUrl }) {
  const baseUrl = PROVIDER_BASE_URLS[provider] || PROVIDER_BASE_URLS.groq;
  return [
    'model:',
    `  default: ${model}`,
    '  provider: custom',
    `  base_url: ${baseUrl}`,
    `  api_key: ${apiKeyLiteral}`,
    'mcp:',
    '  hivemind:',
    `    url: ${mcpUrl}`,
    '    headers:',
    '      Authorization: Bearer ${MCP_HIVEMIND_API_KEY}',
    '    enabled: true',
    '',
  ].join('\n');
}

/** Authenticated JSON call to the in-container management server. */
async function mgr(method, path, body) {
  if (!MGMT_KEY) return { ok: false, error: 'HERMES_MGMT_KEY missing (fail-closed)' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${MGR_URL}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MGMT_KEY}` },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || `mgmt ${res.status}`, ...data };
    return data;
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'mgmt timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create a tenant profile + write its gateway .env (port/keys) and optional SOUL.
 * Does NOT start the gateway (call startGateway).
 * @param {string} tenantId
 * @param {{ apiKey: string, port: number, soul?: string, extraEnv?: Record<string,string> }} cfg
 * @returns {Promise<{ ok:boolean, profile:string, port:number, issues:string[] }>}
 */
export async function createProfile(tenantId, { apiKey, port, soul = null, extraEnv = {} } = {}) {
  const profile = profileName(tenantId);
  if (!apiKey || !port) return { ok: false, profile, port, issues: ['apiKey + port required'] };
  const r = await mgr('POST', '/mgmt/profile/create', { tenantId, apiKey, port, soul, extraEnv });
  if (!r.ok) return { ok: false, profile, port, issues: r.issues || [r.error || 'create failed'] };
  return { ok: true, profile, port, issues: [] };
}

/** Write a file under a tenant's profile dir (e.g. 'config.yaml', 'mcp.json'). */
export async function writeProfileFile(tenantId, relpath, content) {
  const contentB64 = Buffer.from(String(content), 'utf8').toString('base64');
  const r = await mgr('POST', '/mgmt/profile/file', { tenantId, relpath, contentB64 });
  return !!r.ok;
}

export async function startGateway(tenantId) {
  const r = await mgr('POST', '/mgmt/gateway/start', { tenantId });
  return { ok: !!r.ok, issues: r.ok ? [] : (r.issues || [r.error]) };
}
export async function stopGateway(tenantId) {
  const r = await mgr('POST', '/mgmt/gateway/stop', { tenantId });
  return { ok: !!r.ok, issues: r.ok ? [] : (r.issues || [r.error]) };
}
export async function restartGateway(tenantId) {
  const r = await mgr('POST', '/mgmt/gateway/restart', { tenantId });
  return { ok: !!r.ok, issues: r.ok ? [] : (r.issues || [r.error]) };
}

/** @returns {Promise<{ exists:boolean, gatewayRunning:boolean }>} */
export async function getProfileStatus(tenantId) {
  const r = await mgr('GET', `/mgmt/profile/status?tenantId=${encodeURIComponent(tenantId)}`);
  if (!r.ok) return { exists: false, gatewayRunning: false };
  return { exists: !!r.exists, gatewayRunning: !!r.gatewayRunning };
}

/** Stop gateway + delete the profile (data-preserving by intent on the server). */
export async function deleteProfile(tenantId) {
  const r = await mgr('POST', '/mgmt/profile/delete', { tenantId });
  return { ok: !!r.ok, issues: r.ok ? [] : (r.issues || [r.error]) };
}

/** Liveness/auth probe against the management server. */
export async function pingManager() {
  const r = await mgr('POST', '/mgmt/ping', {});
  return { ok: !!r.ok, error: r.error };
}

/**
 * List cron jobs for a tenant's profile via the mgmt-server.
 * @param {string} tenantId
 * @returns {Promise<{ ok:boolean, jobs:object[], raw:string, issues:string[] }>}
 */
export async function listCron(tenantId) {
  const r = await mgr('POST', '/mgmt/cron/list', { tenantId });
  if (!r.ok) return { ok: false, jobs: [], raw: '', issues: r.issues || [r.error || 'listCron failed'] };
  return { ok: true, jobs: r.jobs || [], raw: r.raw || '', issues: [] };
}

/**
 * Add a cron job to a tenant's profile via the mgmt-server.
 * @param {string} tenantId
 * @param {{ cron:string, prompt?:string, name?:string, deliver?:string }} opts
 * @returns {Promise<{ ok:boolean, jobId:string|null, issues:string[] }>}
 */
export async function addCron(tenantId, { cron, prompt = '', name = '', deliver = 'origin' } = {}) {
  const r = await mgr('POST', '/mgmt/cron/add', { tenantId, cron, prompt, name, deliver });
  if (!r.ok) return { ok: false, jobId: null, issues: r.issues || [r.error || 'addCron failed'] };
  return { ok: true, jobId: r.jobId || null, issues: [] };
}

/**
 * Delete a cron job from a tenant's profile via the mgmt-server.
 * @param {string} tenantId
 * @param {string} jobId  12-hex cron job id
 * @returns {Promise<{ ok:boolean, issues:string[] }>}
 */
export async function deleteCron(tenantId, jobId) {
  const r = await mgr('POST', '/mgmt/cron/delete', { tenantId, jobId });
  if (!r.ok) return { ok: false, issues: r.issues || [r.error || 'deleteCron failed'] };
  return { ok: true, issues: [] };
}

/**
 * Merge env key/value pairs into a tenant profile's .env without clobbering
 * unrelated keys. Uses the mgmt-server /mgmt/profile/env-merge route.
 *
 * Callers MUST NOT log `env` values — they will contain secrets (bot tokens).
 *
 * @param {string} tenantId
 * @param {Record<string,string>} env  Keys → values to upsert into the profile .env
 * @returns {Promise<{ ok:boolean, issues:string[] }>}
 */
export async function mergeProfileEnv(tenantId, env) {
  const r = await mgr('POST', '/mgmt/profile/env-merge', { tenantId, env });
  if (!r.ok) return { ok: false, issues: r.issues || [r.error || 'mergeProfileEnv failed'] };
  return { ok: true, issues: [] };
}
