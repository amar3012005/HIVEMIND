// .amr-backed memory + relationship store — v2, STREAMING. Replaces the `hm.memories` /
// `hm.relationships` Postgres tables with the native mneme engine (one mmap'd shard per org).
// Postgres keeps its role for the KB layer (documents/segments — content hydration).
//
// v1 held EVERY record parsed in a JS Map (`byId`) — ~1-2KB per record of V8 heap, an OOM wall
// around ~1M memories. v2 keeps NOTHING resident: the id→slot index lives in Rust (~24B/record,
// built by an mmap scan at open), point reads go through native findById/slotText, and scans
// stream through native recordsPage with bounded JS working sets. Metadata-only mutations
// (recall reinforcement, tag resync, is_latest supersession) persist via native rewriteText —
// the patches.jsonl sidecar is gone (existing patch files are replayed once, then removed).
import { createRequire } from 'module';
import fs from 'fs';
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
const PAGE = 2000; // records per native scan page — bounds the JS working set
const DONE = 0xFFFFFFFF; // recordsPage sentinel
// Plain number (not BigInt): napi coerces JS number → i64; BigInt throws. ns from ms×1e6 exceeds
// 2^53 so the low microseconds round — acceptable for valid_from anchors.
const dateToNs = (d) => (d ? new Date(d).getTime() * 1e6 : 0);

export class AmrMemoryStore {
  constructor({ dataRoot, org, dim }) {
    this.org = org;
    this.dim = dim;
    const orgDir = org.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    this.store = MnemeStore.open(dataRoot, orgDir, dim);
    // Reverse-edge index (targetSlot -> Set<fromSlot>): the native engine stores OUT-edges per
    // slot; in-edge queries (mem-relationships, graph) need the reverse. Built lazily by one
    // streaming scan, then maintained incrementally on addEdge/remove. ~ints only, no records.
    this._revEdges = null;
    // Cached edge total for stats (recomputed with the reverse index).
    this._edgeCount = null;
    // One-time migration of the v1 patches.jsonl sidecar into slot texts via rewriteText.
    this._migratePatchLog(path.join(dataRoot, orgDir, 'patches.jsonl'));
  }

  _migratePatchLog(patchFile) {
    let lines = [];
    try { lines = fs.readFileSync(patchFile, 'utf8').split('\n').filter(Boolean); } catch { return; }
    let applied = 0;
    for (const line of lines) {
      let p; try { p = JSON.parse(line); } catch { continue; }
      if (!p?.id) continue;
      const slot = this.store.findById(p.id);
      if (slot < 0) continue;
      try {
        const rec = JSON.parse(this.store.slotText(slot));
        const { id, ...fields } = p;
        Object.assign(rec, fields);
        this.store.rewriteText(slot, JSON.stringify(rec));
        applied++;
      } catch { /* skip unparseable slots */ }
    }
    try { this.store.flush(); fs.unlinkSync(patchFile); } catch { /* best-effort */ }
    if (applied) console.log(`[amr] migrated ${applied} patch-log entries into slot texts (patches.jsonl removed)`);
  }

  liveCount() { return this.store.liveCount(); }

  // ── point reads ─────────────────────────────────────────────────────────────────────────────
  _recAt(slot) {
    try { return JSON.parse(this.store.slotText(slot)); } catch { return null; }
  }

  _recById(id) {
    const slot = this.store.findById(id);
    if (slot < 0) return null;
    const rec = this._recAt(slot);
    return rec ? { slot, rec } : null;
  }

  // ── streaming scan: yields parsed records page by page (bounded JS heap) ────────────────────
  *_scan() {
    let from = 0;
    for (;;) {
      const { rows, nextSlot } = this.store.recordsPage(from, PAGE);
      for (const { slotId, text } of rows) {
        let rec; try { rec = JSON.parse(text); } catch { continue; }
        if (rec?.id) yield { slot: slotId, rec };
      }
      if (nextSlot === DONE) return;
      from = nextSlot;
    }
  }

