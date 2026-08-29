// THE single seam between the app and the storage backend. Every backend-aware decision lives here
// and nowhere else — db/prisma.js, qdrant-client.js, server.js call only these exports. The whole
// app is written against the Prisma + VectorStore interfaces; this module swaps what's behind them
// per-org via ONE config value (MNEME_ORGS). Add a backend later = add a driver here, touch zero
// features. That's the "one flip, pipeline unchanged" contract.
//
//   MNEME_ORGS = ""            → every org on hybrid (Postgres + Qdrant). Zero overhead.
//   MNEME_ORGS = "<orgId>"     → that org on .amr, everyone else hybrid.
//   MNEME_ORGS = "a,b,c"       → those orgs on .amr.
//   MNEME_ORGS = "*"           → ALL orgs on .amr (only after migrating every org — guarded).
//
// Back-compat: MNEME_PRISMA_ORG (single org) is still honored.
import { makeMnemeAdapter } from './prisma-adapter.js';
import { makeMnemePrisma } from './prisma-proxy.js';
import { mnemeSearch as amrVectorSearch } from './mneme-recall.js';
import { remoteRecall, remoteWrite, remoteAddEdge, remoteUpdateTags, remoteUpdate, remoteDelete, remoteBumpRecall, remoteList, remoteStats, remoteGraph, remoteKbDoc, remoteKbSegment, remoteKbRecall, remoteKbLexical, remoteKbHydrate, remoteLexical, remoteHydrate, hasRemoteAgent, remoteAgentOrgIds, meetingAgentOrgIds, remoteMeetingWrite, remoteMeetingList, remoteMeetingGet, remoteMeetingDelete, remoteMeetingPatch, remoteMeetingSegmentWrite, remoteMeetingSegmentList, remoteMeetingAudioWrite, remoteMeetingAudioClaim, remoteMeetingAudioSettle, remoteMeetingAudioPending, remoteMeetingSessionWrite, remoteMeetingSessionStatus, remoteMeetingSessionPending, remoteMeetingSessionClaim, remoteMeetingSessionSettle, remoteTaraCall, remoteKbDocs, remoteKbEvidence, remoteKbDocDetail, remoteKbDocDelete, remoteMemEdges, remoteMemRelationships, remoteMemRelationshipsBatch, remoteFindByTags, remoteClearMemories, remotePurge, remoteKbProvenance, remoteMemoryEvidence, remoteKbTables } from './remote-backend.js';

// Durable outbox for remote org pushes (Phase 4). Lazy-imported so the module
// loads cleanly even when the outbox has not been initialised yet (e.g. in tests
// or in central-only deployments). Central/personal/managed paths never call it.
let _enqueuePush = null;
async function _getEnqueuePush() {
  if (_enqueuePush) return _enqueuePush;
  try {
    const mod = await import('../../memory/outbox.js'); // driver is at vector/mneme/ → outbox at src/memory/
    _enqueuePush = mod.enqueuePush;
  } catch (e) {
    // outbox module unavailable (e.g. test environment without Redis). Log once — a silent null here
    // means failed pushes are dropped instead of durably retried (the bug this path is meant to fix).
    console.warn('[driver] outbox module load failed — pushes will NOT be durable:', e?.message);
    _enqueuePush = null;
  }
  return _enqueuePush;
}

// A REMOTE (.amr-on-customer-box) org has an hm-agent HTTP endpoint that serves recall — decided PER
// ORG, so it coexists with central dual/sole orgs. Self-host-HYBRID orgs (customer PG+Qdrant, no
// agent) are NOT remote — core connects to their stores directly (per-org DATABASE_URL/QDRANT_URL).
// Cheap no-op unless a registry is configured (MNEME_AGENT_REGISTRY_FILE / MNEME_AGENT_URLS).
export function orgIsRemote(orgId) {
  return !!orgId && hasRemoteAgent(orgId); // hasRemoteAgent is cheap (throttled file check) when inert
}

// THE single routing seam. Every write + read chokepoint routes through this one predicate so the
// store is the only variable — swap PG+Qdrant↔.amr inside the agent with zero engine changes.
//   'agent'     → per-org data plane reached over HTTP (remote-backend): PG+Qdrant now, .amr later.
//   'amr-local' → legacy .amr-on-core (MNEME_ORGS); dormant in prod. amrRecall/amrWrite handle it.
//   'central'   → central Qdrant + Postgres (managed / personal / free). Unchanged.
export function memoryBackend(orgId) {
  if (orgIsRemote(orgId)) return 'agent';
  if (isMnemeOrg(orgId)) return 'amr-local';
  return 'central';
}

