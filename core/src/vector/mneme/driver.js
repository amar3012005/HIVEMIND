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
import { remoteRecall, remoteWrite, remoteAddEdge, remoteUpdateTags, hasRemoteAgent } from './remote-backend.js';

// A REMOTE (.amr-on-customer-box) org has an hm-agent HTTP endpoint that serves recall — decided PER
// ORG, so it coexists with central dual/sole orgs. Self-host-HYBRID orgs (customer PG+Qdrant, no
// agent) are NOT remote — core connects to their stores directly (per-org DATABASE_URL/QDRANT_URL).
// Cheap no-op unless a registry is configured (MNEME_AGENT_REGISTRY_FILE / MNEME_AGENT_URLS).
export function orgIsRemote(orgId) {
  return !!orgId && hasRemoteAgent(orgId); // hasRemoteAgent is cheap (throttled file check) when inert
}

const SIDECAR_MODELS = [
  'sourceMetadata', 'memoryVersion', 'memoryProject', 'codeMemoryMetadata',
  'derivationJob', 'memoryDerivation', 'memoryEvidenceLink', 'vectorEmbedding',
  'entityMention', 'memoryEntityLink', 'knowledgeDocument', 'knowledgeSegment',
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
export function amrUpdateTags(orgId, id, tags) {
  if (!orgId || !id || !Array.isArray(tags)) return;
  if (orgIsRemote(orgId)) { remoteUpdateTags(orgId, id, tags); return; }
  if (!anyMnemeOrg()) return;
  for (const a of allActiveAdapters()) {
    try { if (a?.memory?.byId?.has(id)) a.memory.update?.({ where: { id }, data: { tags } }); } catch { /* best-effort */ }
  }
}
export function amrAddEdge(rel) {
  if (process.env.MNEME_DEBUG_ROUTING) console.log('[amrAddEdge] from', rel?.fromId?.slice?.(0,8), 'to', rel?.toId?.slice?.(0,8), 'org', rel?.orgId?.slice?.(0,8), 'remote', rel?.orgId ? orgIsRemote(rel.orgId) : 'no-org');
  if (!rel?.fromId || !rel?.toId) return;
  if (rel.orgId && orgIsRemote(rel.orgId)) { remoteAddEdge(rel.orgId, rel); return; }
  if (!anyMnemeOrg()) return;
  for (const a of allActiveAdapters()) {
    if (a?.memory?.byId?.has(rel.fromId)) {
      try {
        a.relationship.create({ data: { id: rel.id, fromId: rel.fromId, toId: rel.toId, type: rel.type, confidence: rel.confidence ?? 1 } });
      } catch { /* edge mirror best-effort; PG is source of truth */ }
      return;
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

// unified write (record + vector) for an .amr org (or null → caller uses Qdrant/PG path only).
export async function amrWrite(orgId, record, vector, rels = []) {
  if (orgIsRemote(orgId)) return remoteWrite(orgId, record, vector, rels);
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
  return true;
}
function _toMemoryRow(rec, score) {
  return {
    id: rec.id, content: rec.content, title: rec.title || null, tags: rec.tags || [],
    memory_type: rec.memoryType || null, project: rec.project || null,
    importance_score: Number(rec.confidence ?? rec.importanceScore ?? 0.5),
    is_latest: rec.isLatest !== false,
    created_at: rec.createdAt, updated_at: rec.updatedAt || rec.createdAt,
    document_date: rec.documentDate || null, event_dates: rec.eventDates || [],
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
