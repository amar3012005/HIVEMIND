// mneme (.amr) per-org shadow backend — flag-gated, default OFF. Qdrant stays the source of
// truth; for orgs in the enable list, writes are mirrored here (upsert-by-id replace + delete),
// and reads are served from here with a Qdrant fallback. Every call is best-effort and never
// throws to the caller. Inert when the enable list is empty.
//
// Parity with Qdrant: upsert REPLACES by memory id (no duplicate slots), deletes are mirrored,
// and recall applies the same score threshold + is_latest filter. An id->slot map per shard
// (persisted to idmap.json) gives the replace/delete semantics the append-only engine lacks.

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
const require = createRequire(import.meta.url);
const { MnemeStore, sanitizeOrg } = require('./mneme/index.cjs');

// HIVEMIND layer → .amr slot layer id (matches mseg_format::LAYER_*): memory=0, evidence=1, cognitive=2.
const LAYER_ID = { memory: 0, evidence: 1, cognitive: 2 };

const DATA_ROOT = process.env.MNEME_DATA_ROOT || '/app/data/mneme';
const DIM = Number(process.env.EMBEDDING_DIMENSION || 1024);
const ENABLED_FILE = process.env.MNEME_ENABLED_FILE || path.join(DATA_ROOT, 'enabled-orgs');
const ENV_ENABLED = (process.env.MNEME_ENABLED_ORGS || '').split(',').map((s) => s.trim()).filter(Boolean);

// ---- enable flag (file + env, 15s TTL) -------------------------------------
let _flag = { at: 0, set: new Set() };
function enabledSet() {
  const now = Date.now();
  if (now - _flag.at < 15000) return _flag.set;
  const set = new Set(ENV_ENABLED);
  try {
    for (const line of fs.readFileSync(ENABLED_FILE, 'utf8').split('\n')) {
      const v = line.trim();
      if (v && !v.startsWith('#')) set.add(v);
    }
  } catch (_) {}
  _flag = { at: now, set };
  return set;
}
export function mnemeOn(orgId) {
  return !!orgId && enabledSet().has(orgId);
}

// ---- per-collection store + id->slot map -----------------------------------
const ctxs = new Map(); // collection -> { store, idMap, built, dir, dirty, timer }

function shardDir(coll) {
  return path.join(DATA_ROOT, sanitizeOrg(coll));
}
function loadIdMap(dir) {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(path.join(dir, 'idmap.json'), 'utf8'))));
  } catch (_) {
    return new Map();
  }
}
function getCtx(coll) {
  let c = ctxs.get(coll);
  if (!c) {
    const dir = shardDir(coll);
    c = { store: MnemeStore.open(DATA_ROOT, sanitizeOrg(coll), DIM), idMap: loadIdMap(dir), built: false, dir, dirty: false, timer: null };
    ctxs.set(coll, c);
  }
  return c;
}
function persist(c) {
  // debounced write of the id->slot map (coalesce bursts during ingestion).
  c.dirty = true;
  if (c.timer) return;
  c.timer = setTimeout(() => {
    c.timer = null;
    if (!c.dirty) return;
    c.dirty = false;
    try {
      fs.writeFileSync(path.join(c.dir, 'idmap.json'), JSON.stringify(Object.fromEntries(c.idMap)));
    } catch (e) {
      console.warn(`[mneme] idmap persist failed (${c.dir}): ${e.message}`);
    }
  }, 2000);
  if (c.timer.unref) c.timer.unref();
}

// ---- write: upsert-by-id (replace) -----------------------------------------
export async function mirrorStore(collection, point) {
  try {
    const vector = point.vector instanceof Float32Array ? point.vector : Float32Array.from(point.vector || []);
    if (!vector.length) return false;
    const c = getCtx(collection);
    const id = String(point.id);
    if (c.idMap.has(id)) {
      // replace: tombstone the old slot so recall never returns a stale duplicate
      try { c.store.delete(Number(c.idMap.get(id))); } catch (_) {}
    }
    const validFrom = Number(point.payload?.event_time_ns || 0) || 0;
    const layer = LAYER_ID[point.payload?.layer] ?? 0; // 0=memory default, 1=evidence, 2=cognitive
    const body = JSON.stringify({ id, payload: point.payload || {} });
    // insertLayered tags the slot's layer so .amr holds all 3 layers, queried separately (like
    // Qdrant). Falls back to insert on an older binary that lacks the method.
    const slot = typeof c.store.insertLayered === 'function'
      ? c.store.insertLayered(body, vector, validFrom, layer)
      : c.store.insert(body, vector, validFrom);
    c.idMap.set(id, slot);
    persist(c);
    return true;
  } catch (e) {
    console.warn(`[mneme] mirrorStore skipped (${collection}): ${e.message}`);
    return false;
  }
}

