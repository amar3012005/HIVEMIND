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
    ...(process.env.MNEME_BINDING ? [process.env.MNEME_BINDING] : []),
    path.join(HERE, `singulance-amr.${triple}.node`),
    path.join(HERE, 'singulance-amr.node'),
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
// Layer ids + the document-layer recall exclusion live in their own binding-free module so the
// rule that decides what a caller may see stays unit-testable. See layers.mjs.
import { layerIdOf, isNonRecallable, DOCUMENT_LAYER } from './layers.mjs';
export { DOCUMENT_LAYER, isNonRecallable };
const PAGE = 2000; // records per native scan page — bounds the JS working set
const DONE = 0xFFFFFFFF; // recordsPage sentinel
// Plain number (not BigInt): napi coerces JS number → i64; BigInt throws. ns from ms×1e6 exceeds
// 2^53 so the low microseconds round — acceptable for valid_from anchors.
const dateToNs = (d) => (d ? new Date(d).getTime() * 1e6 : 0);

/**
 * Fold + tokenize text for the in-shard lexical lane.
 *
 * Language-neutral on purpose: no stop-word list, no stemmer, no per-language rules —
 * those are exactly the brittle, language-specific logic this codebase keeps removing.
 * Expanding the German umlauts before stripping diacritics matters: `ü`→`ue` is how a
 * German reader writes it without the umlaut, whereas a bare diacritic strip gives `u`
 * and silently changes the word. Both then survive NFKD for every other alphabet.
 */
