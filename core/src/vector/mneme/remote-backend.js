// Remote .amr backend (MNEME_MODE=remote). Runs in OUR core. For a BYOD org the data plane (.amr +
// optionally Postgres) lives on the CUSTOMER's box, reached through an hm-agent. This module marshals
// the same driver ops (recall/write/edge/hydrate) over HTTPS to that org's agent endpoint. The agent
// dials OUT to our broker, so the URL we use is the broker-side tunnel address for the tenant.
//
// Zero impact on dual/sole orgs — only invoked when mnemeMode()==='remote'.

const TIMEOUT_MS = Number(process.env.MNEME_REMOTE_TIMEOUT_MS || 4000);
const FAILURE_COOLDOWN_MS = Number(process.env.MNEME_REMOTE_FAILURE_COOLDOWN_MS || 5000);
// Interactive recall is deliberately bounded below the Memory Box's saturation
// point. Its internal lanes already fan out; a small FIFO queue is faster and
// more reliable than letting one turn consume every remote socket.
// One hybrid recall deliberately overlaps memory semantic + lexical with
// evidence semantic + lexical. A default of two serialized those four owned
// lanes behind the queue (observed ~550-680ms in the nominal lexical stage),
// even after duplicate semantic searches were removed. Four admits exactly
// that interactive fan-out; bounded excess still queues and maintenance stays
// isolated on its separate one-slot transport class.
const MAX_INFLIGHT_PER_ORG = Math.max(1, Number(process.env.MNEME_REMOTE_MAX_INFLIGHT_PER_ORG || 4));
const MAX_MAINTENANCE_INFLIGHT_PER_ORG = Math.max(1, Number(process.env.MNEME_REMOTE_MAX_MAINTENANCE_INFLIGHT_PER_ORG || 1));
// Graph walks are neither hybrid retrieval nor maintenance. They can fan out
// through background cognition, so isolate and serialize them per tenant.
const MAX_GRAPH_INFLIGHT_PER_ORG = Math.max(1, Number(process.env.MNEME_REMOTE_MAX_GRAPH_INFLIGHT_PER_ORG || 1));
const MAX_QUEUED_PER_ORG = Math.max(1, Number(process.env.MNEME_REMOTE_MAX_QUEUED_PER_ORG || 32));
const MAX_GRAPH_QUEUED_PER_ORG = Math.max(1, Number(process.env.MNEME_REMOTE_MAX_GRAPH_QUEUED_PER_ORG || 128));
const _failureCircuitUntil = new Map();
const _inflightByCircuit = new Map();
const _waitersByCircuit = new Map();
const _capabilityCache = new Map();
const _coalescedReads = new Map();
const _coalescedGraphReads = new Map();
const _lastRemoteLogAt = new Map();
const REMOTE_LOG_DEDUPE_MS = Math.max(1000, Number(process.env.MNEME_REMOTE_LOG_DEDUPE_MS || 30000));

function _logRemoteOnce(level, operation, orgId, error, suffix = '') {
  const message = String(error?.message || error || 'unknown');
  const errorClass = /circuit open/i.test(message) ? 'circuit_open'
    : /timeout|aborted/i.test(message) ? 'timeout'
      : message.slice(0, 80);
  const key = `${level}:${operation}:${orgId}:${errorClass}`;
  const now = Date.now();
  if (now - (_lastRemoteLogAt.get(key) || 0) < REMOTE_LOG_DEDUPE_MS) return;
  _lastRemoteLogAt.set(key, now);
  console[level](`[mneme/remote] ${operation} failed org=${orgId}: ${message}${suffix}`);
}

export class RemoteMemoryUnavailableError extends Error {
  constructor(orgId, operation, cause = null) {
    super(`memory box unavailable for workspace ${orgId} (${operation})${cause?.message ? `: ${cause.message}` : ''}`);
    this.name = 'RemoteMemoryUnavailableError';
    this.code = 'REMOTE_MEMORY_UNAVAILABLE';
    this.orgId = orgId;
    this.operation = operation;
    this.cause = cause || undefined;
  }
}

export function isRemoteMemoryUnavailableError(error) {
  return error instanceof RemoteMemoryUnavailableError
    || error?.code === 'REMOTE_MEMORY_UNAVAILABLE';
}

function _transportClass(options = {}) {
  if (options?.transportClass === 'maintenance') return 'maintenance';
  if (options?.transportClass === 'graph') return 'graph';
  return 'interactive';
}

function _circuitKey(orgId, path, options = {}) {
  // Keep write durability independent from read availability. A timed-out
  // recall must not suppress a subsequent write/outbox attempt, while repeated
  // read hops during the same outage should fail fast instead of each spending
  // the full transport timeout.
  const isWrite = /^\/v1\/(write|edge|update|update-tags|delete|kb-doc|kb-segment|kb-table|kb-table-row|vector-repair)/.test(path);
  return `${orgId}:${isWrite ? 'write' : _transportClass(options)}`;
}