// ---- A#2: in-process incremental edge-mirror -------------------------------
const REL_TYPE = { Mentions: 1, Updates: 2, Derives: 3, Contradicts: 4, PartOf: 5, Extends: 6 };

// Pull relationships created since the last watermark for each enabled org and add them to its .amr
// typed-edge graph — so the graph compounds live as the LLM links memories (not a stale backfill).
// Runs IN-PROCESS on the core's already-open store (no flock conflict) using the core's prisma.
// Best-effort; flag-gated (no-op when no org is enabled); never throws into the caller.
export async function syncEnabledOrgEdges(prisma) {
  if (!prisma?.relationship?.findMany) return;
  for (const org of enabledSet()) {
    try {
      const coll = `org_${org}`;
      const c = getCtx(coll);
      const wmFile = path.join(c.dir, 'edgesync.json');
      let watermark = c.edgeWatermark;
      if (watermark == null) {
        try { watermark = new Date(JSON.parse(fs.readFileSync(wmFile, 'utf8')).lastCreatedAt); } catch (_) { watermark = new Date(0); }
      }
      const rels = await prisma.relationship.findMany({
        where: { fromMemory: { orgId: org }, createdAt: { gt: watermark } },
        select: { fromId: true, toId: true, type: true, confidence: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
        take: 5000,
      });
      if (!rels.length) continue;
      let added = 0;
      let max = watermark;
      for (const r of rels) {
        if (r.createdAt > max) max = r.createdAt;
        const fromSlot = c.idMap.get(String(r.fromId));
        const toSlot = c.idMap.get(String(r.toId));
        const et = REL_TYPE[r.type];
        if (fromSlot == null || toSlot == null || !et) continue;
        const w = Math.max(1, Math.min(255, Math.round((r.confidence ?? 1) * 255)));
        c.store.addEdge(Number(fromSlot), Number(toSlot), et, w);
        added++;
      }
      c.store.flush();
      c.edgeWatermark = max;
      try { fs.writeFileSync(wmFile, JSON.stringify({ lastCreatedAt: new Date(max).toISOString() })); } catch (_) {}
      if (added) console.log(`[mneme] edge-sync ${coll}: +${added} edges (watermark ${new Date(max).toISOString()})`);
    } catch (e) {
      console.warn(`[mneme] edge-sync ${org} skipped: ${e.message}`);
    }
  }
}

// ---- delete: mirror across enabled shards (delete is by memory id, no org) --
export async function mirrorDelete(memoryId) {
  const id = String(memoryId);
  let removed = false;
  for (const orgId of enabledSet()) {
    const coll = `org_${orgId}`;
    try {
      const c = getCtx(coll);
      if (c.idMap.has(id)) {
        try { c.store.delete(Number(c.idMap.get(id))); } catch (_) {}
        c.idMap.delete(id);
        persist(c);
        removed = true;
      }
    } catch (_) {}
  }
  return removed;
}

// ---- read: Qdrant-shaped, score + is_latest filtered, null -> fallback ------
export async function search(collection, vector, topK = 10, opts = {}) {
  const isLatest = opts.isLatest !== false;
  const minScore = typeof opts.scoreThreshold === 'number' ? opts.scoreThreshold : 0;
  try {
    const c = getCtx(collection);
    if (!c.built) { try { c.store.enableHnsw(); } catch (_) {} c.built = true; }
    const q = vector instanceof Float32Array ? vector : Float32Array.from(vector);
    const hits = c.store.recall(q, topK * 3); // overfetch for the post-filters
    if (!hits || hits.length === 0) return null;
    const out = [];
    for (const h of hits) {
      if (h.score < minScore) continue;
      let rec;
      try { rec = JSON.parse(h.text); } catch (_) { rec = { id: h.slotId, payload: {} }; }
      if (isLatest && rec.payload && rec.payload.is_latest === false) continue;
      out.push({ id: rec.id, score: h.score, payload: rec.payload || {} });
      if (out.length >= topK) break;
    }
    return out.length ? out : null;
  } catch (e) {
    console.warn(`[mneme] search error (${collection}): ${e.message}`);
    return null;
  }
}