function tokenizeFolded(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    // Unicode properties keep every writing system in the lexical lane. The
    // previous ASCII-only split silently reduced Arabic, Devanagari, CJK, and
    // other scripts to an empty query even though semantic recall supported them.
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

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

  /**
   * Reclaim dead bytes in the slot (Phase A). The native engine is append-only:
   * deletes tombstone and `rewriteText` appends a new text blob, so `.txt`/`.edg`
   * grow forever. `compact()` exists in the Rust core but had ZERO call sites —
   * measured consequence: 4.2 MB of `shard.vec` for 11 live memories.
   *
   * SAFETY: flush first so nothing in flight is lost, and drop the derived caches
   * afterwards — compaction rewrites the slot, so cached slot ids (the reverse-edge
   * index and the edge tally) can no longer be trusted and must be rebuilt lazily.
   * @returns {number} value reported by the engine (bytes reclaimed)
   */
  compact() {
    this.store.flush();
    const reclaimed = this.store.compact();
    this._revEdges = null;
    this._edgeCount = null;
    return Number(reclaimed) || 0;
  }

  /**
   * Train the PQ (Product Quantization) codebook and enable `recallPq()` — an alternative to
   * `recall()`'s HNSW/brute path with a different tradeoff, not a universal upgrade:
   *
   *   measured on real bge-m3 data (mneme/bench/RESULTS.md) —
   *     10k vectors:  PQ build 7.2s,   query 1.71ms @ recall=1.00  (beats HNSW on BOTH)
   *     100k vectors: PQ build 54.2s (6.3x faster than HNSW's 341.5s),
   *                   query 13.58ms @ recall=1.00  (HNSW queries at 4.44ms — HNSW wins here)
   *
   * PQ stays O(n) per query with a cheap per-item cost (128-byte codes vs full f32 vectors);
   * HNSW's near-O(log n) traversal wins on query latency once the shard grows. Good fit: shards
   * you rebuild often (dev/test, small/personal-tier orgs, frequently-retrained data) where
   * build time matters more than the last few ms of query latency. Measure your own shard size
   * before reaching for this over `enableHnsw()` at real scale.
   *
   * Blocks the event loop for its duration (k-means over every live vector) — call it from a
   * background job or right after a bulk load, same caution as `enableHnsw()`/`compact()`.
   * `seed` makes training deterministic (same seed -> same codebook -> same recallPq results).
   */
  trainPq(seed = 42) {
    this.store.trainPq(seed);
  }

  /** True if `trainPq()` has run at least once for this shard. */
  pqTrained() {
    return this.store.pqTrained();
  }

  /**
   * PQ/ADC-backed recall — see `trainPq()`'s doc comment for the real tradeoff before reaching
   * for this. FAILS CLOSED: throws a clear, actionable error if `trainPq()` hasn't run yet,
   * rather than silently falling back to `recall()` — a caller who explicitly asked for PQ
   * recall should get a real answer about why it can't, not a different search they didn't ask
   * for. Same result shape as `recall()`: `[{ id, score, payload }]`.
   */
  recallPq(vector, limit = 10, filter = {}) {
    if (!this.pqTrained()) {
      throw new Error('recallPq: no PQ codebook trained yet — call trainPq() first (see pqTrained())');
    }
    const vec = vector instanceof Float32Array ? vector : Float32Array.from(vector);
    const hits = this.store.recallPq(vec, Math.min(limit * 4, 200));
    const out = [];
    for (const h of hits) {
      let rec; try { rec = JSON.parse(h.text); } catch { continue; }
      if (!this._passesFilter(rec, filter)) continue;
      out.push({ id: rec.id, score: h.score, payload: rec });
      if (out.length >= limit) break;
    }
    return out;
  }

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
      valid_to: r.validTo || found.rec.valid_to,
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
      created_at: r.createdAt || now, valid_from: r.validFrom || null, valid_to: r.validTo || null,
      document_date: r.documentDate || null,
      project: r.project || null, project_ids: r.projectIds || [], metadata: r.metadata || {},
      scope: r.scope || null, primary_team_id: r.primaryTeamId || null,
      recall_count: r.recallCount ?? 0, strength: r.strength ?? 1.0, last_accessed_at: null,
      deleted_at: null,
    };
    const hasVec = vector instanceof Float32Array || Array.isArray(vector);
    if (hasVec) {
      const vec = vector instanceof Float32Array ? vector : Float32Array.from(vector);
      const layerId = layerIdOf(merged.layer);
      this.store.insertLayered(JSON.stringify(merged), vec, dateToNs(merged.valid_from), layerId);
      if (found) { this._revDropSlot(found.slot); try { this.store.delete(found.slot); } catch { /* ignore */ } }
      this.store.flush();
    } else if (found) {
      // Metadata-only update — durable via native rewriteText (vector untouched).
      this.store.rewriteText(found.slot, JSON.stringify(merged));
      this.store.flush();
    } else {
      // New record with no vector yet (phase 1 of the 2-phase write) — zero vector placeholder;
      // the vector-bearing phase replaces the slot.
      const layerId = layerIdOf(merged.layer);
      this.store.insertLayered(JSON.stringify(merged), new Float32Array(this.dim), dateToNs(merged.valid_from), layerId);
      this.store.flush();
    }
    return { ok: true };
  }

  // ── recall (vector) ─────────────────────────────────────────────────────────────────────────
  recall(vector, limit = 10, filter = {}) {
    const n = this.store.liveCount();
    if (!n) return [];
    // Below HNSW_MIN: skip the HNSW overlay → the native engine does an EXACT brute-force scan,
    // which is sub-ms at this size AND always includes just-written slots (the async HNSW indexer
    // lags fresh inserts — write-then-immediately-recall would miss them). Above the threshold,
    // enable HNSW for sublinear recall (a few un-indexed recent items among millions is fine).
    const HNSW_MIN = Number(process.env.MNEME_HNSW_MIN || 50000);
    if (n > HNSW_MIN) { try { this.store.enableHnsw(); } catch { /* already built */ } }
    const vec = vector instanceof Float32Array ? vector : Float32Array.from(vector);
    // Over-fetch before filtering: _passesFilter drops candidates AFTER the engine
    // returns them, so a hard 200 ceiling meant a wide request (RERANK_POOL is 150)
    // could come back short whenever filtering bit — starving the cross-encoder of
    // the pool it is supposed to rank. Scale the over-fetch with the request and only
    // cap it well above the widest lane.
    const OVERFETCH_MAX = Number(process.env.MNEME_RECALL_OVERFETCH_MAX || 1000);
    const hits = this.store.recall(vec, Math.min(Math.max(limit * 4, 200), OVERFETCH_MAX));
    const out = [];
    for (const h of hits) {
      let rec; try { rec = JSON.parse(h.text); } catch { continue; }
      if (isNonRecallable(rec, filter)) continue;
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

  static _rangeCond(val, range) {
    if (!range) return true;
    if (val == null) return false;
    const comparable = typeof val === 'string' && !Number.isNaN(new Date(val).getTime()) ? new Date(val).getTime() : val;
    const bound = (value) => typeof value === 'string' && !Number.isNaN(new Date(value).getTime()) ? new Date(value).getTime() : value;
    if (range.gt !== undefined && !(comparable > bound(range.gt))) return false;
    if (range.gte !== undefined && !(comparable >= bound(range.gte))) return false;
    if (range.lt !== undefined && !(comparable < bound(range.lt))) return false;
    if (range.lte !== undefined && !(comparable <= bound(range.lte))) return false;
    return true;
  }

  static _conditionMatches(rec, condition) {
    if (condition?.should) return condition.should.some((candidate) => AmrMemoryStore._conditionMatches(rec, candidate));
    if (condition?.must) return condition.must.every((candidate) => AmrMemoryStore._conditionMatches(rec, candidate));
    if (condition?.must_not) return condition.must_not.every((candidate) => !AmrMemoryStore._conditionMatches(rec, candidate));
    if (condition?.is_empty?.key) {
      const value = rec[condition.is_empty.key];
      return value == null || (Array.isArray(value) && value.length === 0);
    }
    const value = rec[condition?.key];
    return AmrMemoryStore._matchCond(value, condition?.match)
      && AmrMemoryStore._rangeCond(value, condition?.range);
  }

  // The engine's recall sends the FULL Qdrant-shaped filter ({must:[{key,match}],must_not:[...]})
  // — org_id, user_id, project, project_ids, layer, tags, is_latest, promoted-exclusion. The
  // simple {is_latest, layer, must_not:{layer}} shape (internal callers) is still honored.
  _passesFilter(rec, f = {}) {
    if (rec.deleted_at) return false;
    if (Array.isArray(f.must) || Array.isArray(f.must_not)) {
      for (const c of f.must || []) if (!AmrMemoryStore._conditionMatches(rec, c)) return false;
      for (const c of f.must_not || []) if (AmrMemoryStore._conditionMatches(rec, c)) return false;
      if (f.should?.length && !f.should.some((c) => AmrMemoryStore._conditionMatches(rec, c))) return false;
      return true;
    }
    if (f.is_latest !== undefined && !!rec.is_latest !== !!f.is_latest) return false;
    if (f.layer && rec.layer !== f.layer) return false;
    if (f.must_not?.layer && rec.layer === f.must_not.layer) return false;
    const snapshot = f.valid_at || null;
    if (f.known_at && (!rec.created_at || new Date(rec.created_at) > new Date(f.known_at))) return false;
    if (snapshot) {
      const validFrom = rec.valid_from || rec.document_date || rec.created_at;
      if (validFrom && new Date(validFrom) > new Date(snapshot)) return false;
      if (rec.valid_to && new Date(rec.valid_to) <= new Date(snapshot)) return false;
    }
    return true;
  }

  // ── lexical — streaming token-overlap scorer, O(K) resident ────────────────────────────────
  /**
   * IN-SHARD LEXICAL LANE — a wide CANDIDATE GENERATOR, not a ranker.
   *
   * This is what lets one `.amr` slot answer hybrid recall by itself, with no Postgres
   * FTS behind it. It deliberately optimises RECALL, not precision: it hands the caller
   * a wide pool (150 wide / 40 deep) and the existing cross-encoder rerank + fusion
   * decide the final order. Trying to reproduce `ts_rank` here would be the wrong job.
   *
   * The old version scored pure substring hits on raw text, which missed the cases that
   * actually matter in a German corpus — measured: `Artikelnummer` returned ZERO rows
   * while 29 documents contained `Art.-Nr.`, and `Ladesäulen` missed `Ladesäule`.
   * Three cheap, language-neutral rules fix that without a stemmer or a dictionary:
   *
   *   1. FOLD  — lowercase, expand German umlauts (ä→ae, ö→oe, ü→ue, ß→ss), strip the
   *              remaining diacritics, drop punctuation. `Art.-Nr.` → ['art','nr'].
   *   2. PREFIX — a query token matches a doc token when either is a prefix of the other
   *              (min 3 chars). This is what catches BOTH `Artikelnummer`⊃`art` and the
   *              inflections a stemmer would normally handle (`Ladesäulen`/`Ladesäule`,
   *              `Teillast`/`Teillastbetrieb`) — no per-language rules.
   *   3. SUBSTRING — last-resort fallback so compounds still hit.
   *
   * Scores are ordering hints for the pool only. Work is bounded per record so a wide
   * scan stays predictable.
   */
  lexical(text, filter = {}, limit = 10) {
    const q = tokenizeFolded(text);
    if (!q.length) return [];
    const MAX_CHARS = Number(process.env.MNEME_LEXICAL_SCAN_CHARS || 8000);
    const top = []; // bounded min-heap-ish: index 0 is the weakest kept candidate
    for (const { rec } of this._scan()) {
      if (rec.deleted_at) continue;
      if (isNonRecallable(rec, filter)) continue;
      if (!this._passesFilter(rec, filter)) continue;
      const raw = `${rec.title || ''} ${rec.content || ''}`.slice(0, MAX_CHARS);
      const docTokens = tokenizeFolded(raw);
      if (!docTokens.length) continue;
      const docSet = new Set(docTokens);
      const joined = docTokens.join(' ');

      let score = 0;
      for (const t of q) {
        if (docSet.has(t)) { score += 1; continue; }               // exact
        let hit = 0;
        if (t.length >= 3) {
          for (const d of docSet) {
            if (d.length < 3) continue;
            if (d.startsWith(t) || t.startsWith(d)) { hit = 0.6; break; } // prefix, either way
          }
        }
        if (!hit && t.length >= 4 && joined.includes(t)) hit = 0.4;  // substring fallback
        score += hit;
      }
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
  /**
   * @returns {boolean} true when the edge was written; false when either endpoint has no slot
   *   in this shard. It returns rather than throws (a missing endpoint is normal during a
   *   two-phase ingest), but callers that COUNT edges must not count a no-op as a success —
   *   which is only possible if the outcome is reported.
   */
  addEdge(rel) {
    const from = this.store.findById(rel.fromId);
    const to = this.store.findById(rel.toId);
    if (from < 0 || to < 0) return false;
    const et = REL_TYPE[rel.type] || 1;
    this.store.addEdge(from, to, et, Math.max(1, Math.min(255, Math.round((rel.confidence ?? 1) * 255))));
    this.store.flush();
    if (this._revEdges) {
      let s = this._revEdges.get(to);
      if (!s) { s = new Set(); this._revEdges.set(to, s); }
      s.add(from);
      this._edgeCount = (this._edgeCount ?? 0) + 1;
    }
    return true;
  }

  removeEdge(rel) {
    const from = this.store.findById(rel.fromId);
    const to = this.store.findById(rel.toId);
    if (from < 0 || to < 0) return false;
    const et = REL_TYPE[rel.type] || 1;
    const removed = this.store.removeEdge(from, to, et);
    if (removed) {
      this.store.flush();
      this._revEdges = null;
      this._edgeCount = null;
    }
    return removed;
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
    // Precise edge-count decrement: this slot's OUT edges + every IN edge pointing at it.
    let dropped = 0;
    try { dropped += this.store.slotEdges(slot).length; } catch { /* slot may be gone */ }
    const inSet = this._revEdges.get(slot);
    if (inSet) dropped += inSet.size;
    this._revEdges.delete(slot);
    for (const s of this._revEdges.values()) if (s.delete(slot)) { /* counted above only for IN — OUT already counted */ }
    if (this._edgeCount != null) this._edgeCount = Math.max(0, this._edgeCount - dropped);
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
      if (patch.valid_to !== undefined) rec.valid_to = patch.valid_to;
      if (patch.content !== undefined) rec.content = patch.content;
      if (patch.title !== undefined) rec.title = patch.title;
      if (patch.importance_score !== undefined) rec.confidence = patch.importance_score;
      if (patch.metadata !== undefined) rec.metadata = patch.metadata || {};
    });
    if (ok) this.store.flush();
    return ok;
  }

  // Delete a memory (tombstones the slot — supersession/cleanup deletes MUST reach the shard).
  remove(id) {
    const slot = this.store.findById(id);
    if (slot < 0) return false;
    this._revDropSlot(slot); // BEFORE the tombstone — needs the slot's out-edges for the count
    try { this.store.delete(slot); } catch { /* already gone */ }
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
        createdAt: m.created_at, validFrom: m.valid_from, validTo: m.valid_to, documentDate: m.document_date,
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
      `SELECT r.* FROM relationships r
         JOIN memories m ON m.id = r.from_id
        WHERE m.org_id=$1 ${relCursor ? 'AND r.id > $2' : ''} ORDER BY r.id LIMIT ${BATCH}`,
      relCursor ? [org, relCursor] : [org],
    );
    if (!rels.length) break;
    relCursor = rels[rels.length - 1].id;
    for (const r of rels) { amr.addEdge({ fromId: r.from_id, toId: r.to_id, type: r.type, confidence: r.confidence }); relCount++; }
  }
  amr.flush();
  return { migrated, with_real_vector: withVector, relationships: relCount };
}
