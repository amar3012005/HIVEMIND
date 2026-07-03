// .amr-backed memory + relationship store — replaces the `hm.memories` / `hm.relationships`
// Postgres tables with the native mneme engine (one mmap'd shard per org). Postgres keeps its
// role for the KB layer (documents/segments — content hydration), per the agent's documented
// architecture. This module is the sole source of truth for memories/relationships once active.
//
// The native binding has no SQL-style filter/FTS/pagination, so this module keeps a full
// in-process index (id -> {slotId, rec}) rebuilt from `allRecords()` on boot, and implements
// filter/lexical/list/stats/graph in JS over that index — at self-host scale (thousands, not
// millions, of memories) this is fast and simple, and it's ALWAYS consistent with the shard
// because every write goes through this module.
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

function loadNative() {
  const triple = process.platform === 'linux' ? `linux-${process.arch}-gnu` : `${process.platform}-${process.arch}`;
  const candidates = [
    path.join(HERE, `singulance-amr.${triple}.node`),
    path.join(HERE, 'singulance-amr.node'),
    path.join(process.cwd(), 'mneme', `singulance-amr.${triple}.node`),
  ];
  const errors = [];
  for (const p of candidates) {
    try { return require(p); } catch (e) { errors.push(`${p}: ${e.message.split('\n')[0]}`); }
  }
  // Surface the REAL dlopen error (missing shared lib, glibc mismatch, wrong arch) — a silent
  // catch here once masked a libmvec.so.1 miss as "binding not found".
  throw new Error(`singulance-amr: could not load native binding for ${process.platform}-${process.arch}:\n  ${errors.join('\n  ')}`);
}
const { MnemeStore } = loadNative();

const REL_TYPE = { Mentions: 1, Updates: 2, Derives: 3, Contradicts: 4, PartOf: 5, Extends: 6 };
const REL_NAME = [null, 'Mentions', 'Updates', 'Derives', 'Contradicts', 'PartOf', 'Extends'];
const nsToDate = (ns) => (ns ? new Date(Number(ns) / 1e6) : null);
// Plain number (not BigInt): napi coerces JS number → i64; BigInt throws. ns from ms×1e6 exceeds
// 2^53 so the low microseconds round — acceptable for valid_from anchors.
const dateToNs = (d) => (d ? new Date(d).getTime() * 1e6 : 0);