const SIDECAR_MODELS = [
  'sourceMetadata', 'memoryVersion', 'memoryProject', 'codeMemoryMetadata',
  'derivationJob', 'memoryDerivation', 'memoryEvidenceLink', 'vectorEmbedding',
  'entityMention', 'memoryEntityLink', 'knowledgeDocument', 'knowledgeSegment',
  // TENANT-DATA PLACEMENT, added 2026-08-03. document_tables/_rows hold the literal cell
  // contents of a tenant's spreadsheets. They were absent here AND from ROUTED_MODELS, so
  // for the 7 of 13 orgs on .amr those cells were written to CENTRAL Postgres — exactly
  // what a BYOD tenant chose .amr to avoid. SidecarBackend is generic ({dir}/_<name>.json),
  // so the store needs no change. NOTE: ROUTED_MODELS alone would have been a NO-OP —
  // prisma-proxy's wrapModel falls back to real Prisma when the adapter lacks the model,
  // so both lists must carry it or nothing routes.
  'documentTable', 'documentTableRow',
];

let _orgSet = null; // null until parsed; Set<orgId> or the sentinel '*'
function orgConfig() {
  if (_orgSet !== null) return _orgSet;
  const raw = (process.env.MNEME_ORGS || process.env.MNEME_PRISMA_ORG || '').trim();
  if (raw === '*') { _orgSet = '*'; return _orgSet; }
  _orgSet = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  return _orgSet;
}
export function isMnemeOrg(orgId) {
  if (!orgId) return false;
  const c = orgConfig();
  if (c === '*' || c.has(orgId)) return true;
  return orgIsRemote(orgId); // BYOD orgs (agent-registered) are .amr orgs too
}

// Forward-only fix (2026-08-25): orgConfig() only ever reads MNEME_ORGS once
// at first use, and nothing ever wrote a newly-promoted org's id back into
// it — promotion-service.js sets organizations.memory_storage_mode =
// 'amr_embedded' at redemption/grant time, but the routing gate never found
// out, so every such org silently ran on Postgres/hybrid instead of the
// .amr storage its own account profile declared. Found live: 8 real
// accounts already affected — deliberately NOT touched here (retroactively
// flipping them risks a recall gap, since their shard dual-write never ran
// during the time they were mis-routed, and product decided existing
// orgs/users are out of scope — see the comment in prisma.js's
// configureMnemeDriver()). A BRAND NEW org promoted to amr_embedded has no
// such risk — it has no memories yet, so registering it
// the moment it's promoted is safe and closes the gap for every org going
// forward. Call this from the same transaction/request that sets
// memoryStorageMode, not from a batch job.
export function registerMnemeOrg(orgId) {
  if (!orgId) return;
  const c = orgConfig();
  if (c === '*') return; // already covers everything
  if (c.has(orgId)) return;
  c.add(orgId);
  // eslint-disable-next-line no-console
  console.log(`[mneme] registered newly-promoted amr_embedded org=${orgId} for .amr routing (in-process, this instance)`);
}
export function anyMnemeOrg() {
  const c = orgConfig();
  return c === '*' || c.size > 0;
}

// ---- per-org .amr stores (lazy, one open shard per org) ---------------------
const _stores = new Map(); // orgId -> { adapter, store, storeMemoryUnified } | 'pending' | 'failed'
let _backend = null; // injected once: { openStore, MnemeMemoryBackend, MnemeRelationshipBackend, SidecarBackend }
let _realPrisma = null;

// Inject the native binding + backends + the real Prisma client once at boot. Without this the
// driver is inert and isMnemeOrg() still answers, but stores never open (hybrid for everyone).
export function configureDriver({ backend, realPrisma, dataRoot, dim }) {
  _backend = backend;
  _realPrisma = realPrisma;
  _dataRoot = dataRoot || '/app/data/mneme';
  _dim = Number(dim || process.env.EMBEDDING_DIMENSION || 1024);
}
let _dataRoot = '/app/data/mneme';
let _dim = 1024;

