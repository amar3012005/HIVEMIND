// mneme (.amr) backend adapter — a per-org, flag-gated, dual-write shadow for the Qdrant vector
// layer. Qdrant stays the source of truth; for orgs in MNEME_ENABLED_ORGS, writes are ALSO
// mirrored here and reads are served from here (with a Qdrant fallback on any miss/error).
//
// Safety: every call is best-effort and never throws to the caller. A mneme failure degrades to
// Qdrant, never breaks a write or a recall. Inert when MNEME_ENABLED_ORGS is empty.

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
const require = createRequire(import.meta.url);
const { MnemeVectorStore } = require('./mneme/index.cjs');

const DATA_ROOT = process.env.MNEME_DATA_ROOT || '/app/data/mneme';
const DIM = Number(process.env.EMBEDDING_DIMENSION || 1024);
// Enabled orgs come from a bind-mounted file (toggle live, no container recreate) PLUS the
// MNEME_ENABLED_ORGS env as a fallback. The file is re-read on a short TTL so writing/clearing it
// flips the backend on/off within seconds — the safe kill switch.
const ENABLED_FILE = process.env.MNEME_ENABLED_FILE || path.join(DATA_ROOT, 'enabled-orgs');
const ENV_ENABLED = (process.env.MNEME_ENABLED_ORGS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

let _cache = { at: 0, set: new Set() };
function enabledSet() {
  const now = Date.now();
  if (now - _cache.at < 15000) return _cache.set;
  const set = new Set(ENV_ENABLED);
  try {
    for (const line of fs.readFileSync(ENABLED_FILE, 'utf8').split('\n')) {
      const v = line.trim();
      if (v && !v.startsWith('#')) set.add(v);
    }
  } catch (_) {
    /* no file -> env only */
  }
  _cache = { at: now, set };
  return set;
}

/** Is the mneme backend enabled for this org? (file + env, 15s TTL cache). */
export function mnemeOn(orgId) {
  return !!orgId && enabledSet().has(orgId);
}

let store = null;
function getStore() {
  if (!store) store = new MnemeVectorStore({ dataRoot: DATA_ROOT, dim: DIM });
  return store;
}

/**
 * Mirror one point into the org's `.amr` shard. Best-effort: returns true on success, false on any
 * failure (e.g. another replica holds the single-writer lock) — the caller's Qdrant write already
 * persisted the data, so a skipped mirror is safe.
 */
export async function mirrorStore(collection, point) {
  try {
    const vector = point.vector instanceof Float32Array ? point.vector : Float32Array.from(point.vector || []);
    if (!vector.length) return false;
    await getStore().upsert(collection, [{ id: point.id, vector, payload: point.payload || {} }]);
    return true;
  } catch (e) {
    console.warn(`[mneme] mirrorStore skipped (${collection}): ${e.message}`);
    return false;
  }
}

/**
 * Search the org's `.amr` shard. Returns Qdrant-shaped `[{id, score, payload}]`, or `null` to
 * signal the caller to fall back to Qdrant (error, or no shard yet). Post-filters `is_latest`
 * (the standard recall filter) the way Qdrant's filter would.
 */
export async function search(collection, vector, topK = 10, opts = {}) {
  const isLatest = opts.isLatest !== false;
  try {
    const q = vector instanceof Float32Array ? vector : Float32Array.from(vector);
    const hits = await getStore().search(collection, q, topK * 2); // overfetch for post-filter
    if (!hits || hits.length === 0) return null; // empty shard -> fall back to Qdrant
    let out = hits.map((h) => ({ id: h.id, score: h.score, payload: h.payload || {} }));
    if (isLatest) out = out.filter((h) => h.payload.is_latest !== false);
    return out.slice(0, topK);
  } catch (e) {
    console.warn(`[mneme] search error (${collection}): ${e.message}`);
    return null;
  }
}