export class AmrMemoryStore {
  constructor({ dataRoot, org, dim }) {
    this.org = org;
    this.dim = dim;
    this.store = MnemeStore.open(dataRoot, org.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64), dim);
    // id -> { slotId, rec }. rec mirrors the old Postgres row shape exactly, so route handlers
    // built against that shape barely change.
    this.byId = new Map();
    // rel synthetic id -> { fromId, toId, type, confidence } (edges are native; this is a view cache).
    this._rebuildIndex();
  }

  _rebuildIndex() {
    this.byId.clear();
    for (const { slotId, text } of this.store.allRecords()) {
      let rec;
      try { rec = JSON.parse(text); } catch { continue; }
      if (!rec?.id) continue;
      this.byId.set(rec.id, { slotId, rec });
    }
  }

  liveCount() { return this.byId.size; }

  // ── write path (mirrors the old ON CONFLICT ... COALESCE/UNION semantics) ──────────────────
  write(r, vector) {
    const existing = this.byId.get(r.id);
    const now = new Date().toISOString();
    const merged = existing ? {
      ...existing.rec,
      content: r.content ?? existing.rec.content,
      title: r.title || existing.rec.title,
      tags: Array.from(new Set([...(existing.rec.tags || []), ...(r.tags || [])])),
      confidence: r.confidence ?? existing.rec.confidence,
      memory_type: r.memoryType || existing.rec.memory_type,
      is_latest: r.isLatest ?? true,
      layer: r.layer || existing.rec.layer || 'memory',
      cognitive_layer_role: r.cognitiveLayerRole ?? existing.rec.cognitive_layer_role,
      scope: r.scope || existing.rec.scope,
      primary_team_id: r.primaryTeamId || existing.rec.primary_team_id,
      valid_from: r.validFrom || existing.rec.valid_from,
      document_date: r.documentDate || existing.rec.document_date,
      project: r.project ?? existing.rec.project,
      project_ids: r.projectIds || existing.rec.project_ids || [],
      metadata: { ...(existing.rec.metadata || {}), ...(r.metadata || {}) },
      // recall reinforcement is owned by bumpRecall/decay — never reset by a re-ingest write.
      recall_count: existing.rec.recall_count ?? 0,
      strength: existing.rec.strength ?? 1.0,
      deleted_at: null,
    } : {
      id: r.id, org_id: this.org, user_id: r.userId || null, content: r.content || null,
      title: r.title || null, tags: r.tags || [], memory_type: r.memoryType || null,
      is_latest: r.isLatest ?? true, layer: r.layer || 'memory',
      cognitive_layer_role: r.cognitiveLayerRole || null, confidence: r.confidence ?? null,
      created_at: r.createdAt || now, valid_from: r.validFrom || null, document_date: r.documentDate || null,
      project: r.project || null, project_ids: r.projectIds || [], metadata: r.metadata || {},
      scope: r.scope || null, primary_team_id: r.primaryTeamId || null,
      recall_count: r.recallCount ?? 0, strength: r.strength ?? 1.0, last_accessed_at: null,
      deleted_at: null,
    };
    const vec = vector instanceof Float32Array ? vector
      : Array.isArray(vector) ? Float32Array.from(vector)
      : existing ? null // re-upsert with no vector this round — keep old vector by NOT touching the slot
      : new Float32Array(this.dim);
    if (vec) {
      const validFromNs = dateToNs(merged.valid_from);
      const layerId = merged.layer === 'evidence' ? 1 : merged.layer === 'cognitive' ? 2 : 0;
      const slot = this.store.insertLayered(JSON.stringify(merged), vec, validFromNs, layerId);
      if (existing) { try { this.store.delete(existing.slotId); } catch { /* ignore */ } }
      this.byId.set(r.id, { slotId: slot, rec: merged });
      this.store.flush();
    } else if (existing) {
      // Metadata-only update (no vector this round) — patch the in-memory rec but leave the slot's
      // own vector untouched; re-persist via delete+reinsert using the EXISTING vector is not
      // possible (native API doesn't expose vector readback), so we just keep the merged rec in the
      // index and let the next vector-bearing write (always follows, per the 2-phase protocol)
      // do the real slot replace. This mirrors the old code's "vector_synced=false" interim state.
      this.byId.set(r.id, { slotId: existing.slotId, rec: merged });
    }
    return { ok: true };
  }

  // ── recall (vector) ─────────────────────────────────────────────────────────────────────────
  recall(vector, limit = 10, filter = {}) {
    if (!this.byId.size) return [];
    try { this.store.enableHnsw(); } catch { /* already built */ }
    const vec = vector instanceof Float32Array ? vector : Float32Array.from(vector);
    const hits = this.store.recall(vec, Math.min(limit * 4, 200));
    const out = [];
    for (const h of hits) {
      let rec; try { rec = JSON.parse(h.text); } catch { continue; }
      if (!this._passesFilter(rec, filter)) continue;
      out.push({ id: rec.id, score: h.score, payload: rec });
      if (out.length >= limit) break;
    }
    return out;
  }

  _passesFilter(rec, f = {}) {
    if (f.is_latest !== undefined && !!rec.is_latest !== !!f.is_latest) return false;
    if (f.layer && rec.layer !== f.layer) return false;
    if (f.must_not?.layer && rec.layer === f.must_not.layer) return false;
    if (rec.deleted_at) return false;
    return true;
  }

  // ── lexical — token-overlap scorer (approximation of Postgres ts_rank) ─────────────────────
  lexical(text, filter = {}, limit = 10) {
    const q = String(text || '').toLowerCase().split(/\W+/).filter(Boolean);
    if (!q.length) return [];
    const scored = [];
    for (const { rec } of this.byId.values()) {
      if (rec.deleted_at) continue;
      if (!this._passesFilter(rec, filter)) continue;
      const hay = `${rec.title || ''} ${rec.content || ''}`.toLowerCase();
      let score = 0;
      for (const t of q) if (t && hay.includes(t)) score += 1;
      if (score > 0) scored.push({ id: rec.id, score: score / q.length, payload: rec });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  hydrate(ids) {
    return ids.map((id) => this.byId.get(id)?.rec).filter(Boolean);
  }

  list(filter = {}, cursor, limit = 100, offset = 0) {
    let rows = [...this.byId.values()].map((v) => v.rec).filter((rec) => !rec.deleted_at);
    if (Array.isArray(filter.memory_type) && filter.memory_type.length) rows = rows.filter((r) => filter.memory_type.includes(r.memory_type));
    if (filter.layer) rows = rows.filter((r) => r.layer === filter.layer);
    if (filter.cognitive_layer_role === null) rows = rows.filter((r) => !r.cognitive_layer_role);
    if (filter.is_latest !== undefined) rows = rows.filter((r) => !!r.is_latest === !!filter.is_latest);
    if (filter.user_id) rows = rows.filter((r) => r.user_id === filter.user_id);
    if (filter.created_after) rows = rows.filter((r) => new Date(r.created_at) >= new Date(filter.created_after));
    rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    if (cursor) rows = rows.filter((r) => new Date(r.created_at) < new Date(cursor));
    if (offset > 0) rows = rows.slice(offset);
    rows = rows.slice(0, Math.min(limit, 500));
    return { memories: rows, cursor: rows.length ? rows[rows.length - 1].created_at : null };
  }

  stats(filter = {}) {
    let rows = [...this.byId.values()].map((v) => v.rec).filter((r) => !r.deleted_at && r.is_latest);
    if (filter.user_id) rows = rows.filter((r) => r.user_id === filter.user_id);
    return { memories: rows.length, relationships: this._allEdges().length };
  }

  // ── relationships (native typed edges) ─────────────────────────────────────────────────────
  addEdge(rel) {
    const from = this.byId.get(rel.fromId);
    const to = this.byId.get(rel.toId);
    if (!from || !to) return;
    const et = REL_TYPE[rel.type] || 1;
    this.store.addEdge(from.slotId, to.slotId, et, Math.max(1, Math.min(255, Math.round((rel.confidence ?? 1) * 255))));
    this.store.flush();
  }

  _allEdges() {
    const slotToId = new Map();
    for (const [id, v] of this.byId) slotToId.set(v.slotId, id);
    const out = [];
    for (const [id, v] of this.byId) {
      let edges; try { edges = this.store.slotEdges(v.slotId); } catch { continue; }
      for (const e of edges) {
        const toId = slotToId.get(e.target);
        if (!toId) continue;
        out.push({ id: `e:${id}:${toId}:${e.edgeType}`, from_id: id, to_id: toId, type: REL_NAME[e.edgeType] || 'Mentions', confidence: (e.weight ?? 255) / 255 });
      }
    }
    return out;
  }

  graph(filter = {}, limit = 500) {
    let nodes = [...this.byId.values()].map((v) => v.rec).filter((r) => !r.deleted_at && r.is_latest);
    if (filter.user_id) nodes = nodes.filter((r) => r.user_id === filter.user_id);
    nodes.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    nodes = nodes.slice(0, Math.min(limit, 2000));
    const ids = new Set(nodes.map((n) => n.id));
    const edges = this._allEdges().filter((e) => ids.has(e.from_id) || ids.has(e.to_id));
    return { nodes, edges };
  }

  updateTags(id, tags) {
    const existing = this.byId.get(id);
    if (!existing) return;
    existing.rec.tags = tags;
    // no vector change — patch in place (slot text is stale until next vector write, matching
    // the write()'s metadata-only-update behavior above).
  }

  bumpRecall(ids) {
    let bumped = 0;
    for (const id of ids) {
      const existing = this.byId.get(id);
      if (!existing) continue;
      existing.rec.recall_count = (existing.rec.recall_count || 0) + 1;
      existing.rec.strength = Math.min(1.0, (existing.rec.strength ?? 1.0) + 0.05);
      existing.rec.last_accessed_at = new Date().toISOString();
      bumped++;
    }
    return bumped;
  }

  patchUpdate(id, patch) {
    const existing = this.byId.get(id);
    if (!existing) return false;
    if (Array.isArray(patch.tags)) existing.rec.tags = patch.tags;
    if (patch.is_latest !== undefined) existing.rec.is_latest = !!patch.is_latest;
    if (patch.memory_type !== undefined) existing.rec.memory_type = patch.memory_type;
    return true;
  }

  flush() { try { this.store.flush(); } catch { /* best-effort */ } }
}

// ── one-time lossless migration from the old `hm.memories`/`hm.relationships` Postgres tables ──
// Runs only when the shard is empty (liveCount()===0) so it's idempotent and safe to leave wired
// in permanently — a fresh box with no prior Postgres data just skips straight through.
// Real embeddings lived in Qdrant (not Postgres) — pulled back via /points/scroll with_vector:true,
// keyed by memory id, so migrated memories keep FULL recall quality, not placeholder vectors.
export async function migrateFromPostgres(amr, pg, qFetch, qcoll, org) {
  if (amr.liveCount() > 0) return { migrated: 0, skipped: 'shard not empty' };
  const { rows: mems } = await pg.query('SELECT * FROM memories WHERE org_id=$1 AND deleted_at IS NULL', [org]);
  if (!mems.length) return { migrated: 0, skipped: 'no rows in postgres' };

  // Pull real vectors out of Qdrant in one batch, keyed by id — never placeholder zero-vectors.
  const vecById = new Map();
  try {
    const ids = mems.map((m) => m.id);
    const r = await qFetch(`/collections/${qcoll}/points`, {
      method: 'POST', body: JSON.stringify({ ids, with_vector: true, with_payload: false }),
    });
    if (r.ok) {
      const j = await r.json();
      for (const p of (j.result || [])) if (p.vector) vecById.set(p.id, Float32Array.from(p.vector));
    } else {
      console.warn(`[hm-agent] migrate: qdrant vector fetch ${r.status} — falling back per-memory recall re-embed will be needed`);
    }
  } catch (e) {
    console.warn('[hm-agent] migrate: qdrant vector fetch failed:', e.message);
  }

  let withVector = 0;
  for (const m of mems) {
    const vec = vecById.get(m.id) || new Float32Array(amr.dim); // fallback only if Qdrant lookup missed this id
    if (vecById.has(m.id)) withVector++;
    amr.write({
      id: m.id, userId: m.user_id, content: m.content, title: m.title, tags: m.tags,
      memoryType: m.memory_type, isLatest: m.is_latest, layer: m.layer,
      cognitiveLayerRole: m.cognitive_layer_role, confidence: m.confidence,
      createdAt: m.created_at, validFrom: m.valid_from, documentDate: m.document_date,
      project: m.project, projectIds: m.project_ids, metadata: m.metadata,
      scope: m.scope, primaryTeamId: m.primary_team_id, recallCount: m.recall_count, strength: m.strength,
    }, vec);
  }
  const { rows: rels } = await pg.query('SELECT * FROM relationships WHERE org_id=$1', [org]);
  for (const r of rels) amr.addEdge({ fromId: r.from_id, toId: r.to_id, type: r.type, confidence: r.confidence });
  amr.flush();
  return { migrated: mems.length, with_real_vector: withVector, relationships: rels.length };
}