function openOrg(orgId) {
  if (!_backend || !_realPrisma) return null;
  const dir = `${_dataRoot}/org_${orgId}`;
  const store = _backend.openStore(_dataRoot, `org_${orgId}`, _dim);
  const memBackend = new _backend.MnemeMemoryBackend(store, _dim);
  const relBackend = new _backend.MnemeRelationshipBackend(store, memBackend);
  const memories = memBackend.loadAll();
  const relationships = relBackend.loadAll();
  const backends = { memory: memBackend, relationship: relBackend };
  const extra = {};
  let segments = [];
  for (const name of SIDECAR_MODELS) {
    const sb = new _backend.SidecarBackend(`${dir}/_${name}.json`);
    backends[name] = sb;
    if (name === 'knowledgeSegment') segments = sb.loadAll();
    else extra[name] = sb.loadAll();
  }
  const adapter = makeMnemeAdapter({ memories, relationships, segments, extra, backends });
  const storeMemoryUnified = async (record, vector, rels = []) => {
    await adapter.memory.upsert({
      where: { id: record.id },
      create: { ...record, _vector: Array.from(vector || []) },
      update: { ...record, _vector: Array.from(vector || []) },
    });
    for (const r of rels) await adapter.relationship.create({ data: r });
    return record.id;
  };
  // eslint-disable-next-line no-console
  console.log(`[mneme] driver: .amr store LIVE org=${orgId} {mem:${memories.length} rel:${relationships.length} seg:${segments.length}}`);
  return { adapter, store, storeMemoryUnified };
}

// returns the live store handle for an .amr org (lazy-open), or null if not ready / not an .amr org.
export function orgStore(orgId) {
  if (!isMnemeOrg(orgId) || orgIsRemote(orgId)) return null; // remote orgs have NO local .amr store
  const cur = _stores.get(orgId);
  if (cur && cur !== 'pending' && cur !== 'failed') return cur;
  if (cur === 'pending') return null;
  try {
    const handle = openOrg(orgId);
    if (!handle) { _stores.set(orgId, 'failed'); return null; }
    _stores.set(orgId, handle);
    return handle;
  } catch (e) {
    _stores.set(orgId, 'failed');
    // eslint-disable-next-line no-console
    console.warn(`[mneme] driver: open failed org=${orgId}, staying hybrid:`, e.message);
    return null;
  }
}

// Admission must fail closed for an org whose selected memory plane is not
// reachable. Callers use this before accepting durable work; it intentionally
// does not downgrade an .amr tenant to central Postgres.
export function isMemoryStorageReady(orgId, storageMode = 'hybrid') {
  if (storageMode === 'hybrid') return true;
  if (storageMode === 'byod_amr') return orgIsRemote(orgId);
  if (storageMode === 'amr_embedded') return orgIsRemote(orgId) || !!orgStore(orgId);
  return false;
}

// every live .amr-org adapter — used by FK-child routing (an op with no orgId routes to whichever
// adapter already holds the referenced memory/segment). For an explicit org list we open each; for
// '*' we only consider already-open shards (don't force-open every org on each call).
function allActiveAdapters() {
  const c = orgConfig();
  const out = [];
  if (c === '*') {
    for (const h of _stores.values()) if (h && h !== 'pending' && h !== 'failed') out.push(h.adapter);
  } else {
    for (const orgId of c) { const h = orgStore(orgId); if (h) out.push(h.adapter); }
  }
  return out;
}

// MNEME_MODE: 'dual' (default, PRODUCTION) keeps Postgres as the relational source of truth — every
// memory/relationship row still lands in PG so HyperAgents and all relational features work unchanged;
// .amr is an ADDITIVE vector+graph index (it replaces Qdrant, not Postgres). 'sole' is the residency/
// research mode where .amr is the ONLY store (PG=0) — used for BYOD where PG is the customer's box.
export function mnemeMode() {
  const m = (process.env.MNEME_MODE || 'dual').trim().toLowerCase();
  return m === 'sole' || m === 'remote' ? m : 'dual';
}

// ---- the seam the factories call -------------------------------------------
// wrap the real Prisma client. In 'sole' mode the proxy routes the .amr-org memory subgraph to the
// adapter (PG=0). In 'dual' mode (default) PG keeps every row — return the real client untouched; .amr
// is fed the vector via the qdrant-client write-hook and the graph via amrAddEdge.
export function wrapPrisma(realPrisma) {
  if (!anyMnemeOrg() || mnemeMode() === 'dual') return realPrisma; // PG keeps all rows
  return makeMnemePrisma(realPrisma, {
    isAmrOrg: isMnemeOrg,
    getAdapter: (orgId) => orgStore(orgId)?.adapter || null,
    getAllAdapters: allActiveAdapters,
  });
}