  // ── write path (mirrors the old ON CONFLICT ... COALESCE/UNION semantics) ──────────────────
  write(r, vector) {
    const found = this._recById(r.id);
    const now = new Date().toISOString();
    const merged = found ? {
      ...found.rec,
      content: r.content ?? found.rec.content,
      title: r.title || found.rec.title,
      tags: Array.from(new Set([...(found.rec.tags || []), ...(r.tags || [])])),
      confidence: r.confidence ?? found.rec.confidence,
      memory_type: r.memoryType || found.rec.memory_type,
      is_latest: r.isLatest ?? true,
      layer: r.layer || found.rec.layer || 'memory',
      cognitive_layer_role: r.cognitiveLayerRole ?? found.rec.cognitive_layer_role,
      scope: r.scope || found.rec.scope,
      primary_team_id: r.primaryTeamId || found.rec.primary_team_id,
      valid_from: r.validFrom || found.rec.valid_from,
      document_date: r.documentDate || found.rec.document_date,
      project: r.project ?? found.rec.project,
      project_ids: r.projectIds || found.rec.project_ids || [],
      metadata: { ...(found.rec.metadata || {}), ...(r.metadata || {}) },
      // recall reinforcement is owned by bumpRecall — never reset by a re-ingest write.
      recall_count: found.rec.recall_count ?? 0,
      strength: found.rec.strength ?? 1.0,
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
    const hasVec = vector instanceof Float32Array || Array.isArray(vector);
    if (hasVec) {
      const vec = vector instanceof Float32Array ? vector : Float32Array.from(vector);
      const layerId = merged.layer === 'evidence' ? 1 : merged.layer === 'cognitive' ? 2 : 0;
      this.store.insertLayered(JSON.stringify(merged), vec, dateToNs(merged.valid_from), layerId);
      if (found) { try { this.store.delete(found.slot); } catch { /* ignore */ } this._revDropSlot(found.slot); }
      this.store.flush();
    } else if (found) {
      // Metadata-only update — durable via native rewriteText (vector untouched).
      this.store.rewriteText(found.slot, JSON.stringify(merged));
      this.store.flush();
    } else {
      // New record with no vector yet (phase 1 of the 2-phase write) — zero vector placeholder;
      // the vector-bearing phase replaces the slot.
      const layerId = merged.layer === 'evidence' ? 1 : merged.layer === 'cognitive' ? 2 : 0;
      this.store.insertLayered(JSON.stringify(merged), new Float32Array(this.dim), dateToNs(merged.valid_from), layerId);
      this.store.flush();
    }
    return { ok: true };
  }

  // ── recall (vector) ─────────────────────────────────────────────────────────────────────────
  recall(vector, limit = 10, filter = {}) {
    if (!this.store.liveCount()) return [];
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

  // One Qdrant match clause ({value} / {any:[]} / {except:[]}) vs a scalar-or-array field.
  static _matchCond(val, match) {
    if (!match) return true;
    const hit = (x) => (Array.isArray(val) ? val.includes(x) : val === x);
    if ('value' in match) return hit(match.value);
    if ('any' in match) return Array.isArray(match.any) && match.any.some(hit);
    if ('except' in match) return Array.isArray(match.except) && !match.except.some(hit);
    return true;
  }

  // The engine's recall sends the FULL Qdrant-shaped filter ({must:[{key,match}],must_not:[...]})
  // — org_id, user_id, project, project_ids, layer, tags, is_latest, promoted-exclusion. The
  // simple {is_latest, layer, must_not:{layer}} shape (internal callers) is still honored.
  _passesFilter(rec, f = {}) {
    if (rec.deleted_at) return false;
    if (Array.isArray(f.must) || Array.isArray(f.must_not)) {
      for (const c of f.must || []) if (!AmrMemoryStore._matchCond(rec[c.key], c.match)) return false;
      for (const c of f.must_not || []) if (AmrMemoryStore._matchCond(rec[c.key], c.match)) return false;
      return true;
    }
    if (f.is_latest !== undefined && !!rec.is_latest !== !!f.is_latest) return false;
    if (f.layer && rec.layer !== f.layer) return false;
    if (f.must_not?.layer && rec.layer === f.must_not.layer) return false;
    return true;
  }

  // ── lexical — streaming token-overlap scorer, O(K) resident ────────────────────────────────
  lexical(text, filter = {}, limit = 10) {
    const q = String(text || '').toLowerCase().split(/\W+/).filter(Boolean);
    if (!q.length) return [];
    const top = []; // bounded top-K, ascending by score
    for (const { rec } of this._scan()) {
      if (rec.deleted_at) continue;
      if (!this._passesFilter(rec, filter)) continue;
      const hay = `${rec.title || ''} ${rec.content || ''}`.toLowerCase();
      let score = 0;
      for (const t of q) if (t && hay.includes(t)) score += 1;
      if (score === 0) continue;
      const item = { id: rec.id, score: score / q.length, payload: rec };
      if (top.length < limit) {
        top.push(item); top.sort((a, b) => a.score - b.score);
      } else if (item.score > top[0].score) {
        top[0] = item; top.sort((a, b) => a.score - b.score);
      }
    }
    return top.sort((a, b) => b.score - a.score);
  }

  hydrate(ids) {
    const out = [];
    for (const id of ids) {
      const found = this._recById(id);
      if (found && !found.rec.deleted_at) out.push(found.rec);
    }
    return out;
  }

  // ── list: streaming scan + bounded newest-first window (O(offset+limit) resident) ──────────
  list(filter = {}, cursor, limit = 100, offset = 0) {
    limit = Math.min(limit, 500);
    const windowSize = Math.min(offset + limit, 100000);
    const cursorTs = cursor ? new Date(cursor).getTime() : Infinity;
    const win = []; // ascending by created_at; keep newest `windowSize`
    for (const { rec } of this._scan()) {
      if (rec.deleted_at) continue;
      if (Array.isArray(filter.memory_type) && filter.memory_type.length && !filter.memory_type.includes(rec.memory_type)) continue;
      if (filter.layer && rec.layer !== filter.layer) continue;
      if (filter.cognitive_layer_role === null && rec.cognitive_layer_role) continue;
      if (filter.is_latest !== undefined && !!rec.is_latest !== !!filter.is_latest) continue;
      if (filter.user_id && rec.user_id !== filter.user_id) continue;
      if (filter.created_after && new Date(rec.created_at) < new Date(filter.created_after)) continue;
      const ts = new Date(rec.created_at).getTime();
      if (ts >= cursorTs) continue;
      if (win.length < windowSize) {
        win.push(rec); win.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      } else if (ts > new Date(win[0].created_at).getTime()) {
        win[0] = rec; win.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      }
    }
    win.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); // newest first
    const rows = win.slice(offset, offset + limit);
    return { memories: rows, cursor: rows.length ? rows[rows.length - 1].created_at : null };
  }

  stats(filter = {}) {
    let memories = 0;
    if (filter.user_id) {
      for (const { rec } of this._scan()) {
        if (!rec.deleted_at && rec.is_latest !== false && rec.user_id === filter.user_id) memories++;
      }
    } else {
      memories = this.store.liveCount();
    }
    this._ensureRevEdges();
    return { memories, relationships: this._edgeCount };
  }

  // ── relationships (native typed OUT-edges + lazy reverse index for IN) ─────────────────────
  addEdge(rel) {
    const from = this.store.findById(rel.fromId);
    const to = this.store.findById(rel.toId);
    if (from < 0 || to < 0) return;
    const et = REL_TYPE[rel.type] || 1;
    this.store.addEdge(from, to, et, Math.max(1, Math.min(255, Math.round((rel.confidence ?? 1) * 255))));
    this.store.flush();
    if (this._revEdges) {
      let s = this._revEdges.get(to);
      if (!s) { s = new Set(); this._revEdges.set(to, s); }
      s.add(from);
      this._edgeCount = (this._edgeCount ?? 0) + 1;
    }
  }

  _ensureRevEdges() {
    if (this._revEdges) return;
    const rev = new Map();
    let count = 0;
    for (const { slot } of this._scan()) {
      let edges; try { edges = this.store.slotEdges(slot); } catch { continue; }
      for (const e of edges) {
        let s = rev.get(e.target);
        if (!s) { s = new Set(); rev.set(e.target, s); }
        s.add(slot);
        count++;
      }
    }
    this._revEdges = rev;
    this._edgeCount = count;
  }

  _revDropSlot(slot) {
    if (!this._revEdges) return;
    this._revEdges.delete(slot);
    for (const s of this._revEdges.values()) s.delete(slot);
  }

  // Both-direction edges of one memory id, endpoints resolved to records (bounded per-id work).
  edgesOf(id) {
    const found = this._recById(id);
    if (!found) return { out: [], in: [] };
    const out = [];
    try {
      for (const e of this.store.slotEdges(found.slot)) {
        const peer = this._recAt(e.target);
        if (!peer?.id || peer.deleted_at) continue;
        out.push({ toId: peer.id, type: REL_NAME[e.edgeType] || 'Mentions', confidence: (e.weight ?? 255) / 255, peer });
      }
    } catch { /* no edges */ }
    this._ensureRevEdges();
    const inn = [];
    for (const fromSlot of (this._revEdges.get(found.slot) || [])) {
      const peer = this._recAt(fromSlot);
      if (!peer?.id || peer.deleted_at) continue;
      let type = 'Mentions'; let confidence = 1;
      try {
        const e = this.store.slotEdges(fromSlot).find((x) => x.target === found.slot);
        if (e) { type = REL_NAME[e.edgeType] || 'Mentions'; confidence = (e.weight ?? 255) / 255; }
      } catch { /* keep defaults */ }
      inn.push({ fromId: peer.id, type, confidence, peer });
    }
    return { out, in: inn };
  }

  // Graph view: newest-first bounded node window + their edges (endpoints outside the window
  // resolved by point reads).
  graph(filter = {}, limit = 500) {
    limit = Math.min(limit, 2000);
    const { memories: nodes } = this.list({ is_latest: true, user_id: filter.user_id }, undefined, limit, 0);
    const slotById = new Map();
    const edges = [];
    for (const n of nodes) {
      const slot = this.store.findById(n.id);
      if (slot >= 0) slotById.set(n.id, slot);
    }
    const idBySlot = new Map([...slotById].map(([id, s]) => [s, id]));
    const resolve = (slot) => {
      if (idBySlot.has(slot)) return idBySlot.get(slot);
      const rec = this._recAt(slot);
      if (rec?.id && !rec.deleted_at) { idBySlot.set(slot, rec.id); return rec.id; }
      return null;
    };
    for (const [id, slot] of slotById) {
      let slotEdges; try { slotEdges = this.store.slotEdges(slot); } catch { continue; }
      for (const e of slotEdges) {
        const toId = resolve(e.target);
        if (!toId) continue;
        edges.push({ id: `e:${id}:${toId}:${e.edgeType}`, from_id: id, to_id: toId, type: REL_NAME[e.edgeType] || 'Mentions', confidence: (e.weight ?? 255) / 255 });
      }
    }
    return { nodes, edges };
  }

  // ── metadata mutations — durable via native rewriteText ────────────────────────────────────
  _patchRec(id, mutate) {
    const found = this._recById(id);
    if (!found) return false;
    mutate(found.rec);
    this.store.rewriteText(found.slot, JSON.stringify(found.rec));
    return true;
  }

  updateTags(id, tags) {
    this._patchRec(id, (rec) => { rec.tags = tags; });
    this.store.flush();
  }

  bumpRecall(ids) {
    let bumped = 0;
    for (const id of ids) {
      const ok = this._patchRec(id, (rec) => {
        rec.recall_count = (rec.recall_count || 0) + 1;
        rec.strength = Math.min(1.0, (rec.strength ?? 1.0) + 0.05);
        rec.last_accessed_at = new Date().toISOString();
      });
      if (ok) bumped++;
    }
    if (bumped) this.store.flush();
    return bumped;
  }

  patchUpdate(id, patch) {
    const ok = this._patchRec(id, (rec) => {
      if (Array.isArray(patch.tags)) rec.tags = patch.tags;
      if (patch.is_latest !== undefined) rec.is_latest = !!patch.is_latest;
      if (patch.memory_type !== undefined) rec.memory_type = patch.memory_type;
    });
    if (ok) this.store.flush();
    return ok;
  }

  // Delete a memory (tombstones the slot — supersession/cleanup deletes MUST reach the shard).
  remove(id) {
    const slot = this.store.findById(id);
    if (slot < 0) return false;
    try { this.store.delete(slot); } catch { /* already gone */ }
    this._revDropSlot(slot);
    this.store.flush();
    return true;
  }

  // Wipe every memory in the shard (account-deletion purge).
  purge() {
    let n = 0;
    let from = 0;
    for (;;) {
      const { rows, nextSlot } = this.store.recordsPage(from, PAGE);
      for (const { slotId } of rows) { try { this.store.delete(slotId); n++; } catch { /* ignore */ } }
      if (nextSlot === DONE) break;
      from = nextSlot;
    }
    this._revEdges = null;
    this._edgeCount = null;
    this.store.flush();
    return n;
  }

  // Streaming tag counters (kb-docs promoted counts): tag → live-memory count, one pass.
  countByTags(wanted) {
    const counts = {};
    for (const { rec } of this._scan()) {
      if (rec.deleted_at) continue;
      for (const t of (rec.tags || [])) if (wanted.has(t)) counts[t] = (counts[t] || 0) + 1;
    }
    return counts;
  }

  // Streaming any-tag match (kb-doc-detail / kb-doc-delete): records carrying any of `tags`.
  findByTags(tags, cap = 10000) {
    const wanted = new Set(tags);
    const out = [];
    for (const { rec } of this._scan()) {
      if (rec.deleted_at) continue;
      if ((rec.tags || []).some((t) => wanted.has(t))) {
        out.push(rec);
        if (out.length >= cap) break;
      }
    }
    return out;
  }

  // Streaming dashboard summary — one pass, O(1) resident.
  summary() {
    const byLayer = {}; const byType = {}; const users = new Set();
    let total = 0; let oldest = null; let newest = null;
    for (const { rec } of this._scan()) {
      if (rec.deleted_at) continue;
      total++;
      const lk = rec.layer || 'memory'; byLayer[lk] = (byLayer[lk] || 0) + 1;
      const tk = rec.memory_type || 'unspecified'; byType[tk] = (byType[tk] || 0) + 1;
      if (rec.user_id) users.add(rec.user_id);
      const ts = rec.created_at;
      if (ts && (!oldest || ts < oldest)) oldest = ts;
      if (ts && (!newest || ts > newest)) newest = ts;
    }
    return { total, byLayer, byType, users: users.size, oldest, newest };
  }

  flush() { try { this.store.flush(); } catch { /* best-effort */ } }
}

// ── one-time migration from the old `hm.memories`/`hm.relationships` Postgres tables ──────────
// Runs only when the shard is empty; BATCHED (id-keyset pages) so a large pre-cutover corpus
// never materializes at once in JS heap or a single Qdrant call.
export async function migrateFromPostgres(amr, pg, qFetch, qcoll, org) {
  if (amr.liveCount() > 0) return { migrated: 0, skipped: 'shard not empty' };
  const BATCH = 500;
  let migrated = 0;
  let withVector = 0;
  let lastId = null;
  for (;;) {
    const { rows: mems } = await pg.query(
      `SELECT * FROM memories WHERE org_id=$1 AND deleted_at IS NULL ${lastId ? 'AND id > $2' : ''} ORDER BY id LIMIT ${BATCH}`,
      lastId ? [org, lastId] : [org],
    );
    if (!mems.length) break;
    lastId = mems[mems.length - 1].id;
    // Real vectors from Qdrant for this batch only.
    const vecById = new Map();
    try {
      const r = await qFetch(`/collections/${qcoll}/points`, {
        method: 'POST', body: JSON.stringify({ ids: mems.map((m) => m.id), with_vector: true, with_payload: false }),
      });
      if (r.ok) {
        const j = await r.json();
        for (const p of (j.result || [])) if (p.vector) vecById.set(p.id, Float32Array.from(p.vector));
      }
    } catch (e) { console.warn('[amr] migrate: qdrant vector fetch failed for a batch:', e.message); }
    for (const m of mems) {
      const vec = vecById.get(m.id) || new Float32Array(amr.dim);
      if (vecById.has(m.id)) withVector++;
      amr.write({
        id: m.id, userId: m.user_id, content: m.content, title: m.title, tags: m.tags,
        memoryType: m.memory_type, isLatest: m.is_latest, layer: m.layer,
        cognitiveLayerRole: m.cognitive_layer_role, confidence: m.confidence,
        createdAt: m.created_at, validFrom: m.valid_from, documentDate: m.document_date,
        project: m.project, projectIds: m.project_ids, metadata: m.metadata,
        scope: m.scope, primaryTeamId: m.primary_team_id, recallCount: m.recall_count, strength: m.strength,
      }, vec);
      migrated++;
    }
  }
  // Relationships in batches too.
  let relCount = 0;
  let relCursor = null;
  for (;;) {
    const { rows: rels } = await pg.query(
      `SELECT * FROM relationships WHERE org_id=$1 ${relCursor ? 'AND id > $2' : ''} ORDER BY id LIMIT ${BATCH}`,
      relCursor ? [org, relCursor] : [org],
    );
    if (!rels.length) break;
    relCursor = rels[rels.length - 1].id;
    for (const r of rels) { amr.addEdge({ fromId: r.from_id, toId: r.to_id, type: r.type, confidence: r.confidence }); relCount++; }
  }
  amr.flush();
  return { migrated, with_real_vector: withVector, relationships: relCount };
}
