// Remote .amr backend (MNEME_MODE=remote). Runs in OUR core. For a BYOD org the data plane (.amr +
// optionally Postgres) lives on the CUSTOMER's box, reached through an hm-agent. This module marshals
// the same driver ops (recall/write/edge/hydrate) over HTTPS to that org's agent endpoint. The agent
// dials OUT to our broker, so the URL we use is the broker-side tunnel address for the tenant.
//
// Zero impact on dual/sole orgs — only invoked when mnemeMode()==='remote'.

const TIMEOUT_MS = Number(process.env.MNEME_REMOTE_TIMEOUT_MS || 4000);

// orgId → { url, token }. Sources, in order:
//   1. in-memory (registerAgent — same-process enrollment).
//   2. MNEME_AGENT_REGISTRY_FILE: JSON { orgId: { url, token } } written by the standalone broker
//      (on a shared volume). Lazy-loaded on miss + re-read when stale, so the core picks up new
//      enrollments without a restart and without the broker touching the core process.
//   3. MNEME_AGENT_URLS env: "orgId=https://host|token,orgId2=...".
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';

const _registry = new Map();
// Default to a path on the shared core↔control volume. Self-host activates simply by the file existing
// (the register route writes it) — no env flip needed. Empty/absent file → inert (all orgs managed).
const REG_FILE = process.env.MNEME_AGENT_REGISTRY_FILE || '/app/data/byod-agents.json';
let _fileMtime = 0;
let _lastCheck = 0;

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
function _loadFile() {
  // Throttle the filesystem check (getPrismaClient is hot): re-check at most every 2s.
  const now = Date.now();
  if (now - _lastCheck < 2000) return;
  _lastCheck = now;
  if (!REG_FILE || !existsSync(REG_FILE)) return;
  try {
    const m = statSync(REG_FILE).mtimeMs;
    if (m === _fileMtime) return; // unchanged
    _fileMtime = m;
    const obj = JSON.parse(readFileSync(REG_FILE, 'utf8'));
    for (const [org, v] of Object.entries(obj)) if (v?.url || v?.pgUrl || v?.qdrantUrl) _registry.set(org, { url: v.url || '', token: v.token || '', pgUrl: v.pgUrl || '', qdrantUrl: v.qdrantUrl || '', kind: v.kind });
  } catch { /* malformed file → keep what we have */ }
}
function _persist() {
  if (!REG_FILE) return;
  try { writeFileSync(REG_FILE, JSON.stringify(Object.fromEntries(_registry)), 'utf8'); } catch { /* best-effort */ }
}
_loadEnv();
_loadFile();

// Broker calls this when an agent enrolls (API-key authenticated → orgId resolved).
export function registerAgent(orgId, url, token) {
  _registry.set(orgId, { url, token });
  _persist();
}
export function unregisterAgent(orgId) { _registry.delete(orgId); _persist(); }
export function agentFor(orgId) {
  if (!_registry.has(orgId)) _loadFile(); // pick up a fresh enrollment from the shared file
  return _registry.get(orgId) || null;
}
export function isRemoteReady(orgId) { return !!agentFor(orgId); }
// True only for self-host-.amr: an hm-agent HTTP endpoint serves recall/.amr. Self-host-HYBRID
// (pgUrl + qdrantUrl, no agent url) is NOT remote — core connects to the customer PG+Qdrant directly.
export function hasRemoteAgent(orgId) { return !!agentFor(orgId)?.url; }

// Full-residency self-host: the customer's Postgres connection string (via their tunnel), recorded at
// enrollment. null → that org's relational data is NOT on a customer box (managed / vectors-only).
export function pgUrlFor(orgId) {
  return agentFor(orgId)?.pgUrl || null;
}
// The customer's Qdrant base URL (via their tunnel), for hybrid self-host. null → central Qdrant.
export function qdrantUrlFor(orgId) {
  return agentFor(orgId)?.qdrantUrl || null;
}

async function _call(orgId, path, body) {
  const a = agentFor(orgId);
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

// Resync entity:* tags to the agent .amr after deferred entity-linking attaches them, so recalled
// candidates carry their tags and the co-mention overlap gate can find shared entities.
export async function remoteUpdateTags(orgId, id, tags) {
  try { await _call(orgId, '/v1/update-tags', { id, tags }); return true; }
  catch (e) { console.warn(`[mneme/remote] update-tags failed org=${orgId}: ${e.message}`); return null; }
}

// Generic partial update (tags / is_latest / memory_type) on the agent row.
export async function remoteUpdate(orgId, id, patch) {
  try { await _call(orgId, '/v1/update', { id, ...patch }); return true; }
  catch (e) { console.warn(`[mneme/remote] update failed org=${orgId}: ${e.message}`); return null; }
}

// Hydrate full memory rows from the customer's Postgres (so recall content stays on their box).
export async function remoteHydrate(orgId, ids) {
  try { const out = await _call(orgId, '/v1/hydrate', { ids }); return out?.memories || []; }
  catch (e) { console.warn(`[mneme/remote] hydrate failed org=${orgId}: ${e.message}`); return []; }
}

// Filtered enumeration from the agent (listMemories for remote orgs). Returns { memories, cursor }.
export async function remoteList(orgId, filter, cursor, limit) {
  try { const out = await _call(orgId, '/v1/list', { filter, cursor, limit }); return { memories: out?.memories || [], cursor: out?.cursor || null }; }
  catch (e) { console.warn(`[mneme/remote] list failed org=${orgId}: ${e.message}`); return { memories: [], cursor: null }; }
}

// Hard or soft delete of a memory row + vector + edges + versions + tombstone on the agent.
// hard=true → permanent erasure (GDPR). hard=false → soft-delete (deletedAt set).
export async function remoteDelete(orgId, id, hard = false) {
  try { await _call(orgId, '/v1/delete', { id, hard }); return true; }
  catch (e) { console.warn(`[mneme/remote] delete failed org=${orgId} id=${id}: ${e.message}`); return null; }
}