// Mirror a typed relationship edge into the .amr shard that holds its fromId memory (dual mode — PG
// already has the row; this keeps the .amr graph in sync for graph-recall). No-op if no .amr org.
// Resync entity:* tags into the .amr after deferred entity-linking attaches them (remote orgs).
//
// REMOTE ORGS: routes through the durable outbox instead of fire-and-forget.
// The caller does NOT need to await — the push is best-effort on the happy path
// and durably retried via BullMQ + the MemoryOutbox row if the agent is down.
export function amrUpdateTags(orgId, id, tags, { requireAck = false } = {}) {
  if (!orgId || !id || !Array.isArray(tags)) return;
  if (orgIsRemote(orgId)) {
    if (requireAck) {
      return remoteUpdateTags(orgId, id, tags).then(async (ok) => {
        if (ok) return true;
        const enqueue = await _getEnqueuePush().catch(() => null);
        if (enqueue) await enqueue(orgId, 'updateTags', id, { id, tags });
        return false;
      });
    }
    // Durable outbox: seq ensures updateTags lands after the corresponding write.
    _getEnqueuePush().then((enqueue) => {
      if (enqueue) return enqueue(orgId, 'updateTags', id, { id, tags });
      // Fallback to direct call if outbox unavailable (test / degraded mode).
      return remoteUpdateTags(orgId, id, tags);
    }).catch(() => {
      // Outbox INSERT failed — last-resort direct attempt.
      remoteUpdateTags(orgId, id, tags);
    });
    return;
  }
  if (!anyMnemeOrg()) return;
  for (const a of allActiveAdapters()) {
    try { if (a?.memory?.byId?.has(id)) a.memory.update?.({ where: { id }, data: { tags } }); } catch { /* best-effort */ }
  }
}

// Profile/Overview counts ({memories, relationships}) for a remote org — null for non-remote (caller
// uses its central count). Async.
export function amrStats(orgId, filter) {
  if (!orgIsRemote(orgId)) return null;
  return remoteStats(orgId, filter);
}
// Graph {nodes, edges} for a remote org — null for non-remote. Async.
export function amrGraph(orgId, opts) {
  if (!orgIsRemote(orgId)) return null;
  return remoteGraph(orgId, opts);
}

// Lexical (FTS) leg of hybrid recall for a REMOTE org — routes to the agent's /v1/lexical. Returns
// Qdrant-shaped hits [{id, score, payload}] (async). Null for non-remote (caller uses the local path).
export function amrLexicalRemote(orgId, text, filter, limit) {
  return orgIsRemote(orgId) ? remoteLexical(orgId, text, filter, limit) : null;
}

// KB layer (self-host): route document + evidence-segment writes/reads to the agent for remote orgs.
// All return null/[] for non-remote (caller uses the central path). Async.
export function amrKbDoc(orgId, doc) { return orgIsRemote(orgId) ? remoteKbDoc(orgId, doc) : null; }
export async function amrKbSegment(orgId, segment, vector) {
  if (!orgIsRemote(orgId)) return null;
  const ok = await remoteKbSegment(orgId, segment, vector);
  if (ok) return ok;
  // Evidence vectors need the same crash/retry guarantee as memories. The
  // original bounded request retry was lost after process restart.
  try {
    const enqueue = await _getEnqueuePush();
    if (enqueue) {
      await enqueue(orgId, 'kbSegment', segment.id, {
        segment,
        vector: Array.from(vector || []),
      });
    }
  } catch (enqErr) {
    console.error(`[amrKbSegment][outbox] enqueue failed org=${orgId} segment=${segment?.id}: ${enqErr.message}`);
  }
  return null;
}
export function amrKbRecall(orgId, vector, opts) { return orgIsRemote(orgId) ? remoteKbRecall(orgId, vector, opts) : null; }
export function amrKbLexicalRemote(orgId, text, opts) { return orgIsRemote(orgId) ? remoteKbLexical(orgId, text, opts) : null; }
export function amrKbHydrate(orgId, ids, access) { return orgIsRemote(orgId) ? remoteKbHydrate(orgId, ids, access) : null; }