function _releaseSlot(circuitKey) {
  const remaining = Math.max(0, (_inflightByCircuit.get(circuitKey) || 1) - 1);
  if (remaining) _inflightByCircuit.set(circuitKey, remaining);
  else _inflightByCircuit.delete(circuitKey);
  const queue = _waitersByCircuit.get(circuitKey);
  while (queue?.length) {
    const waiter = queue.shift();
    if (waiter.signal?.aborted) continue;
    _inflightByCircuit.set(circuitKey, (_inflightByCircuit.get(circuitKey) || 0) + 1);
    waiter.cleanup();
    waiter.resolve();
    break;
  }
  if (!queue?.length) _waitersByCircuit.delete(circuitKey);
}

async function _acquireSlot(orgId, path, signal, options = {}) {
  const circuitKey = _circuitKey(orgId, path, options);
  const maxInflight = _transportClass(options) === 'maintenance'
    ? MAX_MAINTENANCE_INFLIGHT_PER_ORG
    : _transportClass(options) === 'graph'
      ? MAX_GRAPH_INFLIGHT_PER_ORG
    : MAX_INFLIGHT_PER_ORG;
  const current = _inflightByCircuit.get(circuitKey) || 0;
  if (current < maxInflight) {
    _inflightByCircuit.set(circuitKey, current + 1);
    return circuitKey;
  }
  const queue = _waitersByCircuit.get(circuitKey) || [];
  const maxQueued = _transportClass(options) === 'graph'
    ? MAX_GRAPH_QUEUED_PER_ORG
    : MAX_QUEUED_PER_ORG;
  if (queue.length >= maxQueued) {
    throw new RemoteMemoryUnavailableError(orgId, path, new Error('tenant transport queue full'));
  }
  await new Promise((resolve, reject) => {
    const waiter = { resolve, reject, signal, cleanup: () => {} };
    const abort = () => {
      const index = queue.indexOf(waiter);
      if (index >= 0) queue.splice(index, 1);
      waiter.cleanup();
      reject(signal.reason || new Error(`agent ${path} request cancelled while queued`));
    };
    waiter.cleanup = () => signal?.removeEventListener('abort', abort);
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    queue.push(waiter);
    _waitersByCircuit.set(circuitKey, queue);
  });
  return circuitKey;
}

