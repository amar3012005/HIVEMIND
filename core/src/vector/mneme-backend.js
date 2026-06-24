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
    const slot = c.store.insert(JSON.stringify({ id, payload: point.payload || {} }), vector, validFrom);
    c.idMap.set(id, slot);
    persist(c);
    return true;
  } catch (e) {
    console.warn(`[mneme] mirrorStore skipped (${collection}): ${e.message}`);
    return false;
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
