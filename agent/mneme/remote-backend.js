// Remote .amr backend (MNEME_MODE=remote). Runs in OUR core. For a BYOD org the data plane (.amr +
// optionally Postgres) lives on the CUSTOMER's box, reached through an hm-agent. This module marshals
// the same driver ops (recall/write/edge/hydrate) over HTTPS to that org's agent endpoint. The agent
// dials OUT to our broker, so the URL we use is the broker-side tunnel address for the tenant.
//
// Zero impact on dual/sole orgs — only invoked when mnemeMode()==='remote'.

const TIMEOUT_MS = Number(process.env.MNEME_REMOTE_TIMEOUT_MS || 4000);

// orgId → { url, token }. Sources, in order:
//   1. the broker registry (registerAgent below), populated when an agent enrolls.
//   2. MNEME_AGENT_URLS env: "orgId=https://host|token,orgId2=...".
const _registry = new Map();

function _loadEnv() {
  const raw = (process.env.MNEME_AGENT_URLS || '').trim();
  if (!raw) return;
  for (const entry of raw.split(',')) {
    const [org, rest] = entry.split('=');
    if (!org || !rest) continue;
    const [url, token] = rest.split('|');
    _registry.set(org.trim(), { url: url.trim(), token: (token || '').trim() });
  }
}
_loadEnv();

// Broker calls this when an agent enrolls (API-key authenticated → orgId resolved).
export function registerAgent(orgId, url, token) {
  _registry.set(orgId, { url, token });
}
export function unregisterAgent(orgId) { _registry.delete(orgId); }
export function agentFor(orgId) { return _registry.get(orgId) || null; }
export function isRemoteReady(orgId) { return _registry.has(orgId); }

async function _call(orgId, path, body) {
  const a = _registry.get(orgId);
  if (!a) throw new Error(`no hm-agent registered for org ${orgId}`);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${a.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${a.token}`, 'x-org-id': orgId },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`agent ${path} → ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Returns Qdrant-shaped hits [{id, score, payload}] or null on failure (caller falls back).
export async function remoteRecall(orgId, vector, filter, limit, scoreThreshold) {
  try {
    const out = await _call(orgId, '/v1/recall', { vector, filter, limit, scoreThreshold });
    return Array.isArray(out?.results) ? out.results : null;
  } catch (e) {
    console.warn(`[mneme/remote] recall failed org=${orgId}: ${e.message}`);
    return null;
  }
}

export async function remoteWrite(orgId, record, vector, rels = []) {
  try { await _call(orgId, '/v1/write', { record, vector, rels }); return true; }
  catch (e) { console.warn(`[mneme/remote] write failed org=${orgId}: ${e.message}`); return null; }
}

export async function remoteAddEdge(orgId, rel) {
  try { await _call(orgId, '/v1/edge', { rel }); return true; }
  catch (e) { console.warn(`[mneme/remote] edge failed org=${orgId}: ${e.message}`); return null; }
}

// Hydrate full memory rows from the customer's Postgres (so recall content stays on their box).
export async function remoteHydrate(orgId, ids) {
  try { const out = await _call(orgId, '/v1/hydrate', { ids }); return out?.memories || []; }
  catch (e) { console.warn(`[mneme/remote] hydrate failed org=${orgId}: ${e.message}`); return []; }
}
