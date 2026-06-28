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
export async function remoteList(orgId, filter, cursor, limit, offset = 0) {
  try { const out = await _call(orgId, '/v1/list', { filter, cursor, limit, offset }); return { memories: out?.memories || [], cursor: out?.cursor || null }; }
  catch (e) { console.warn(`[mneme/remote] list failed org=${orgId}: ${e.message}`); return { memories: [], cursor: null }; }
}

// Hard or soft delete of a memory row + vector + edges + versions + tombstone on the agent.
// hard=true → permanent erasure (GDPR). hard=false → soft-delete (deletedAt set).
export async function remoteDelete(orgId, id, hard = false) {
  try { await _call(orgId, '/v1/delete', { id, hard }); return true; }
  catch (e) { console.warn(`[mneme/remote] delete failed org=${orgId} id=${id}: ${e.message}`); return null; }
}

// Profile/Overview counts for a remote org (memory_count + relationship_count) — central holds 0.
export async function remoteStats(orgId, filter = {}) {
  try { return await _call(orgId, '/v1/stats', { filter }); }
  catch (e) { console.warn(`[mneme/remote] stats failed org=${orgId}: ${e.message}`); return null; }
}

// Graph nodes+edges for a remote org's Memory Graph view.
export async function remoteGraph(orgId, opts = {}) {
  try { const out = await _call(orgId, '/v1/graph', { limit: opts.limit, filter: opts.filter || {} }); return { nodes: out?.nodes || [], edges: out?.edges || [] }; }
  catch (e) { console.warn(`[mneme/remote] graph failed org=${orgId}: ${e.message}`); return { nodes: [], edges: [] }; }
}

// Lexical (keyword/FTS) leg of hybrid recall over the agent's Postgres. Returns Qdrant-shaped hits.
export async function remoteLexical(orgId, text, filter, limit) {
  try { const out = await _call(orgId, '/v1/lexical', { text, filter, limit }); return Array.isArray(out?.results) ? out.results : []; }
  catch (e) { console.warn(`[mneme/remote] lexical failed org=${orgId}: ${e.message}`); return []; }
}

// ── KB layer (self-host): documents + evidence segments live on the agent ──
export async function remoteKbDoc(orgId, doc) {
  try { await _call(orgId, '/v1/kb-doc', { doc }); return true; }
  catch (e) { console.warn(`[mneme/remote] kb-doc failed org=${orgId}: ${e.message}`); return null; }
}
export async function remoteKbSegment(orgId, segment, vector) {
  try { const out = await _call(orgId, '/v1/kb-segment', { segment, vector }); return out?.ok ? true : null; }
  catch (e) { console.warn(`[mneme/remote] kb-segment failed org=${orgId}: ${e.message}`); return null; }
}
export async function remoteKbRecall(orgId, vector, opts = {}) {
  try { const out = await _call(orgId, '/v1/kb-recall', { vector, limit: opts.limit, documentId: opts.documentId, scoreThreshold: opts.scoreThreshold }); return out?.results || []; }
  catch (e) { console.warn(`[mneme/remote] kb-recall failed org=${orgId}: ${e.message}`); return []; }
}
export async function remoteKbHydrate(orgId, ids) {
  try { const out = await _call(orgId, '/v1/kb-hydrate', { ids }); return out?.segments || []; }
  catch (e) { console.warn(`[mneme/remote] kb-hydrate failed org=${orgId}: ${e.message}`); return []; }
}

// KB doc LIST for remote org — returns central-shaped { documents, pagination } or null on failure.
export async function remoteKbDocs(orgId, opts = {}) {
  try { return await _call(orgId, '/v1/kb-docs', { limit: opts.limit, offset: opts.offset }); }
  catch (e) { console.warn(`[mneme/remote] kb-docs failed org=${orgId}: ${e.message}`); return null; }
}