// orgId → { url, token }. Sources, in order:
//   1. in-memory (registerAgent — same-process enrollment).
//   2. MNEME_AGENT_REGISTRY_FILE: JSON { orgId: { url, token } } written by the standalone broker
//      (on a shared volume). Lazy-loaded on miss + re-read when stale, so the core picks up new
//      enrollments without a restart and without the broker touching the core process.
//   3. MNEME_AGENT_URLS env: "orgId=https://host|token,orgId2=...".
import { readFileSync, writeFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { currentStageSignal } from '../../runtime/stage-deadline.js';

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
    for (const [org, v] of Object.entries(obj)) {
      if (!v?.url && !v?.pgUrl && !v?.qdrantUrl) continue;
      const fallbackTokens = (Array.isArray(v.previousTokens) ? v.previousTokens : [])
        .filter((entry) => entry?.token && (!entry.expiresAt || new Date(entry.expiresAt).getTime() > Date.now()))
        .map((entry) => entry.token);
      _registry.set(org, {
        url: v.url || '',
        token: v.token || '',
        fallbackTokens,
        pgUrl: v.pgUrl || '',
        qdrantUrl: v.qdrantUrl || '',
        kind: v.kind,
        maintenanceQuarantinedUntil: Number(v.maintenanceQuarantinedUntil || 0),
      });
    }
  } catch { /* malformed file → keep what we have */ }
}
function _persist() {
  if (!REG_FILE) return;
  try {
    const temporary = `${REG_FILE}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temporary, JSON.stringify(Object.fromEntries(_registry)), { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, REG_FILE);
  } catch { /* best-effort */ }
}
_loadEnv();
_loadFile();

// Broker calls this when an agent enrolls (API-key authenticated → orgId resolved).
export function registerAgent(orgId, url, token) {
  _registry.set(orgId, { url, token });
  _persist();
}
export function unregisterAgent(orgId) { _registry.delete(orgId); _persist(); }
export function quarantineRemoteAgentMaintenance(orgId, until) {
  const current = agentFor(orgId);
  if (!current) return false;
  _registry.set(orgId, { ...current, maintenanceQuarantinedUntil: Math.max(0, Number(until || 0)) });
  _persist();
  return true;
}
export function clearRemoteAgentMaintenanceQuarantine(orgId) {
  const current = agentFor(orgId);
  if (!current?.maintenanceQuarantinedUntil) return false;
  const { maintenanceQuarantinedUntil: _ignored, ...active } = current;
  _registry.set(orgId, active);
  _persist();
  return true;
}
export function agentFor(orgId) {
  if (!_registry.has(orgId)) _loadFile(); // pick up a fresh enrollment from the shared file
  return _registry.get(orgId) || null;
}
export function isRemoteReady(orgId) { return !!agentFor(orgId); }
// True only for self-host-.amr: an hm-agent HTTP endpoint serves recall/.amr. Self-host-HYBRID
// (pgUrl + qdrantUrl, no agent url) is NOT remote — core connects to the customer PG+Qdrant directly.
export function hasRemoteAgent(orgId) { return !!agentFor(orgId)?.url; }
export function remoteAgentOrgIds() {
  _loadFile();
  const now = Date.now();
  return [..._registry.entries()]
    .filter(([, value]) => value?.url
      && value.url !== 'local:'
      && value.kind === 'selfhost'
      && Number(value.maintenanceQuarantinedUntil || 0) <= now)
    .map(([orgId]) => orgId);
}

// Meeting finalization is a user-data recovery lifecycle, not vector
// maintenance. It must scan both external self-host agents and the managed
// `local:` embedded .amr shards. Keeping this separate from
// remoteAgentOrgIds() preserves maintenance quarantine semantics while making
// queued meeting reports survive a Core restart for every Memory Box mode.
export function meetingAgentOrgIds() {
  _loadFile();
  return [..._registry.entries()]
    .filter(([, value]) => value?.url)
    .map(([orgId]) => orgId);
}

// Full-residency self-host: the customer's Postgres connection string (via their tunnel), recorded at
// enrollment. null → that org's relational data is NOT on a customer box (managed / vectors-only).
export function pgUrlFor(orgId) {
  return agentFor(orgId)?.pgUrl || null;
}
// The customer's Qdrant base URL (via their tunnel), for hybrid self-host. null → central Qdrant.
export function qdrantUrlFor(orgId) {
  return agentFor(orgId)?.qdrantUrl || null;
}

async function _call(orgId, path, body, options = {}) {
  const a = agentFor(orgId);
  if (!a) throw new Error(`no hm-agent registered for org ${orgId}`);
  // EMBEDDED agent: registry url 'local:' = this org's .amr storage runs IN-PROCESS on central
  // (personal/managed .amr orgs — self-host semantics where the box is central itself). Same
  // route table, same shapes, no HTTP. Lazy import keeps deployments without the binding inert.
  if (a.url === 'local:') {
    const { dispatch } = await import('./embedded-agent.mjs');
    const out = await dispatch(orgId, path, body);
    if (out?.ok === false) throw new Error(`agent ${path} rejected request: ${out.error || 'ok=false'}`);
    return out;
  }
  const circuitKey = _circuitKey(orgId, path, options);
  const unavailableUntil = _failureCircuitUntil.get(circuitKey) || 0;
  if (unavailableUntil > Date.now()) {
    throw new RemoteMemoryUnavailableError(orgId, path, new Error('transport circuit open'));
  }
  const parentSignal = options.signal === false ? null : (options.signal || currentStageSignal());
  await _acquireSlot(orgId, path, parentSignal, options);
  const tokens = [a.token, ...(a.fallbackTokens || [])].filter(Boolean);
  let lastStatus = null;
  try {
    for (const token of tokens) {
    const ctrl = new AbortController();
    // The parent deadline has its own AbortSignal. Keep the transport timer at
    // the transport budget so two same-millisecond timers cannot misclassify a
    // caller cancellation as a network outage and poison the circuit.
    const requestTimeoutMs = Number(options.timeoutMs || TIMEOUT_MS);
    let transportTimeoutFired = false;
    const abortFromParent = () => {
      if (!ctrl.signal.aborted) ctrl.abort(parentSignal?.reason);
    };
    if (parentSignal?.aborted) abortFromParent();
    else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    const t = setTimeout(() => {
      transportTimeoutFired = true;
      if (!ctrl.signal.aborted) ctrl.abort(new Error(`agent ${path} transport timeout`));
    }, requestTimeoutMs);
    try {
      if (parentSignal?.aborted) throw parentSignal.reason || new Error(`agent ${path} request cancelled`);
      const res = await fetch(`${a.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-org-id': orgId },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (res.ok) {
        const out = await res.json();
        // The agent intentionally persists the relational row before attempting
        // the Qdrant write and reports a failed second phase as HTTP 200
        // {ok:false}. Treating transport success as operation success skipped the
        // durable outbox and left sovereign memories permanently lexical-only.
        if (out?.ok === false) {
          throw new Error(`agent ${path} rejected request: ${out.error || 'ok=false'}`);
        }
        _failureCircuitUntil.delete(circuitKey);
        return out;
      }
      lastStatus = res.status;
      // Only 401 can indicate a Box that has not switched to the rotated token.
      if (res.status !== 401) break;
    } catch (error) {
      // Only transport failures open the circuit. Authentication, capability
      // 404s and operation-level {ok:false} responses are deterministic and
      // must remain observable/retryable on their own terms.
      const cancelledByParent = Boolean(parentSignal?.aborted) && !transportTimeoutFired;
      if (!cancelledByParent && (transportTimeoutFired
          || error?.name === 'AbortError'
          || /fetch failed|socket|network|aborted|ECONN|ENOTFOUND|EAI_AGAIN/i.test(String(error?.message || '')))) {
        _failureCircuitUntil.set(circuitKey, Date.now() + FAILURE_COOLDOWN_MS);
      }
      throw error;
    } finally {
      clearTimeout(t);
      parentSignal?.removeEventListener('abort', abortFromParent);
    }
    }
    throw new Error(`agent ${path} → ${lastStatus || 'unreachable'}`);
  } finally {
    _releaseSlot(circuitKey);
  }
}

