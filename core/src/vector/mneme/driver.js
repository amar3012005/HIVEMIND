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
  return c === '*' ? true : c.has(orgId);
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
  if (!isMnemeOrg(orgId)) return null;
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

// ---- the seam the factories call -------------------------------------------
// wrap the real Prisma client so .amr-org memory traffic routes to that org's adapter, per-call.
export function wrapPrisma(realPrisma) {
  if (!anyMnemeOrg()) return realPrisma; // no .amr org → untouched, zero overhead
  return makeMnemePrisma(realPrisma, {
    isAmrOrg: isMnemeOrg,
    getAdapter: (orgId) => orgStore(orgId)?.adapter || null,
    getAllAdapters: allActiveAdapters,
  });
}

// vector recall for an .amr org from its shared open shard (or null → caller uses Qdrant).
export function amrRecall(orgId, vector, filter, limit, scoreThreshold) {
  const h = orgStore(orgId);
  if (!h) return null;
  return amrVectorSearch(h.store, vector, filter, limit, scoreThreshold);
}

// unified write (record + vector) for an .amr org (or null → caller uses Qdrant/PG path only).
export async function amrWrite(orgId, record, vector, rels = []) {
  const h = orgStore(orgId);
  if (!h) return null;
  return h.storeMemoryUnified(record, vector, rels);
}

export const __test = { orgConfig, _reset: () => { _orgSet = null; _stores.clear(); } };