// KB doc LIST for remote org — returns the central-shaped { documents, pagination } response from the
// agent's /v1/kb-docs route. null for non-remote (caller uses central Prisma). Async.
export function amrKbDocs(orgId, opts) { return orgIsRemote(orgId) ? remoteKbDocs(orgId, opts) : null; }
export function amrKbEvidence(orgId, opts) { return orgIsRemote(orgId) ? remoteKbEvidence(orgId, opts) : null; }

// KB doc DETAIL for remote org — returns { document, segments, promotedMemories, segmentCount, promotedCount }
// from the agent. null for non-remote (caller uses central Prisma). Async.
export function amrKbDocDetail(orgId, documentId, access) { return orgIsRemote(orgId) ? remoteKbDocDetail(orgId, documentId, access) : null; }

// KB doc DELETE (full cascade on the agent) for remote orgs. null for non-remote.
export function amrKbDocDelete(orgId, opts) { return orgIsRemote(orgId) ? remoteKbDocDelete(orgId, opts) : null; }
export function amrKbProvenance(orgId, payload) { return orgIsRemote(orgId) ? remoteKbProvenance(orgId, payload) : null; }
export function amrKbTables(orgId, payload) { return orgIsRemote(orgId) ? remoteKbTables(orgId, payload) : null; }
export function amrMemoryEvidence(orgId, memoryId) { return orgIsRemote(orgId) ? remoteMemoryEvidence(orgId, memoryId) : null; }

// Per-memory edge counts for remote org — returns { <id>: { in, out } } for a batch of memory ids.
// {} / null for non-remote (caller uses central Prisma). Async.
export function amrMemEdgeCounts(orgId, ids) { return orgIsRemote(orgId) ? remoteMemEdges(orgId, ids) : null; }

// Per-memory relationships for remote org — returns the central-shaped relationship object from the
// agent. null for non-remote (caller uses central Prisma). Async.
// Entity-hop0 TAG path (B7): memory ids carrying any `entity:<slug>` tag, from the shard.
// Returns [] for non-remote so the caller keeps the central query.
export function amrFindByTags(orgId, tags, limit = 200, isLatest = true) {
  return orgIsRemote(orgId) ? remoteFindByTags(orgId, tags, limit, isLatest) : null;
}
// Hydrate tenant-owned memory rows without forcing callers through a central
// Memory table. This is intentionally read-only and returns null for managed
// orgs so their existing Prisma path remains authoritative.
export function amrHydrateMemories(orgId, ids) {
  return orgIsRemote(orgId) ? remoteHydrate(orgId, ids) : null;
}
export function amrMemRelationships(orgId, memoryId) { return orgIsRemote(orgId) ? remoteMemRelationships(orgId, memoryId) : null; }
export function amrMemRelationshipsBatch(orgId, ids) { return orgIsRemote(orgId) ? remoteMemRelationshipsBatch(orgId, ids) : null; }

// Meetings layer (self-host): route meeting row writes/reads to the agent for remote orgs.
// All return null/[] for non-remote (caller uses the central path). Async.
export function amrMeetingWrite(orgId, meeting) { return orgIsRemote(orgId) ? remoteMeetingWrite(orgId, meeting) : null; }
export function amrMeetingList(orgId, filter) { return orgIsRemote(orgId) ? remoteMeetingList(orgId, filter) : null; }
export function amrMeetingGet(orgId, id) { return orgIsRemote(orgId) ? remoteMeetingGet(orgId, id) : null; }
export function amrMeetingDelete(orgId, id, hard) { return orgIsRemote(orgId) ? remoteMeetingDelete(orgId, id, hard) : null; }
export function amrMeetingPatch(orgId, id, fields) { return orgIsRemote(orgId) ? remoteMeetingPatch(orgId, id, fields) : null; }
export function amrMeetingSegmentWrite(orgId, segment) { return orgIsRemote(orgId) ? remoteMeetingSegmentWrite(orgId, segment) : null; }
export function amrMeetingSegmentList(orgId, filter) { return orgIsRemote(orgId) ? remoteMeetingSegmentList(orgId, filter) : null; }
export function amrMeetingAudioWrite(orgId, segment) { return orgIsRemote(orgId) ? remoteMeetingAudioWrite(orgId, segment) : null; }
export function amrMeetingAudioClaim(orgId, filter) { return orgIsRemote(orgId) ? remoteMeetingAudioClaim(orgId, filter) : null; }
export function amrMeetingAudioSettle(orgId, result) { return orgIsRemote(orgId) ? remoteMeetingAudioSettle(orgId, result) : null; }
export function amrMeetingAudioPending(orgId, limit) { return orgIsRemote(orgId) ? remoteMeetingAudioPending(orgId, limit) : null; }
export function amrMeetingSessionWrite(orgId, session) { return orgIsRemote(orgId) ? remoteMeetingSessionWrite(orgId, session) : null; }
export function amrMeetingSessionStatus(orgId, filter) { return orgIsRemote(orgId) ? remoteMeetingSessionStatus(orgId, filter) : null; }
export function amrMeetingSessionPending(orgId, limit) { return orgIsRemote(orgId) ? remoteMeetingSessionPending(orgId, limit) : null; }
export function amrMeetingSessionClaim(orgId, filter) { return orgIsRemote(orgId) ? remoteMeetingSessionClaim(orgId, filter) : null; }
export function amrMeetingSessionSettle(orgId, result) { return orgIsRemote(orgId) ? remoteMeetingSessionSettle(orgId, result) : null; }
export function amrRemoteOrgIds() { return remoteAgentOrgIds(); }
export function amrMeetingOrgIds() { return meetingAgentOrgIds(); }