function _readKey(orgId, path, body) {
  // JSON is sufficient here because each caller builds a stable, server-owned
  // request shape. The key is process-local, short-lived, and never exposed.
  return `${orgId}:${path}:${JSON.stringify(body)}`;
}

function _releaseSharedReadConsumer(entry) {
  entry.consumers = Math.max(0, entry.consumers - 1);
  if (entry.consumers === 0 && !entry.settled && !entry.controller.signal.aborted) {
    entry.controller.abort(new Error('all coalesced remote read consumers cancelled'));
  }
}

function _awaitSharedRead(entry, signal) {
  entry.consumers += 1;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      _releaseSharedReadConsumer(entry);
      fn(value);
    };
    const abort = () => finish(reject, signal?.reason || new Error('remote read cancelled'));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    entry.promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

function _coalescedInteractiveRead(orgId, path, body) {
  const key = _readKey(orgId, path, body);
  let entry = _coalescedReads.get(key);
  if (!entry) {
    const controller = new AbortController();
    entry = { controller, consumers: 0, settled: false, promise: null };
    entry.promise = _call(orgId, path, body, { signal: controller.signal, transportClass: 'interactive' })
      .finally(() => {
        entry.settled = true;
        _coalescedReads.delete(key);
      });
    _coalescedReads.set(key, entry);
  }
  return _awaitSharedRead(entry, currentStageSignal());
}

// Relationship expansion is optional context, never a reason to compete with
// the four-lane hybrid recall. Coalesce identical frontiers and use its own
// one-slot transport class so resident/background traversals cannot turn into
// an interactive tenant-queue failure.
function _coalescedGraphRead(orgId, path, body) {
  const key = _readKey(orgId, path, body);
  let entry = _coalescedGraphReads.get(key);
  if (!entry) {
    const controller = new AbortController();
    entry = { controller, consumers: 0, settled: false, promise: null };
    entry.promise = _call(orgId, path, body, { signal: controller.signal, transportClass: 'graph' })
      .finally(() => {
        entry.settled = true;
        _coalescedGraphReads.delete(key);
      });
    _coalescedGraphReads.set(key, entry);
  }
  return _awaitSharedRead(entry, currentStageSignal());
}

// Returns Qdrant-shaped hits [{id, score, payload}]. A sovereign box failure
// is NOT an empty corpus and must remain distinguishable to every caller.
export async function remoteRecall(orgId, vector, filter, limit, scoreThreshold) {
  try {
    const out = await _coalescedInteractiveRead(orgId, '/v1/recall', { vector, filter, limit, scoreThreshold });
    return Array.isArray(out?.results) ? out.results : null;
  } catch (e) {
    _logRemoteOnce('warn', 'recall', orgId, e);
    throw isRemoteMemoryUnavailableError(e)
      ? e
      : new RemoteMemoryUnavailableError(orgId, '/v1/recall', e);
  }
}

export async function remoteWrite(orgId, record, vector, rels = [], options = {}) {
  try { await _call(orgId, '/v1/write', { record, vector, rels }, options); return true; }
  catch (e) { console.warn(`[mneme/remote] write failed org=${orgId}: ${e.message}`); return null; }
}

export async function remoteAddEdge(orgId, rel) {
  try { await _call(orgId, '/v1/edge', { rel }); return true; }
  catch (e) { console.warn(`[mneme/remote] edge failed org=${orgId}: ${e.message}`); return null; }
}