// KB doc DETAIL for remote org — returns { document, segments, promotedMemories, segmentCount, promotedCount } or null.
export async function remoteKbDocDetail(orgId, documentId) {
  try { const out = await _call(orgId, '/v1/kb-doc-detail', { documentId }); return out?.error ? null : out; }
  catch (e) { console.warn(`[mneme/remote] kb-doc-detail failed org=${orgId} id=${documentId}: ${e.message}`); return null; }
}

// Per-memory edge counts for remote org — returns { <id>: {in, out} } or {} on failure.
export async function remoteMemEdges(orgId, ids) {
  try { return await _call(orgId, '/v1/mem-edges', { ids }); }
  catch (e) { console.warn(`[mneme/remote] mem-edges failed org=${orgId}: ${e.message}`); return {}; }
}

// Per-memory relationships for remote org — returns central-shaped relationship object or null.
export async function remoteMemRelationships(orgId, memoryId) {
  try { const out = await _call(orgId, '/v1/mem-relationships', { memoryId }); return out?.error ? null : out; }
  catch (e) { console.warn(`[mneme/remote] mem-relationships failed org=${orgId} id=${memoryId}: ${e.message}`); return null; }
}

// GDPR erasure: purge the ENTIRE org's data on the agent (all rows + vectors + edges). Returns
// { ok, deleted } from the agent, or null on failure (account-delete records the failure but proceeds
// to sever the central link; the saga can be retried). Self-host: physical destruction of the box is
// the customer's responsibility per the DPA — this erases what the agent controls.
export async function remotePurge(orgId) {
  try { const out = await _call(orgId, '/v1/purge', {}); return out || { ok: true }; }
  catch (e) { console.warn(`[mneme/remote] purge failed org=${orgId}: ${e.message}`); return null; }
}

// ── Meetings layer (self-host) ───────────────────────────────────────────────
// Upsert a full meeting row on the agent. Returns { ok, id, created_at } or null on failure.
export async function remoteMeetingWrite(orgId, meeting) {
  try { return await _call(orgId, '/v1/meeting-write', { meeting }); }
  catch (e) { console.warn(`[mneme/remote] meeting-write failed org=${orgId}: ${e.message}`); return null; }
}

// List meetings for the org (simplified scope: org + deleted_at + limit).
export async function remoteMeetingList(orgId, filter = {}) {
  try { const out = await _call(orgId, '/v1/meeting-list', { filter }); return out?.meetings || []; }
  catch (e) { console.warn(`[mneme/remote] meeting-list failed org=${orgId}: ${e.message}`); return []; }
}

// Fetch one meeting by id. Returns the meeting object or null.
export async function remoteMeetingGet(orgId, id) {
  try { const out = await _call(orgId, '/v1/meeting-get', { id }); return out?.meeting || null; }
  catch (e) { console.warn(`[mneme/remote] meeting-get failed org=${orgId} id=${id}: ${e.message}`); return null; }
}

// Soft or hard delete a meeting row.
export async function remoteMeetingDelete(orgId, id, hard = false) {
  try { const out = await _call(orgId, '/v1/meeting-delete', { id, hard }); return out || { ok: true }; }
  catch (e) { console.warn(`[mneme/remote] meeting-delete failed org=${orgId} id=${id}: ${e.message}`); return null; }
}

// Patch selected fields (source_memory_id, title, summary, intelligence, intelligence_status).
export async function remoteMeetingPatch(orgId, id, fields) {
  try { return await _call(orgId, '/v1/meeting-patch', { id, fields }); }
  catch (e) { console.warn(`[mneme/remote] meeting-patch failed org=${orgId} id=${id}: ${e.message}`); return null; }
}

// ── TARA call ledger (self-host) ─────────────────────────────────────────────
// Unified TARA call operation: op = 'upsert' | 'get' | 'update'.
export async function remoteTaraCall(orgId, params) {
  try { return await _call(orgId, '/v1/tara-call', params); }
  catch (e) { console.warn(`[mneme/remote] tara-call failed org=${orgId} op=${params?.op}: ${e.message}`); return null; }
}