// TARA call ledger (self-host): route call ledger ops to the agent for remote orgs.
// Returns null for non-remote (caller uses the central Prisma path). Async.
export function amrTaraCall(orgId, params) { return orgIsRemote(orgId) ? remoteTaraCall(orgId, params) : null; }

// Generic partial update (tags / is_latest / memory_type) routed to the agent for remote orgs.
// REMOTE ORGS: durable outbox (was a direct call, now ordered + retried).
export function amrUpdate(orgId, id, patch, { requireAck = false } = {}) {
  if (!orgId || !id || !patch) return undefined;
  if (orgIsRemote(orgId)) {
    if (requireAck) {
      return remoteUpdate(orgId, id, patch).then(async (ok) => {
        if (ok) return true;
        const enqueue = await _getEnqueuePush().catch(() => null);
        if (enqueue) await enqueue(orgId, 'update', id, { id, patch });
        return false;
      });
    }
    return _getEnqueuePush().then((enqueue) => {
      if (enqueue) return enqueue(orgId, 'update', id, { id, patch });
      return remoteUpdate(orgId, id, patch);
    }).catch(() => remoteUpdate(orgId, id, patch));
  }
  return undefined;
}

// Clear ALL memories for a remote org on its agent (memory layer only — leaves
// KB/meetings/usage). Central orgs → null (caller uses the central hard path).
export function amrClearMemories(orgId) { return orgIsRemote(orgId) ? remoteClearMemories(orgId) : null; }

// A self-hosted agent is the tenant's complete data plane. This intentionally
// removes its documents, evidence, memories, vectors, and graph, but never the
// shared broker/container that carries traffic for other tenants.
export function amrPurge(orgId) { return orgIsRemote(orgId) ? remotePurge(orgId) : null; }

// Delete a remote org's memory ON ITS AGENT (tombstone; hard=true purges the row). Direct call,
// not outboxed: callers need the definitive result and the agent-side delete is idempotent.
export function amrDelete(orgId, id, hard = false) {
  if (!orgId || !id) return undefined;
  if (orgIsRemote(orgId)) return remoteDelete(orgId, id, hard);
  return undefined;
}

// Recall reinforcement — bump recall_count/strength for delivered ids on the agent.
// Best-effort + fire-and-forget (matches central's prisma.updateMany().catch(()=>{}));
// recall feedback is lossy-tolerant, so no outbox (avoids bloat from frequent recalls).
export function amrBumpRecall(orgId, ids) {
  if (!orgId || !Array.isArray(ids) || ids.length === 0) return undefined;
  if (orgIsRemote(orgId)) { Promise.resolve(remoteBumpRecall(orgId, ids)).catch(() => {}); return true; }
  return undefined;
}