export async function remoteDeleteEdge(orgId, rel) {
  try { return await _call(orgId, '/v1/delete-edge', { rel }); }
  catch (e) { console.warn(`[mneme/remote] delete-edge failed org=${orgId}: ${e.message}`); return null; }
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

// Recall reinforcement — bump recall_count/strength/last_accessed for delivered ids.
export async function remoteBumpRecall(orgId, ids) {
  try { const out = await _call(orgId, '/v1/bump-recall', { ids }); return out?.bumped ?? 0; }
  catch (e) { console.warn(`[mneme/remote] bump-recall failed org=${orgId}: ${e.message}`); return null; }
}

// Hydrate full memory rows from the customer's Postgres (so recall content stays on their box).
export async function remoteHydrate(orgId, ids) {
  try { const out = await _call(orgId, '/v1/hydrate', { ids }); return out?.memories || []; }
  catch (e) { _logRemoteOnce('warn', 'hydrate', orgId, e); return []; }
}

// Filtered enumeration from the agent (listMemories for remote orgs). Returns { memories, cursor }.
export async function remoteList(orgId, filter, cursor, limit, offset = 0, options = {}) {
  try { const out = await _call(orgId, '/v1/list', { filter, cursor, limit, offset }, options); return { memories: out?.memories || [], cursor: out?.cursor || null }; }
  catch (e) {
    // NEVER TURN A FAILED READ INTO AN EMPTY ONE. This returned `{ memories: [] }` on any error, so a
    // transient shard-lock collision rendered a tenant's Memories page EMPTY — visually identical to
    // owning no memories, with only a console warning to tell them apart. That is the same defect
    // shape as a document logged `indexed` with zero memories, or `200 []` from a broken dependency:
    // the caller cannot distinguish "nothing here" from "I could not look".
    // Throw, so the route answers an error and the UI can say so. A caller that genuinely wants a
    // best-effort empty list must opt into that by catching this itself.
    _logRemoteOnce('error', 'list', orgId, e, ' — surfacing as an error, not an empty list');
    throw new Error(`memory list unavailable for this workspace: ${e.message}`);
  }
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

// Durable vector-sync observability for upgraded agents. Older agents return
// null, allowing callers/backfill scripts to fall back to /v1/list for memories.
export async function remoteVectorStatus(orgId, options = {}) {
  try { return await _call(orgId, '/v1/vector-status', {}, options); }
  catch (e) { console.warn(`[mneme/remote] vector-status unavailable org=${orgId}: ${e.message}`); return null; }
}

export async function remoteCapabilities(orgId, { maxAgeMs = 300_000, transportClass = 'interactive' } = {}) {
  const cached = _capabilityCache.get(orgId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const out = await _call(orgId, '/v1/capabilities', {}, { transportClass });
    const value = {
      protocol_version: out?.protocol_version || null,
      schema_version: out?.schema_version || null,
      agent_release: out?.agent_release || null,
      storage_mode: out?.storage_mode || null,
      vector_dimension: Number(out?.vector_dimension) || null,
      capabilities: Array.isArray(out?.capabilities) ? out.capabilities : [],
    };
    _capabilityCache.set(orgId, { value, expiresAt: Date.now() + maxAgeMs });
    return value;
  } catch (error) {
    // A 404 means a pre-capability agent. Cache that negotiated legacy mode so
    // every reconciliation cycle does not rediscover it through error logs.
    _capabilityCache.set(orgId, { value: null, expiresAt: Date.now() + maxAgeMs });
    console.warn(`[mneme/remote] capability handshake unavailable org=${orgId}: ${error.message}`);
    return null;
  }
}

export async function remoteVectorPending(orgId, { kind = 'memory', cursor = null, limit = 100, transportClass = 'interactive' } = {}) {
  try {
    const out = await _call(orgId, '/v1/vector-pending', { kind, cursor, limit }, { transportClass });
    return { items: Array.isArray(out?.items) ? out.items : [], cursor: out?.cursor || null };
  } catch (e) {
    console.warn(`[mneme/remote] vector-pending unavailable org=${orgId} kind=${kind}: ${e.message}`);
    return null;
  }
}

export async function remoteVectorRepair(orgId, { kind = 'memory', id, vector, transportClass = 'interactive' } = {}) {
  try {
    const out = await _call(orgId, '/v1/vector-repair', { kind, id, vector }, { transportClass });
    return out?.ok === true;
  } catch (e) {
    console.warn(`[mneme/remote] vector-repair failed org=${orgId} kind=${kind} id=${id}: ${e.message}`);
    return null;
  }
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
  // Retry transient aborts/timeouts. Under a 4-parallel batch the embed provider
  // saturates (measured: 29.8s embeds → the segment write to the agent exceeds
  // TIMEOUT_MS → "This operation was aborted") and the segment was dropped with
  // NO reconciler backstop — evidence silently missing. The agent upserts a
  // segment by its stable id, so a retry is idempotent (no duplicate rows).
  const attempts = Math.max(1, Number(process.env.KB_SEGMENT_WRITE_ATTEMPTS || 3));
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const out = await _call(orgId, '/v1/kb-segment', { segment, vector });
      if (out?.ok) return true;
      lastErr = new Error('agent returned ok=false');
    } catch (e) { lastErr = e; }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
  console.warn(`[mneme/remote] kb-segment failed org=${orgId} after ${attempts} attempts: ${lastErr?.message}`);
  return null;
}
export async function remoteKbRecall(orgId, vector, opts = {}) {
  // Return NULL on failure, [] on a genuine empty. Returning [] for both made a DEAD AGENT
  // indistinguishable from an empty knowledge base — the `200 []` defect shape. Callers must
  // be able to tell "nothing matched" from "the lane did not run".
  try { const out = await _call(orgId, '/v1/kb-recall', { vector, limit: opts.limit, documentId: opts.documentId, documentIds: opts.documentIds, scoreThreshold: opts.scoreThreshold, access: opts.access }); return out?.results || []; }
  catch (e) { console.warn(`[mneme/remote] kb-recall FAILED org=${orgId}: ${e.message} — vector evidence lane contributed nothing to this answer`); return null; }
}
export async function remoteKbLexical(orgId, text, opts = {}) {
  // NULL on failure, [] on a genuine empty — see remoteKbRecall. This one mattered in
  // practice: the running agent had no /v1/kb-lexical endpoint at all for 9 days, so every
  // call 404'd and was swallowed into [], leaving remote evidence recall silently
  // VECTOR-ONLY. Exact part numbers and codes are precisely what the lexical lane exists to
  // catch, so the degradation was invisible and total.
  //
  // `access` is an EXPLICIT named option here, matching remoteKbRecall's opts.access — not
  // nested inside `filter`. It used to be reachable only via filter.access, which happened to
  // match what the server read, but only because the one existing caller built it that way;
  // nothing in either signature said it had to. Sent at BOTH levels below (top-level access
  // AND still inside filter) so an as-yet-unupgraded BYOD box's server -- these run on customer
  // premises and do not redeploy the instant this ships -- keeps reading it out of filter.access
  // exactly as before, while an upgraded server can read the explicit top-level field.
  const { filter = {}, limit = 20, access } = opts;
  const wireFilter = access ? { ...filter, access } : filter;
  try {
    const out = await _call(orgId, '/v1/kb-lexical', { text, filter: wireFilter, limit, access });
    return out?.results || [];
  }
  catch (e) { console.warn(`[mneme/remote] kb-lexical FAILED org=${orgId}: ${e.message} — lexical evidence lane contributed nothing; exact-token matches are LOST for this query`); return null; }
}
export async function remoteKbHydrate(orgId, ids, access) {
  try { const out = await _call(orgId, '/v1/kb-hydrate', { ids, access }); return out?.segments || []; }
  catch (e) { console.warn(`[mneme/remote] kb-hydrate failed org=${orgId}: ${e.message}`); return []; }
}

// PROVENANCE for remote orgs. memory_evidence_links / memory_derivations are central tables
// hard-FK'd to hivemind.memories, so for an .amr org they can only live on the agent, next to the
// memories they describe. Null on failure (never []) so a caller can tell a dead lane from an
// empty one.
export async function remoteKbProvenance(orgId, payload = {}) {
  try { return await _call(orgId, '/v1/kb-provenance', payload); }
  catch (e) { console.warn(`[mneme/remote] kb-provenance FAILED org=${orgId}: ${e.message} — provenance for this document is LOST (memories still land)`); return null; }
}
export async function remoteKbTables(orgId, payload = {}) {
  try { return await _call(orgId, '/v1/kb-tables', payload); }
  catch (e) { console.warn(`[mneme/remote] kb-tables FAILED org=${orgId}: ${e.message} — spreadsheet grids for this document are NOT stored`); return null; }
}
export async function remoteMemoryEvidence(orgId, memoryId) {
  try { const out = await _call(orgId, '/v1/memory-evidence', { memory_id: memoryId }); return out?.evidenceLinks || []; }
  catch (e) { console.warn(`[mneme/remote] memory-evidence FAILED org=${orgId}: ${e.message}`); return null; }
}

// KB doc LIST for remote org — returns central-shaped { documents, pagination } or null on failure.
export async function remoteKbDocs(orgId, opts = {}) {
  try { return await _call(orgId, '/v1/kb-docs', { limit: opts.limit, offset: opts.offset, access: opts.access }); }
  catch (e) { console.warn(`[mneme/remote] kb-docs failed org=${orgId}: ${e.message}`); return null; }
}

// KB doc DELETE for remote org — the agent runs the FULL cascade (fact memories from the active
// store, segments + their vectors, the doc row). Accepts document_id or filename.
export async function remoteKbDocDelete(orgId, { documentId, filename } = {}) {
  try { return await _call(orgId, '/v1/kb-doc-delete', { document_id: documentId || null, filename: filename || null }); }
  catch (e) { console.warn(`[mneme/remote] kb-doc-delete failed org=${orgId}: ${e.message}`); return null; }
}

// KB doc DETAIL for remote org — returns { document, segments, promotedMemories, segmentCount, promotedCount } or null.
export async function remoteKbDocDetail(orgId, documentId, access) {
  try { const out = await _call(orgId, '/v1/kb-doc-detail', { documentId, access }); return out?.error ? null : out; }
  catch (e) { console.warn(`[mneme/remote] kb-doc-detail failed org=${orgId} id=${documentId}: ${e.message}`); return null; }
}

// Per-memory edge counts for remote org — returns { <id>: {in, out} } or {} on failure.
// Entity-hop0 TAG path: memory ids carrying any of `tags`, scanned in the shard.
export async function remoteFindByTags(orgId, tags, limit, isLatest) {
  const wanted = new Set((Array.isArray(tags) ? tags : []).map((tag) => String(tag || '').trim()).filter(Boolean));
  if (!wanted.size) return [];
  const cap = Math.max(1, Math.min(Number(limit) || 200, 2000));
  try {
    const out = await _call(orgId, '/v1/by-tags', { tags: [...wanted], limit: cap, is_latest: isLatest });
    return Array.isArray(out?.ids) ? out.ids : [];
  } catch (error) {
    // Boxes released before `/v1/by-tags` still expose `/v1/list`. Preserve
    // entity recall across that rolling-upgrade boundary without converting a
    // transport failure into an empty result: only an explicit capability 404
    // may use the bounded compatibility scan.
    if (!/agent \/v1\/by-tags → 404\b/.test(String(error?.message || ''))) {
      _logRemoteOnce('warn', 'by-tags', orgId, error);
      throw isRemoteMemoryUnavailableError(error)
        ? error
        : new RemoteMemoryUnavailableError(orgId, '/v1/by-tags', error);
    }
    const scanLimit = Math.min(2000, Math.max(500, cap * 20));
    const out = await _call(orgId, '/v1/list', {
      filter: { is_latest: isLatest !== false },
      cursor: null,
      limit: scanLimit,
      offset: 0,
    });
    const rows = Array.isArray(out?.memories) ? out.memories : [];
    return rows
      .filter((row) => (Array.isArray(row?.tags) ? row.tags : []).some((tag) => wanted.has(String(tag))))
      .map((row) => row?.id)
      .filter(Boolean)
      .slice(0, cap);
  }
}

export async function remoteMemEdges(orgId, ids) {
  try { return await _call(orgId, '/v1/mem-edges', { ids }); }
  catch (e) { console.warn(`[mneme/remote] mem-edges failed org=${orgId}: ${e.message}`); return {}; }
}

// Per-memory relationships for remote org — returns central-shaped relationship object or null.
export async function remoteMemRelationships(orgId, memoryId) {
  try {
    const out = await _coalescedGraphRead(orgId, '/v1/mem-relationships', { memoryId });
    return out?.error ? null : out;
  } catch (e) {
    _logRemoteOnce('warn', 'mem-relationships', orgId, e, ` id=${memoryId}`);
    return null;
  }
}

// Fetch relationship neighbourhoods for one bounded frontier in one transport
// request.  A recall graph walk previously made one remote request per memory;
// a dense or concurrent tenant could therefore fill its own transport queue.
// `null` means an older agent does not yet implement the batch route, allowing
// callers to retain a deliberately bounded compatibility fallback.
export async function remoteMemRelationshipsBatch(orgId, ids) {
  const memoryIds = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean))].slice(0, 25);
  if (!memoryIds.length) return {};
  try {
    const out = await _coalescedGraphRead(orgId, '/v1/mem-relationships-batch', { ids: memoryIds });
    return out?.relationships && typeof out.relationships === 'object' ? out.relationships : {};
  } catch (e) {
    const message = String(e?.message || '');
    if (/mem-relationships-batch.*(?:404|not found)|agent .*404/i.test(message)) return null;
    _logRemoteOnce('warn', 'mem-relationships-batch', orgId, message);
    return {};
  }
}