// REMOTE ORGS: was fire-and-forget (lost on agent-down). Now durable via outbox.
// Ordering: seq guarantees this edge op lands AFTER the write op for the same memory.
export async function amrAddEdge(rel) {
  if (process.env.MNEME_DEBUG_ROUTING === '1') console.log('[amrAddEdge] from', rel?.fromId?.slice?.(0,8), 'to', rel?.toId?.slice?.(0,8), 'org', rel?.orgId?.slice?.(0,8), 'remote', rel?.orgId ? orgIsRemote(rel.orgId) : 'no-org');
  if (!rel?.fromId || !rel?.toId) return;
  if (rel.orgId && orgIsRemote(rel.orgId)) {
    // Use fromId as the partition key so edge ops for a given memory are ordered
    // after its write op (which was enqueued with recordId=record.id=fromId).
    const recordId = rel.fromId;
    const enqueue = await _getEnqueuePush().catch(() => null);
    if (enqueue) return enqueue(rel.orgId, 'edge', recordId, { rel });
    return remoteAddEdge(rel.orgId, rel);
  }
  if (!anyMnemeOrg()) return;
  for (const a of allActiveAdapters()) {
    if (a?.memory?.byId?.has(rel.fromId)) {
      try {
        a.relationship.create({ data: { id: rel.id, fromId: rel.fromId, toId: rel.toId, type: rel.type, confidence: rel.confidence ?? 1 } });
      } catch { /* edge mirror best-effort; PG is source of truth */ }
      return true;
    }
  }
}

// vector recall for an .amr org from its shared open shard (or null → caller uses Qdrant).
export function amrRecall(orgId, vector, filter, limit, scoreThreshold) {
  if (orgIsRemote(orgId)) return remoteRecall(orgId, vector, filter, limit, scoreThreshold); // async
  const h = orgStore(orgId);
  if (!h) return null;
  return amrVectorSearch(h.store, vector, filter, limit, scoreThreshold);
}

// Recent-memory list for a remote (agent) org — the candidate pool the entity-co-mention linker
// pulls from. Central orgs query Postgres directly; remote orgs have NO central rows, so without
// this the linker always sees 0 candidates → never forms graph edges on self-host. Returns the
// agent's recent rows (mapped to {id,title,content,tags}); [] for non-remote or on any failure.
export async function amrListRecent(orgId, userId, limit = 15) {
  if (!orgIsRemote(orgId)) return [];
  // /v1/list takes a FLAT filter (not the Qdrant must/match shape recall uses). org_id is forced
  // agent-side from its own ORG env, so we only pass is_latest + optional user scoping.
  const filter = { is_latest: true };
  if (userId) filter.user_id = userId;
  const out = await remoteList(orgId, filter, null, limit);
  return (out?.memories || []).map((m) => ({
    id: m.memory_id || m.id,
    title: m.title || null,
    content: m.content || '',
    tags: Array.isArray(m.tags) ? m.tags : [],
    memory_type: m.memory_type || null,
    created_at: m.created_at || null,
    user_id: m.user_id || null,
  }));
}

// unified write (record + vector) for an .amr org (or null → caller uses Qdrant/PG path only).
//
// REMOTE ORGS — CRITICAL CONSTRAINT:
//   The ingest pipeline calls `await amrWrite(...)` and then immediately reads
//   the row back from the agent (getMemory → remoteHydrate) mid-ingest, so the
//   INITIAL write MUST remain a synchronous attempt (not fire-and-forget).
//
//   Strategy on success: the row landed — no outbox row needed (audit lives on agent).
//   Strategy on failure: the agent was down / timed-out.  We enqueue a durable
//     outbox row so the write is retried once the agent is back.  This converts
//     a silent data-loss into a retried push.
//
// Central / .amr-local orgs: unchanged.
export async function amrWrite(orgId, record, vector, rels = []) {
  if (orgIsRemote(orgId)) {
    // Synchronous attempt — required for the ingest read-back to succeed.
    const ok = await remoteWrite(orgId, record, vector, rels);
    if (ok) return ok; // happy path: landed, no outbox row needed
    // Write failed (agent down / timeout). Enqueue for durable retry.
    try {
      const enqueue = await _getEnqueuePush();
      if (enqueue) {
        await enqueue(orgId, 'write', record.id, { record, vector: Array.from(vector || []), rels });
      }
    } catch (enqErr) {
      // If outbox INSERT itself fails (e.g. central PG down) we cannot do much.
      // Log and return null — the caller will surface an error to the user.
      console.error(`[amrWrite][outbox] enqueue failed org=${orgId} record=${record?.id}: ${enqErr.message}`);
    }
    return null; // signal to caller that the synchronous write did not land
  }
  const h = orgStore(orgId);
  if (!h) return null;
  return h.storeMemoryUnified(record, vector, rels);
}