// GDPR erasure: purge the ENTIRE org's data on the agent (all rows + vectors + edges). Returns
// { ok, deleted } from the agent, or null on failure (account-delete records the failure but proceeds
// to sever the central link; the saga can be retried). Self-host: physical destruction of the box is
// the customer's responsibility per the DPA — this erases what the agent controls.
export async function remotePurge(orgId) {
  try { const out = await _call(orgId, '/v1/purge', {}); return out || { ok: true }; }
  catch (e) { console.warn(`[mneme/remote] purge failed org=${orgId}: ${e.message}`); return null; }
}

// Clear ONLY the memory layer on the agent (hard) — memories + edges + vectors.
// Leaves KB, meetings, TARA and all usage/billing intact. Returns { ok, deleted }
// or null on failure. Backs the dashboard "Clear all memories" action.
export async function remoteClearMemories(orgId) {
  try { const out = await _call(orgId, '/v1/clear-memories', {}); return out || { ok: true }; }
  catch (e) { console.warn(`[mneme/remote] clear-memories failed org=${orgId}: ${e.message}`); return null; }
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
  catch (e) { console.warn(`[mneme/remote] meeting-list failed org=${orgId}: ${e.message}`); return null; }
}

export async function remoteMeetingSegmentWrite(orgId, segment) {
  try { return await _call(orgId, '/v1/meeting-segment-write', { segment }); }
  catch (e) { console.warn(`[mneme/remote] meeting-segment-write failed org=${orgId}: ${e.message}`); return null; }
}