// ---- lexical (keyword) recall from .amr — replaces the Postgres FTS leg ------
// For an .amr org there is no Postgres to run to_tsvector against, so the hybrid recall's lexical
// leg must run here: a term-overlap scan over the org's records (content+title), with the same scope
// the SQL applied (org + is_latest + deleted + personal→user + project + date window). Returns rows
// in the SQL leg's shape, or null if not an .amr org (caller uses PG FTS).
function _lexFilter(rec, f) {
  if (rec.deletedAt) return false;
  if (f.org_id && rec.orgId !== f.org_id) return false;
  if (typeof f.is_latest === 'boolean' && (rec.isLatest !== false) !== f.is_latest) return false;
  if (f.scope === 'personal' && f.user_id && rec.userId !== f.user_id) return false;
  if (f.project && rec.project !== f.project) return false;
  if (f.created_after && new Date(rec.createdAt) < new Date(f.created_after)) return false;
  if (f.created_before && new Date(rec.createdAt) > new Date(f.created_before)) return false;
  const snapshot = f.valid_at || null;
  const createdAt = rec.createdAt || rec.created_at || null;
  const validFrom = rec.validFrom || rec.valid_from || rec.documentDate || rec.document_date || createdAt;
  const validTo = rec.validTo || rec.valid_to || null;
  if (f.known_at && (!createdAt || new Date(createdAt) > new Date(f.known_at))) return false;
  if (snapshot && validFrom && new Date(validFrom) > new Date(snapshot)) return false;
  if (snapshot && validTo && new Date(validTo) <= new Date(snapshot)) return false;
  return true;
}
function _toMemoryRow(rec, score) {
  return {
    id: rec.id, content: rec.content, title: rec.title || null, tags: rec.tags || [],
    memory_type: rec.memoryType || null, project: rec.project || null,
    importance_score: Number(rec.confidence ?? rec.importanceScore ?? 0.5),
    is_latest: rec.isLatest !== false,
    created_at: rec.createdAt || rec.created_at || null,
    updated_at: rec.updatedAt || rec.updated_at || rec.createdAt || rec.created_at || null,
    document_date: rec.documentDate || rec.document_date || null,
    valid_from: rec.validFrom || rec.valid_from || null,
    valid_to: rec.validTo || rec.valid_to || null,
    event_dates: rec.eventDates || [],
    source: rec.source || rec.sourcePlatform || null, visibility: rec.visibility || null,
    cognitive_layer_role: rec.cognitiveLayerRole || null, tier: rec.tier ?? null,
    fts_score: score,
  };
}
export function amrLexical(orgId, query, filter, limit) {
  const h = orgStore(orgId);
  if (!h) return null;
  const terms = String(query || '').toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z0-9]/g, '')).filter((w) => w.length > 1);
  if (!terms.length) return [];
  const out = [];
  for (const rec of h.adapter.memory.records) {
    if (!_lexFilter(rec, filter || {})) continue;
    const hay = `${rec.content || ''} ${rec.title || ''}`.toLowerCase();
    let hits = 0;
    for (const t of terms) if (hay.includes(t)) hits += 1; // prefix-ish term overlap (mirrors ':*')
    if (hits > 0) out.push(_toMemoryRow(rec, hits / terms.length));
  }
  out.sort((a, b) => b.fts_score - a.fts_score);
  return out.slice(0, limit || 10);
}

// ---- store-agnostic mutual exclusion — replaces Postgres advisory locks -----
// .amr has no Postgres to pg_advisory_xact_lock against. The shard is single-writer (flock) and we
// run one replica, but async read-then-write gaps still race; serialize per (org,key) in-process.
const _locks = new Map();
export async function withAmrLock(orgId, key, fn) {
  if (!isMnemeOrg(orgId)) return fn(); // hybrid org → caller keeps using PG advisory lock
  const k = `${orgId}:${key}`;
  const prev = _locks.get(k) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  _locks.set(k, prev.then(() => mine));
  await prev.catch(() => {});
  try { return await fn(); } finally { release(); if (_locks.get(k) === mine) _locks.delete(k); }
}

export const __test = { orgConfig, _reset: () => { _orgSet = null; _stores.clear(); } };