export async function remoteMeetingSegmentList(orgId, filter) {
  try { const out = await _call(orgId, '/v1/meeting-segment-list', { filter }); return out?.segments || []; }
  catch (e) { console.warn(`[mneme/remote] meeting-segment-list failed org=${orgId}: ${e.message}`); return null; }
}

export async function remoteMeetingSessionWrite(orgId, session) {
  try { return await _call(orgId, '/v1/meeting-session-write', { session }, { timeoutMs: MEETING_AUDIO_TIMEOUT_MS }); }
  catch (e) { console.warn(`[mneme/remote] meeting-session-write failed org=${orgId}: ${e.message}`); return null; }
}
export async function remoteMeetingSessionStatus(orgId, filter) {
  try { return await _call(orgId, '/v1/meeting-session-status', { filter }, { timeoutMs: MEETING_AUDIO_TIMEOUT_MS }); }
  catch (e) { console.warn(`[mneme/remote] meeting-session-status failed org=${orgId}: ${e.message}`); return null; }
}
export async function remoteMeetingSessionPending(orgId, limit = 5) {
  try { const out = await _call(orgId, '/v1/meeting-session-pending', { limit }, { timeoutMs: MEETING_AUDIO_TIMEOUT_MS, transportClass: 'maintenance' }); return out?.sessions || []; }
  catch (e) { console.warn(`[mneme/remote] meeting-session-pending failed org=${orgId}: ${e.message}`); return []; }
}
export async function remoteMeetingSessionClaim(orgId, filter) {
  try { return await _call(orgId, '/v1/meeting-session-claim', { filter }, { timeoutMs: MEETING_AUDIO_TIMEOUT_MS, transportClass: 'maintenance' }); }
  catch (e) { console.warn(`[mneme/remote] meeting-session-claim failed org=${orgId}: ${e.message}`); return null; }
}
export async function remoteMeetingSessionSettle(orgId, result) {
  try { return await _call(orgId, '/v1/meeting-session-settle', { result }, { timeoutMs: MEETING_AUDIO_TIMEOUT_MS, transportClass: 'maintenance' }); }
  catch (e) { console.warn(`[mneme/remote] meeting-session-settle failed org=${orgId}: ${e.message}`); return null; }
}

// The agent owns raw bytes; Core merely claims one bounded chunk into memory to
// run the shared Singulance transcription engine, then settles the tenant row.
const MEETING_AUDIO_TIMEOUT_MS = Number(process.env.MEETING_REMOTE_AUDIO_TIMEOUT_MS || 300_000);
export async function remoteMeetingAudioWrite(orgId, segment) {
  try { return await _call(orgId, '/v1/meeting-audio-write', { segment }, { timeoutMs: MEETING_AUDIO_TIMEOUT_MS }); }
  catch (e) { console.warn(`[mneme/remote] meeting-audio-write failed org=${orgId}: ${e.message}`); return null; }
}
export async function remoteMeetingAudioClaim(orgId, filter) {
  try { return await _call(orgId, '/v1/meeting-audio-claim', { filter }, { timeoutMs: MEETING_AUDIO_TIMEOUT_MS, transportClass: 'maintenance' }); }
  catch (e) { console.warn(`[mneme/remote] meeting-audio-claim failed org=${orgId}: ${e.message}`); return null; }
}
export async function remoteMeetingAudioSettle(orgId, result) {
  try { return await _call(orgId, '/v1/meeting-audio-settle', { result }, { timeoutMs: MEETING_AUDIO_TIMEOUT_MS, transportClass: 'maintenance' }); }
  catch (e) { console.warn(`[mneme/remote] meeting-audio-settle failed org=${orgId}: ${e.message}`); return null; }
}
export async function remoteMeetingAudioPending(orgId, limit = 10) {
  try { const out = await _call(orgId, '/v1/meeting-audio-pending', { limit }, { timeoutMs: MEETING_AUDIO_TIMEOUT_MS, transportClass: 'maintenance' }); return out?.segments || []; }
  catch (e) { console.warn(`[mneme/remote] meeting-audio-pending failed org=${orgId}: ${e.message}`); return []; }
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
