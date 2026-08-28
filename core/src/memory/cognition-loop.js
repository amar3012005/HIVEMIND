/**
 * Cognition Loop — the "thinking" cron.
 *
 * Two passes run on schedule (default hourly):
 *
 *   Pass 1 — Synthesis (OVERHAULED in Phase 1):
 *     a) canonical-fact: for each tag cluster of size ≥ CANONICAL_CLUSTER_MIN,
 *        ask LLM to extract ONE durable canonical fact. Requires confidence ≥ 0.70.
 *     b) synthesis-bridge: for each tag-pair where the two clusters never co-occur
 *        AND cosine(centroid_A, centroid_B) ∈ [0.55, 0.85], ask LLM to find the
 *        latent causal/temporal/contradiction bridge. Requires confidence ≥ 0.70.
 *     Both modes write via engine.ingestMemory({ …, _smart_routed: false }) so
 *     smartIngestRouter fires (operator inference + entity-co-mention + conflict
 *     detector all execute). Restatement guard drops any output whose embedding
 *     cosine vs any source exceeds 0.92.
 *     Top-K per tick: BRIDGE_TOP_K bridges + one canonical per qualifying cluster.
 *     Cooldown: COOLDOWN_HOURS per cluster_hash (skip if updated in last N hours).
 *
 *   Pass 2 — Drift compaction (unchanged from prior implementation):
 *     When a topic cluster grows past THRESHOLD members, compress into one
 *     canonical "as of today" lossless summary; link via Derives edges.
 *
 * Both passes are tenant-scoped (per org_id). Loops are idempotent.
 * Status surfaced via /api/admin/cognition/status.
 */

import crypto from 'crypto';
import { runWithOrg, currentOrg } from '../db/prisma.js';
import { orgIsRemote, amrWrite, amrListRecent } from '../vector/mneme/driver.js';
import { remoteList } from '../vector/mneme/remote-backend.js';
import { chatCompletion } from '../knowledge/enterprise/litellm-client.js';
import { ClusterIndex } from './cluster-index.js';
import { clusterHash } from './cluster-hash.js';
import { normalizeEntity } from './entity-normalize.js';
import { getQdrantClient } from '../vector/qdrant-client.js';
import { crossProjectEnabledForOrg, includePersonalForOrg } from '../resident/cognition-pilot.js';
import { withGovernanceLock } from '../resident/advisory-lock.js';

// ─── Model config ──────────────────────────────────────────────────────────────
// Phase 0 cost cut: routine synthesis/compaction is high-volume, low-reasoning
// text writing over already-grounded clusters → cheap model (llama-3.1-8b-instant,
// ~30-60x cheaper than gpt-oss-120b). Reserve expert models for rare verify steps.
// SYNTHESIS_MODEL env kept for back-compat override.
// litellm-client (cognition's gateway) routes openai/gpt-oss-* to OpenRouter
// (LLM_PRIMARY) but does NOT understand a cerebras/ prefix — so the default
// here must be an OpenRouter-servable id, not cerebras/*.
const PRIMARY_SYNTHESIS_MODEL   = process.env.COGNITION_WRITER_MODEL || process.env.SYNTHESIS_MODEL || 'openai/gpt-oss-120b';
// Fallback fires on primary EXCEPTION (gateway down), so escalate to a sturdier model.
const FALLBACK_SYNTHESIS_MODEL  = process.env.SYNTHESIS_FALLBACK_MODEL || 'openai/gpt-oss-20b';

// ─── Clustering / quality thresholds ──────────────────────────────────────────
const DEFAULT_LOOKBACK_HOURS      = Number(process.env.SYNTHESIS_LOOKBACK_HOURS    || 24);
// Rolling synthesis window once an org has cognition enabled. The loop only
// ever looks at the LAST N hours of memory (default 1h) — never the full
// history. Combined with the per-org cognition_enabled_at anchor, this means:
// toggle ON → synthesize only the last hour from that moment forward, and
// keep following a 1-hour rolling window each tick. No historical backfill.
const ROLLING_WINDOW_HOURS        = Number(process.env.COGNITION_ROLLING_WINDOW_HOURS || 1);
// Adaptive cluster floor: small orgs (≤50 fact+decision memories) can't
// reach 6-member clusters. Scale floor with corpus density so sparse
// tenants get synthesis too.
//   floor = clamp(floor(latest_fact_decision_count / 50), 3, 6)
// Examples: 20 fact+decision → 3 ; 100 → 6 ; 300 → 6 (capped).
// Env override CANONICAL_CLUSTER_MIN still wins when explicitly set.
const CANONICAL_CLUSTER_MIN_HARD  = Number(process.env.CANONICAL_CLUSTER_MIN_HARD  || 6);
const CANONICAL_CLUSTER_MIN_SOFT  = Number(process.env.CANONICAL_CLUSTER_MIN_SOFT  || 3);
// Adaptive clusterMin = floor(corpus / DIVISOR), clamped [SOFT, HARD]. Env-tunable.
const CLUSTER_MIN_DIVISOR         = Number(process.env.COGNITION_CLUSTER_MIN_DIVISOR || 50);
// Dream retention / fast-tier: evict DEAD dream (synthesis) vectors from the hot
// per-tenant Qdrant collection so ANN cost stays bounded as dreams accrue (the
// supermemory "keep only dream-processed memories in the fast index" cost win).
// Targets ONLY synthesis rows already dead in Postgres (superseded isLatest=false
// OR soft-deleted) past a grace window — never raw user memories, never live
// recallable dreams. Flag-gated default OFF.
const DREAM_RETENTION_ENABLED     = process.env.DREAM_RETENTION_ENABLED === 'true';
const RETENTION_GRACE_DAYS        = Number(process.env.DREAM_RETENTION_GRACE_DAYS || 7);
const RETENTION_MAX_PER_RUN       = Number(process.env.DREAM_RETENTION_MAX_PER_RUN || 500);
const CANONICAL_CLUSTER_MIN_ENV   = process.env.CANONICAL_CLUSTER_MIN != null
  ? Number(process.env.CANONICAL_CLUSTER_MIN)
  : null;
const CANONICAL_CLUSTER_MIN       = CANONICAL_CLUSTER_MIN_ENV ?? CANONICAL_CLUSTER_MIN_HARD;

async function deriveClusterMin(prisma, orgId) {
  // Env override pins value across all orgs — operators may force a
  // specific floor for benchmarks. Skip the DB lookup.
  if (CANONICAL_CLUSTER_MIN_ENV != null) return CANONICAL_CLUSTER_MIN_ENV;
  try {
    // Per-tenant override (organizations.cognition_cluster_min) wins over the
    // adaptive default — lets a sparse-entity enterprise lower the floor.
    const o = await prisma.$queryRawUnsafe(
      `SELECT cognition_cluster_min AS m FROM hivemind.organizations WHERE id = $1::uuid`, orgId,
    ).catch(() => null);
    const override = o?.[0]?.m;
    if (Number.isInteger(override) && override > 0) return override;

    // Remote (self-host): memory rows live on the agent — central count is always 0. Count
    // fact/decision from a bounded agent list instead (same adaptive purpose).
    if (orgIsRemote(orgId)) {
      // Background sizing heuristic — degrade to the soft floor if the shard is unavailable.
      const out = await remoteList(orgId, { memory_type: ['fact', 'decision'], is_latest: true }, null, 400)
        .catch((e) => { console.warn(`[cognition] remote list unavailable org=${orgId}: ${e.message}`); return null; });
      const adaptiveRemote = Math.floor((out?.memories?.length || 0) / CLUSTER_MIN_DIVISOR);
      return Math.max(CANONICAL_CLUSTER_MIN_SOFT, Math.min(CANONICAL_CLUSTER_MIN_HARD, adaptiveRemote));
    }

    const cnt = await prisma.memory.count({
      where: {
        orgId,
        isLatest: true,
        deletedAt: null,
        memoryType: { in: ['fact', 'decision'] },
      },
    });
    const adaptive = Math.floor(cnt / CLUSTER_MIN_DIVISOR);
    return Math.max(CANONICAL_CLUSTER_MIN_SOFT, Math.min(CANONICAL_CLUSTER_MIN_HARD, adaptive));
  } catch (err) {
    return CANONICAL_CLUSTER_MIN_HARD;
  }
}
const DEFAULT_CLUSTER_MAX         = Number(process.env.SYNTHESIS_CLUSTER_MAX       || 30);
const CONFIDENCE_FLOOR            = Number(process.env.SYNTHESIS_CONFIDENCE_FLOOR  || 0.70);
const BRIDGE_TOP_K                = Number(process.env.BRIDGE_TOP_K                || 10);
// Cosine range for bridge eligibility: clusters must be related but not identical
const BRIDGE_SIM_LOW              = Number(process.env.BRIDGE_SIM_LOW              || 0.55);
const BRIDGE_SIM_HIGH             = Number(process.env.BRIDGE_SIM_HIGH             || 0.85);
// A2 anti-hallucination grounding: a bridge must reflect a REAL connection — the
// two clusters must share ≥ this many actual entities (entity:/person: tags),
// not just centroid cosine (which yields tautological/coincidental bridges like
// "US contacts share country:usa with US accounts"). 0 disables the gate.
const BRIDGE_GROUND_MIN          = Number(process.env.BRIDGE_GROUND_MIN          || 1);
// Multi-cluster NARRATIVE bridge: pairwise bridges connect 2 clusters; a narrative
// bridge weaves ≥ NARRATIVE_MIN_CLUSTERS clusters that all share ONE hub entity
// (the connective thread) into a single emergent thought — the "facts that came in
// over months across separate conversations, stitched into one narrative" pattern.
// Heavily gated (hub must link ≥3 clusters, confidence floor, restatement + dedup
// guards) and capped at NARRATIVE_TOP_K/run. Default ON; set =false to disable.
const NARRATIVE_BRIDGE_ENABLED   = process.env.COGNITION_NARRATIVE_BRIDGE !== 'false';
const NARRATIVE_MIN_CLUSTERS     = Number(process.env.NARRATIVE_MIN_CLUSTERS     || 3);
const NARRATIVE_TOP_K            = Number(process.env.NARRATIVE_TOP_K            || 3);
const NARRATIVE_MAX_CLUSTERS     = Number(process.env.NARRATIVE_MAX_CLUSTERS     || 6);
// Drop synthesis output if cosine(output, any source) > this (restatement guard)
const RESTATEMENT_THRESHOLD       = Number(process.env.RESTATEMENT_THRESHOLD       || 0.92);
const COOLDOWN_HOURS              = Number(process.env.SYNTHESIS_COOLDOWN_HOURS    || 6);
// Entity over-dream guard: even across DIFFERENT cluster hashes, do not re-dream
// the same dominant entity/person within this window. Stops a hot entity (one that
// shows up in many clusters) from being dreamed repeatedly each tick ("overdone").
// The per-cluster_hash COOLDOWN_HOURS only stops re-dreaming the SAME cluster; this
// adds a cross-cluster, per-entity "last dreamed" floor. 0 disables. Default 20h so
// a nightly schedule refreshes once/day but never twice in the same night.
const ENTITY_DREAM_COOLDOWN_HOURS = Number(process.env.ENTITY_DREAM_COOLDOWN_HOURS || 20);
// WS3 retroactive re-sweep: re-examine syntheses older than N days for
// contradictions that arrived AFTER they were written, and temper confidence
// down (the forward synthesis path only ratchets confidence UP).
const STALE_REWEIGHT_DAYS         = Number(process.env.STALE_REWEIGHT_DAYS         || 7);
const REWEIGHT_MAX_PER_TICK       = Number(process.env.REWEIGHT_MAX_PER_TICK       || 20);
const REWEIGHT_TEMPER_PER_HIT     = Number(process.env.REWEIGHT_TEMPER_PER_HIT     || 0.15);
const REWEIGHT_CONF_FLOOR         = Number(process.env.REWEIGHT_CONF_FLOOR         || 0.30);
// Mechanism #2 — graph-neighborhood reach: how many OLD (beyond-window) memories
// sharing an active cluster's entity/topic tag to pull into synthesis, so a dream
// connects past + present across sources. Bounded per active cluster (cost guard).
const NEIGHBOR_REACH_MAX          = Number(process.env.COGNITION_NEIGHBOR_REACH_MAX || 10);
const DRIFT_COMPACT_THRESHOLD     = Number(process.env.DRIFT_COMPACT_THRESHOLD     || 12);
// Hard cap on members folded into one canonical (stops 394-member pathology)
const MAX_MEMBERS_PER_CANONICAL   = Number(process.env.DRIFT_MAX_MEMBERS_PER_CANONICAL || 10);
const MAX_ORGS_PER_TICK           = Number(process.env.COGNITION_MAX_ORGS_PER_TICK  || 25);

// ─── Phase A: L2 principle tier (flag-gated, default OFF) ─────────────────────
// Principles are the transferable rule layer above canonical-facts. Reuses the
// synthesis storage table (memory_type='synthesis', tag 'synthesis:principle',
// cognitive_layer_role='principle'). Default OFF → distillPrinciplesForOrg is a
// no-op and behaviour is byte-identical to pre-Phase-A.
const PRINCIPLES_ENABLED          = process.env.PRINCIPLES_ENABLED !== 'false';
const PRINCIPLE_CLUSTER_MIN       = Number(process.env.PRINCIPLE_CLUSTER_MIN       || 8);
const PRINCIPLE_TOP_K             = Number(process.env.PRINCIPLE_TOP_K             || 5);
const PRINCIPLE_CONFIDENCE_FLOOR  = Number(process.env.PRINCIPLE_CONFIDENCE_FLOOR  || 0.72);
// Principles change slowly — cool down twice as long as canonical synthesis.
const PRINCIPLE_COOLDOWN_HOURS    = Number(process.env.PRINCIPLE_COOLDOWN_HOURS    || COOLDOWN_HOURS * 2);

/** @returns {boolean} whether the L2 principle tier is enabled */
export function isPrinciplesEnabled() { return PRINCIPLES_ENABLED; }

/** @returns {boolean} whether the dream-retention/fast-tier pass auto-runs */
export function isDreamRetentionEnabled() { return DREAM_RETENTION_ENABLED; }

// Slugify a topic tag into a stable principle:<slug> tag fragment.
/** @param {string} s @returns {string} */
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

// ─── P3 selective vector forgetting ──────────────────────────────────────────
// Drift compaction builds a LOSSLESS summary (every source embedded verbatim),
// so once a source is folded in, its standalone vector is pure redundancy that
// keeps polluting ANN recall (the Memora failure mode: stale fragments retrieved
// alongside the canonical). We delete the source POINTS from Qdrant (the DB rows
// survive as isLatest=false for time-travel/evolution).
//
// IMPORTANT: in this collection the Qdrant POINT ID *is* the memory UUID — there
// is NO `memory_id` payload field (verified by scroll). So deletion MUST target
// `{ points: [...] }` by id, NOT a payload filter. (The filter-by-memory_id
// pattern elsewhere in server.js is a silent no-op for the same reason — see
// the follow-up note.) Deleting by point id also needs no payload index.
async function purgeVectorsByMemoryIds(memoryIds, orgId = null, logger = console) {
  const ids = (memoryIds || []).filter(Boolean);
  if (ids.length === 0) return 0;
  const qdrantUrl = process.env.QDRANT_URL || process.env.QDRANT_CLOUD_URL;
  if (!qdrantUrl) return 0;
  // Per-tenant routing: the memory's vector lives in its org container
  // (org_<id>) or HIVEMIND_PERSONAL, NOT the legacy 'BUNDB AGENT' singleton.
  // Without this, drift-compaction supersession purges the wrong (empty)
  // collection → stale vectors re-accumulate in the live collection (ANN
  // re-pollution). Resolver is plan-aware + cached.
  let qdrantCollection = 'HIVEMIND_PERSONAL';
  try {
    const { resolveCollectionForOrg, PER_TENANT } = await import('../vector/container-router.js');
    if (PER_TENANT) qdrantCollection = await resolveCollectionForOrg(orgId);
  } catch (e) {
    logger.warn(`[cognition] collection resolve failed, using ${qdrantCollection}: ${e.message}`);
  }
  const qdrantKey = process.env.QDRANT_API_KEY || '';
  let purged = 0;
  try {
    const chunkSize = 500;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const slice = ids.slice(i, i + chunkSize);
      const resp = await fetch(`${qdrantUrl}/collections/${encodeURIComponent(qdrantCollection)}/points/delete?wait=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(qdrantKey ? { 'api-key': qdrantKey } : {}) },
        body: JSON.stringify({ points: slice }),
      });
      if (resp.ok) purged += slice.length;
      else logger.warn(`[cognition] vector purge HTTP ${resp.status}: ${(await resp.text()).slice(0, 160)}`);
    }
  } catch (err) {
    logger.warn(`[cognition] vector purge failed (non-fatal): ${err.message}`);
  }
  return purged;
}

// ─── Tag filters ───────────────────────────────────────────────────────────────
// Tags that don't form meaningful topic clusters for synthesis purposes.
// Includes provenance / ingest-source tags (source:, url:, kind:, skill:,
// type:, from-<platform>, *-ingest): these describe WHERE a memory came from,
// not WHAT it is about, so bucketing on them produces redundant near-duplicate
// syntheses (e.g. every chat-ingested memory clustering under from-claude /
// url:claude.ai / ai-chat-ingest). Topic + entity tags remain the only anchors.
const SYS_TAG_RE = /^(file:|fn:|page:|heading:|upload:|doc-hash:|promoted-from|synthesized|topic:|cognition-loop|synthesis:|knowledge-base$|document$|document-summary$|entity:|time:|ts:|section:|chat$|talk-to-hive$|source:|url:|kind:|skill:|provider:|model:|type:|from-[a-z]+$|[a-z][a-z-]*-ingest$)/i;

// ─── Entity-key derivation (cluster_index.entity_keys) ───────────────────────
// Inherited tag prefixes that carry entity identity. Strip prefix to produce
// a flat entity key. Mirror order with backfill script.
const ENTITY_TAG_PREFIXES = ['entity:', 'person:', 'project:', 'organization:', 'location:'];
function deriveEntityKeysFromTags(tags) {
  if (!Array.isArray(tags)) return [];
  const keys = new Set();
  for (const t of tags) {
    if (typeof t !== 'string') continue;
    for (const p of ENTITY_TAG_PREFIXES) {
      if (t.startsWith(p)) { keys.add(t.slice(p.length)); break; }
    }
  }
  // Fallback: proper-noun-like plain tags (CapCase or ACRONYM)
  if (keys.size === 0) {
    for (const t of tags) {
      if (typeof t !== 'string') continue;
      if (/^[A-Z][A-Za-z0-9]+$/.test(t) || /^[A-Z0-9]{2,}$/.test(t)) keys.add(t);
    }
  }
  return [...keys].slice(0, 15);
}

// ─── In-process status ────────────────────────────────────────────────────────
const _status = {
  last_run_at: null,
  last_run_ms: null,
  last_synthesis_count: 0,
  last_compaction_count: 0,
  next_run_at: null,
  running: false,
  errors: [],
};

export function getCognitionStatus() {
  return { ..._status };
}

// ─── Token-level cosine similarity (no embedding required) ───────────────────
// Used for centroid similarity approximation and restatement guard when
// vector embeddings are not available in-process.
function tokenCosine(textA = '', textB = '') {
  const tokenize = (t) => {
    const words = t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length >= 3);
    const freq = new Map();
    for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
    return freq;
  };
  const a = tokenize(textA);
  const b = tokenize(textB);
  if (a.size === 0 || b.size === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [w, va] of a) {
    normA += va * va;
    if (b.has(w)) dot += va * b.get(w);
  }
  for (const [, vb] of b) normB += vb * vb;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Strip the ingest-time "(YYYY-MM-DDTHH:MMZ)" suffix graph-engine appends to
// content. Without this the synthesis LLM treats the INGEST timestamp as a
// real-world EVENT date and fabricates date facts / date-coincidence bridges
// (e.g. "X copyrighted on 2026-06-14, the same day Y…" where the date is just
// when both were saved). Eval caught this as a 0%-grounding failure mode.
const INGEST_STAMP_RE = /\s*\((?:\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2})?Z?)?\)\s*$/;
export function stripIngestStamp(text) {
  let s = String(text || '');
  // strip possibly-repeated trailing stamps
  for (let i = 0; i < 3 && INGEST_STAMP_RE.test(s); i++) s = s.replace(INGEST_STAMP_RE, '');
  return s.trim();
}
// Prompt note: tells the LLM the shown date is ingest metadata, not an event date.
const RECORDED_DATE_NOTE = 'NOTE: the "(recorded YYYY-MM-DD)" prefix is when the memory was INGESTED, NOT a real-world event date. NEVER connect or bridge two facts merely because they share a recorded date, and never state a recorded date as if it were an event.';

// ─── Centroid text (bag of all content in a cluster) ─────────────────────────
function clusterCentroidText(members) {
  return members.map(m => `${m.title || ''} ${m.content || ''}`).join(' ').slice(0, 8000);
}

// ─── A2 bridge grounding: real shared entities between two clusters ───────────
// Extract entity:/person: tags from a cluster's members.
function entityTagsOf(members) {
  const s = new Set();
  for (const m of members || []) {
    for (const t of (m.tags || [])) {
      const tl = String(t).toLowerCase();
      if (tl.startsWith('entity:') || tl.startsWith('person:')) s.add(tl);
    }
  }
  return s;
}
// Distinct non-null project values across one or more member lists. Used to
// enforce cross_project scope: when an org has cross-project dreaming OFF, a
// bridge/narrative may not connect clusters that live in DIFFERENT projects.
// Project-less (personal/org-level) members don't count as a project boundary.
function spansMultipleProjects(...memberLists) {
  const projects = new Set();
  for (const list of memberLists) {
    for (const m of (list || [])) {
      const p = m.project || m.projectId || null;
      if (p) projects.add(String(p));
    }
  }
  return projects.size >= 2;
}

// Count entities present in BOTH clusters — the real connective tissue of a bridge.
function sharedEntityKeys(aMembers, bMembers) {
  const A = entityTagsOf(aMembers);
  const B = entityTagsOf(bMembers);
  const shared = [];
  for (const e of A) if (B.has(e)) shared.push(e);
  return shared;
}

// ─── Cluster hash ─────────────────────────────────────────────────────────────
// clusterHash now imported from ./cluster-hash.js (shared with graph-engine's
// ingest-time dirty bump so both sides agree on cluster identity).

// ─── LLM call with primary→fallback retry ────────────────────────────────────
async function llmWithFallback(params, logger) {
  try {
    const raw = await chatCompletion({ ...params, model: PRIMARY_SYNTHESIS_MODEL });
    return String(raw || '').trim();
  } catch (primaryErr) {
    if (logger) logger.warn(`[cognition] primary model failed (${primaryErr.message}), falling back to ${FALLBACK_SYNTHESIS_MODEL}`);
    const raw = await chatCompletion({ ...params, model: FALLBACK_SYNTHESIS_MODEL });
    return String(raw || '').trim();
  }
}

// ─── JSON parse with fallback ─────────────────────────────────────────────────
function safeParseJSON(txt) {
  // Strip markdown code fences if present
  const cleaned = txt.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Try extracting the first {...} block
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* fall through */ }
    }
    return null;
  }
}

export class CognitionLoop {
  constructor({ prisma, memoryGraphEngine, persistentMemoryStore, logger = console }) {
    this.prisma        = prisma;
    this.engine        = memoryGraphEngine;
    this.store         = persistentMemoryStore;
    this.logger        = logger;
    this._timer        = null;
    this._intervalMs   = Number(process.env.COGNITION_INTERVAL_MS || 60 * 60 * 1000); // 1h
    // ClusterIndex: durable cluster-state for dirty-scheduling (Move 1)
    this.clusterIndex  = new ClusterIndex({ prisma });
  }

  async _applyRelationship(edge, { orgId, userId }) {
    if (!this.engine?.applyValidatedRelationship) {
      throw new Error('canonical_relationship_dispatcher_unavailable');
    }
    return this.engine.applyValidatedRelationship(edge, {
      store: this.store,
      org_id: orgId,
      user_id: userId,
    });
  }

  start() {
    // PHASE D — the standalone cognition timer is retired. Cadence is now owned
    // by ResidentAgentScheduler (governance cycle). This start() is an inert
    // no-op unless explicitly re-armed via ENABLE_COGNITION_LOOP_TIMER=true.
    // (server.js:485 cognitionLoop.start() therefore becomes inert without
    // touching the forbidden server.js file.)
    // PHASE-D NOTE: server.js:8971 reads cognitionLoop.timer (vs this._timer) —
    // a pre-existing field-name mismatch bug. DO NOT fix here (forbidden file).
    if (process.env.ENABLE_COGNITION_LOOP_TIMER !== 'true') {
      this.logger.log('[cognition] standalone timer retired (Phase D) — cadence owned by ResidentAgentScheduler; set ENABLE_COGNITION_LOOP_TIMER=true to re-arm');
      return;
    }
    if (this._timer) return;
    this.logger.log(`[cognition] starting loop — interval=${Math.round(this._intervalMs / 1000)}s`);
    // First tick: small delay so startup load doesn't pile up
    this._timer = setTimeout(() => this._tick(), 30_000);
  }

  stop() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  /**
   * Manual single-org trigger.
   * Same status-counter update as the auto tick — call from
   * /api/cognition/synthesize-now so the UI sees fresh last_run / counts.
   */
  /**
   * Activity gate (per org). Two reasons to skip a cognition run entirely — no
   * model spend, no churn:
   *   A) zero NEW real memories since the last run → re-synthesizing identical
   *      data produces nothing new and just burns tokens. ("don't do it again
   *      and again.")
   *   B) fewer than COGNITION_MIN_WINDOW_MEMORIES real memories in the lookback
   *      window → nothing can cluster, so there is nothing to synthesize.
   * "Real" = fact/decision that is NOT a synthesis/reflection output
   * (cognitive_layer_role IS NULL) and NOT the governance swarm's own audit rows.
   * The window/last-run counts exclude cognition's own output so a run never
   * re-triggers itself. Fail-open on DB error (a transient hiccup must not stall
   * cognition silently).
   * @returns {Promise<{run: boolean, reason: string|null}>}
   */
  /**
   * Per-org cognition enable state + the effective synthesis-window start.
   * Returns { enabled, since }:
   *   - enabled: false  → org never opted in (cognition_org_enabled=false).
   *   - since: max(now - ROLLING_WINDOW_HOURS, cognition_enabled_at) — so the
   *     loop sees ONLY the last hour AND never anything from before the org
   *     toggled cognition on. No historical backfill, ever.
   */
  async _cognitionWindow(orgId, opts = {}) {
    // Scheduled (cron / night-mode) runs pass a WIDE lookback so a single nightly
    // dream connects dots across the whole day/period — not just the last hour.
    // Continuous early-dream ticks omit it and keep the tight 1h rolling window.
    const lookbackHours = Number(opts.lookbackHours) > 0 ? Number(opts.lookbackHours) : ROLLING_WINDOW_HOURS;
    const rollingStart = Date.now() - lookbackHours * 3600 * 1000;
    try {
      const rows = await this.prisma.$queryRawUnsafe(
        `SELECT cognition_org_enabled AS enabled, cognition_enabled_at AS enabled_at
           FROM hivemind.organizations WHERE id = $1::uuid`,
        orgId,
      );
      const row = rows?.[0];
      if (!row || row.enabled !== true) return { enabled: false, since: new Date(rollingStart) };
      const anchorMs = row.enabled_at ? new Date(row.enabled_at).getTime() : 0;
      return { enabled: true, since: new Date(Math.max(rollingStart, anchorMs)) };
    } catch (err) {
      // On read failure, fall back to enabled + rolling window (don't wedge
      // the loop), but stay bounded to 1h so we still never backfill.
      this.logger.warn?.(`[cognition] window read failed org=${orgId}: ${err.message}`);
      return { enabled: true, since: new Date(rollingStart) };
    }
  }

  async _shouldRunForOrg(orgId, opts = {}) {
    const MIN = Number(process.env.COGNITION_MIN_WINDOW_MEMORIES || 3);
    // Gate on the org toggle + clamp the window to max(now-1h, enabled_at).
    // An org that never opted in is skipped entirely (no spend); an opted-in
    // org only ever synthesizes its last-hour, post-enable activity.
    const win = await this._cognitionWindow(orgId, opts);
    if (!win.enabled) {
      return { run: false, reason: 'cognition_disabled_for_org' };
    }
    const since = win.since;
    // Remote (self-host): the working set lives on the agent — central count is 0 and would always gate
    // out. Count fact/decision memories from the agent instead (bounded recent list).
    if (orgIsRemote(orgId)) {
      const _excl = ['internal-audit', 'governance', 'synthesis:canonical', 'synthesis:bridge', 'canonical-summary', 'synthesized'];
      const rows = await amrListRecent(orgId, null, 400).catch(() => []);
      const windowCount = rows.filter((r) => ['fact', 'decision'].includes(r.memory_type || r.memoryType)
        && !(r.tags || []).some((t) => _excl.includes(t))).length;
      if (windowCount < MIN) return { run: false, reason: `below_min_window_memories(${windowCount}<${MIN})` };
      return { run: true, reason: null };
    }
    const baseWhere = {
      orgId,
      deletedAt: null,
      memoryType: { in: ['fact', 'decision'] },
      cognitiveLayerRole: null,
      NOT: { tags: { hasSome: ['internal-audit', 'governance', 'synthesis:canonical', 'synthesis:bridge', 'canonical-summary', 'synthesized'] } },
    };
    try {
      const windowCount = await this.prisma.memory.count({
        where: { ...baseWhere, createdAt: { gte: since } },
      });
      if (windowCount < MIN) {
        return { run: false, reason: `below_min_window_memories(${windowCount}<${MIN})` };
      }
      const status = this.prisma?.cognitionStatus
        ? await this.prisma.cognitionStatus.findUnique({ where: { orgId }, select: { lastTickAt: true } }).catch(() => null)
        : null;
      const lastTickAt = status?.lastTickAt || null;
      if (lastTickAt) {
        const newSinceLastRun = await this.prisma.memory.count({
          where: { ...baseWhere, createdAt: { gt: lastTickAt } },
        });
        if (newSinceLastRun === 0) {
          return { run: false, reason: 'no_new_activity_since_last_run' };
        }
      }
      return { run: true, reason: null };
    } catch (err) {
      this.logger.warn?.(`[cognition] activity-gate check failed (${err.message}) — running anyway`);
      return { run: true, reason: null };
    }
  }

  async runOnce(orgId, opts = {}) {
    if (orgId && currentOrg() !== orgId) return runWithOrg(orgId, () => this.runOnce(orgId, opts)); // residency
    // Self-host orgs: synthesis is allowed but MUST use the agent-routed store (amrWrite/amrAddEdge).
    // Destructive passes (drift-compaction, principle-distill, reweight) are central-coupled
    // and MUST NOT run for remote orgs — compaction in particular can hard-purge KB data.
    const _remote = orgIsRemote(orgId);
    const { skipCompaction = false, lookbackHours, trigger = 'manual', triggeredBy = null } = opts;
    if (_status.running) {
      return { skipped: true, reason: 'tick already in progress' };
    }
    _status.running = true;
    const tStart = Date.now();
    const runStart = new Date(tStart);
    const winOpts = Number(lookbackHours) > 0 ? { lookbackHours: Number(lookbackHours) } : {};
    // Audit row (best-effort — never block/break a run on audit failure or a
    // pre-migration prisma client without the cognitionRun model).
    const runRow = await this._auditRunStart({ orgId, trigger, triggeredBy, lookbackHours });
    try {
      const gate = await this._shouldRunForOrg(orgId, winOpts);
      if (!gate.run) {
        this.logger.log(`[cognition] org=${orgId} skipped — ${gate.reason}`);
        await this._auditRunFinish(runRow, { status: 'skipped', skippedReason: gate.reason, runMs: Date.now() - tStart });
        // Do NOT persist status on skip: lastTickAt must stay anchored to the
        // last run that actually processed data, so gate A keeps comparing
        // against it until new memories arrive.
        return { synth: 0, compact: 0, principles: 0, ms: Date.now() - tStart, skipped: true, reason: gate.reason };
      }
      const synth   = await this.synthesizeForOrg(orgId, winOpts);
      // Drift compaction folds large clusters and demotes+purges their members.
      // On a MANUAL trigger that is a full-window blast over live user data
      // (the §10 hazard that over-compacted a real org's KB). Skip it on manual
      // runs; gentle compaction still happens on the scheduled every-12-tick
      // cadence via the governance 'compression' tool.
      // Remote orgs: compaction is destructive (hard-purges central KB) — never run it.
      // Central-only passes (principle-distill + reweight) are also skipped for remote
      // because they read+write central prisma tables that hold 0 rows for remote orgs.
      const compact = (_remote || skipCompaction) ? 0 : await this.compactDriftForOrg(orgId);
      // Pass 3 — L2 principle distillation (no-op unless PRINCIPLES_ENABLED; skip remote)
      const principles = _remote ? 0 : await this.distillPrinciplesForOrg(orgId);
      // Pass 4 — WS3 retroactive re-sweep: temper stale syntheses on late
      // contradictions (cheap, capped, no LLM). Non-fatal. Skip remote (central-only).
      let reweighted = 0;
      if (!_remote) {
        try { reweighted = await this.reweightStaleForOrg(orgId); }
        catch (rwErr) { this.logger.warn(`[cognition][reweight] org=${orgId} failed: ${rwErr.message}`); }
      }
      if (reweighted) this.logger.log(`[cognition] reweight org=${orgId} tempered=${reweighted}`);
      _status.last_run_at           = new Date().toISOString();
      _status.last_run_ms           = Date.now() - tStart;
      _status.last_synthesis_count  = synth;
      _status.last_compaction_count = compact;
      _status.next_run_at           = new Date(Date.now() + this._intervalMs).toISOString();
      this.logger.log(`[cognition] manual run org=${orgId} synth=${synth} compact=${compact} principles=${principles} ms=${_status.last_run_ms}`);
      // PHASE-A TODO: surface principle count via a cognition_status counter
      // column (do NOT add the schema column in this stage).
      await this._persistOrgStatus(orgId, { synth, compact, runMs: Date.now() - tStart, error: null });
      await this._auditRunFinish(runRow, {
        status: 'completed', synthCount: synth, compactCount: compact,
        principleCount: principles, reweightedCount: reweighted,
        producedMemoryIds: await this._producedDreamIds(orgId, runStart),
        runMs: Date.now() - tStart,
      });
      return { synth, compact, principles, ms: _status.last_run_ms };
    } catch (err) {
      _status.errors = [..._status.errors.slice(-9), { org_id: orgId, error: err.message, at: new Date().toISOString() }];
      await this._persistOrgStatus(orgId, { synth: 0, compact: 0, runMs: Date.now() - tStart, error: err.message });
      await this._auditRunFinish(runRow, { status: 'error', error: err.message, runMs: Date.now() - tStart });
      throw err;
    } finally {
      _status.running = false;
    }
  }

  // ─── Run audit (cognition_run) — best-effort, never fatal ────────────────────
  /** Create a 'running' audit row. Returns { id } or null if unavailable. */
  async _auditRunStart({ orgId, trigger, triggeredBy, lookbackHours }) {
    if (!this.prisma?.cognitionRun) return null;
    try {
      return await this.prisma.cognitionRun.create({
        data: {
          orgId, trigger: trigger || 'manual', status: 'running',
          lookbackHours: Number(lookbackHours) > 0 ? Number(lookbackHours) : null,
          triggeredBy: triggeredBy || null,
        },
        select: { id: true },
      });
    } catch (err) {
      this.logger.warn?.(`[cognition][audit] start failed: ${err.message}`);
      return null;
    }
  }

  /** Finalize an audit row with counts + status. No-op if row is null. */
  async _auditRunFinish(runRow, fields) {
    if (!this.prisma?.cognitionRun || !runRow?.id) return;
    try {
      await this.prisma.cognitionRun.update({
        where: { id: runRow.id },
        data: { ...fields, finishedAt: new Date() },
      });
    } catch (err) {
      this.logger.warn?.(`[cognition][audit] finish failed: ${err.message}`);
    }
  }

  /** Dream memory IDs created during this run (synthesis rows since runStart). */
  async _producedDreamIds(orgId, runStart) {
    try {
      const rows = await this.prisma.memory.findMany({
        where: { orgId, memoryType: 'synthesis', deletedAt: null, createdAt: { gte: runStart } },
        select: { id: true },
        take: 200,
      });
      return rows.map((r) => r.id);
    } catch {
      return [];
    }
  }

  // ─── Dream retention / fast-tier ─────────────────────────────────────────────
  // Evict DEAD dream vectors from the hot per-tenant Qdrant collection so ANN
  // retrieval cost stays bounded as dreams accumulate. SAFE by construction:
  //  - ONLY synthesis rows (the cognition layer's OWN output) — never raw user
  //    memories / ground truth.
  //  - ONLY rows already dead in Postgres: superseded (isLatest=false) OR
  //    soft-deleted (deletedAt set) — these NEVER surface in recall, so purging
  //    their vectors has zero recall impact, pure cost win.
  //  - Past a grace window (rollback safety). Bounded per run.
  // Soft-deleted synthesis rows older than grace are also hard-deleted (reclaim);
  // superseded rows keep their Postgres row for lineage, vector only is purged.
  // @param {{ apply?: boolean }} [opts] apply=false → dry-run count, no mutation.
  async dreamRetentionForOrg(orgId, opts = {}) {
    if (orgId && currentOrg() !== orgId) return runWithOrg(orgId, () => this.dreamRetentionForOrg(orgId, opts)); // residency
    if (!this.prisma?.memory) return { skipped: 'no_prisma' };
    const apply = opts.apply !== false;
    const grace = new Date(Date.now() - RETENTION_GRACE_DAYS * 24 * 3600 * 1000);
    const dead = await this.prisma.memory.findMany({
      where: {
        orgId,
        memoryType: 'synthesis',
        updatedAt: { lt: grace },
        OR: [{ isLatest: false }, { deletedAt: { not: null } }],
      },
      select: { id: true, deletedAt: true },
      orderBy: { updatedAt: 'asc' },
      take: RETENTION_MAX_PER_RUN,
    });
    if (dead.length === 0) return { deadDreams: 0, evicted: 0, hardDeleted: 0, apply };

    if (!apply) return { deadDreams: dead.length, evicted: 0, hardDeleted: 0, apply: false };

    const ids = dead.map((d) => d.id);
    let evicted = 0;
    try { evicted = await purgeVectorsByMemoryIds(ids, orgId, this.logger); }
    catch (err) { this.logger.warn?.(`[cognition] retention purge failed: ${err.message}`); }

    // Reclaim soft-deleted synthesis rows (superseded rows keep lineage).
    let hardDeleted = 0;
    const softIds = dead.filter((d) => d.deletedAt).map((d) => d.id);
    if (softIds.length) {
      try {
        await this.prisma.relationship.deleteMany({
          where: { OR: [{ fromId: { in: softIds } }, { toId: { in: softIds } }] },
        }).catch(() => {});
        const del = await this.prisma.memory.deleteMany({ where: { id: { in: softIds } } });
        hardDeleted = del.count;
      } catch (err) {
        this.logger.warn?.(`[cognition] retention hard-delete failed: ${err.message}`);
      }
    }
    this.logger.log(`[cognition] retention org=${orgId} deadDreams=${dead.length} vectorsPurged=${evicted} rowsHardDeleted=${hardDeleted}`);
    return { deadDreams: dead.length, evicted, hardDeleted, apply: true };
  }

  /**
   * Upsert per-org cognition status row. Restart-safe view of tick history.
   * Non-fatal — DB write failures log a warn but don't break the tick.
   */
  async _persistOrgStatus(orgId, { synth, compact, runMs, error }) {
    if (!this.prisma?.cognitionStatus) return;
    try {
      const now = new Date();
      const nextTickAt = new Date(now.getTime() + this._intervalMs);
      await this.prisma.cognitionStatus.upsert({
        where: { orgId },
        create: {
          orgId,
          lastTickAt: now,
          lastRunMs: runMs,
          lastSynthCount: synth,
          lastCompactCount: compact,
          nextTickAt,
          totalTicks: 1,
          totalSynth: synth,
          totalCompact: compact,
          lastError: error || null,
          lastErrorAt: error ? now : null,
        },
        update: {
          lastTickAt: now,
          lastRunMs: runMs,
          lastSynthCount: synth,
          lastCompactCount: compact,
          nextTickAt,
          totalTicks: { increment: 1 },
          totalSynth: { increment: synth },
          totalCompact: { increment: compact },
          ...(error
            ? { lastError: error, lastErrorAt: now }
            : {}),
        },
      });
    } catch (writeErr) {
      this.logger.warn(`[cognition] status persist failed org=${orgId}: ${writeErr.message}`);
    }
  }

  async _tick() {
    if (_status.running) return;
    _status.running = true;
    const tStart = Date.now();
    try {
      const orgs = await this.prisma.organization.findMany({
        select: { id: true, name: true },
        take: MAX_ORGS_PER_TICK,
        orderBy: { updatedAt: 'desc' },
      });
      let totalSynth = 0;
      let totalCompact = 0;
      let totalPrinciples = 0;
      for (const org of orgs) {
        const orgStart = Date.now();
        try {
          const gate = await this._shouldRunForOrg(org.id);
          if (!gate.run) {
            this.logger.log(`[cognition] org=${org.id} skipped — ${gate.reason}`);
            continue; // no spend, no status update — stay anchored to last real run
          }
          const synthN   = await this.synthesizeForOrg(org.id);
          // Governance scheduler owns compaction cadence; the standalone timer
          // must NOT run destructive compaction (vector purge + isLatest=false)
          // by default to prevent the §10 KB-corruption hazard.
          const compactN = (process.env.COGNITION_TIMER_ALLOW_COMPACTION === 'true')
            ? await this.compactDriftForOrg(org.id)
            : 0;
          // Pass 3 — L2 principle distillation (no-op unless PRINCIPLES_ENABLED)
          const principleN = await this.distillPrinciplesForOrg(org.id);
          totalSynth      += synthN;
          totalCompact    += compactN;
          totalPrinciples += principleN;
          await this._persistOrgStatus(org.id, { synth: synthN, compact: compactN, runMs: Date.now() - orgStart, error: null });
        } catch (perOrgErr) {
          this.logger.warn(`[cognition] org=${org.id} failed: ${perOrgErr.message}`);
          _status.errors = [..._status.errors.slice(-9), { org_id: org.id, error: perOrgErr.message, at: new Date().toISOString() }];
          await this._persistOrgStatus(org.id, { synth: 0, compact: 0, runMs: Date.now() - orgStart, error: perOrgErr.message });
        }
      }
      _status.last_run_at           = new Date().toISOString();
      _status.last_run_ms           = Date.now() - tStart;
      _status.last_synthesis_count  = totalSynth;
      _status.last_compaction_count = totalCompact;
      _status.next_run_at           = new Date(Date.now() + this._intervalMs).toISOString();
      // PHASE-A TODO: add a cognition_status principle counter column (schema
      // change deferred — log-only for now).
      this.logger.log(`[cognition] tick complete orgs=${orgs.length} synth=${totalSynth} compact=${totalCompact} principles=${totalPrinciples} ms=${_status.last_run_ms}`);
    } catch (err) {
      _status.errors = [..._status.errors.slice(-9), { error: err.message, at: new Date().toISOString() }];
      this.logger.error('[cognition] tick failed:', err.message);
    } finally {
      _status.running = false;
      // PHASE D — only self-reschedule when the timer is explicitly re-armed.
      if (process.env.ENABLE_COGNITION_LOOP_TIMER === 'true') {
        this._timer = setTimeout(() => this._tick(), this._intervalMs);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Pass 1 — Synthesis (tag-intersection clustering + bridge detection)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Main synthesis pass for one org:
   *   1. Build tag→members map (tag-intersection clustering)
   *   2. For each cluster ≥ CANONICAL_CLUSTER_MIN → try canonical-fact
   *   3. For top-K tag-pairs with cosine ∈ [SIM_LOW, SIM_HIGH] → try synthesis-bridge
   */
  async synthesizeForOrg(orgId, opts = {}) {
    // Adaptive floor per-org based on corpus density. Small tenants
    // (≤50 fact+decision memories) get floor=3 so they can build
    // synthesis at all; mature tenants stay at floor=6 to keep quality
    // high. Capped at the hard default.
    const clusterMin = await deriveClusterMin(this.prisma, orgId);

    // Cross-project scope (workspace setting): when OFF, bridges/narratives may not
    // connect clusters that span different projects (dreams stay project-local).
    const crossProject = await crossProjectEnabledForOrg(this.prisma, orgId).catch(() => false);
    // Private memories are never eligible merely because an administrator
    // enabled organization cognition. The member must independently opt in.
    // If the additive column is not available during a rolling upgrade, fail
    // closed and synthesize shared material only.
    let personalUserIds = [];
    if (await includePersonalForOrg(this.prisma, orgId).catch(() => false)) {
      personalUserIds = await this.prisma.$queryRawUnsafe(
        `SELECT user_id FROM hivemind.user_organizations
          WHERE org_id = $1::uuid AND is_active = true AND cognition_personal_opt_in = true`,
        orgId,
      ).then((rows) => rows.map((row) => row.user_id)).catch(() => []);
    }

    // Window clamped to the org's cognition_enabled_at anchor — synthesis only
    // ever sees post-enable memory (no backfill). Scheduled runs pass a wide
    // lookbackHours so a nightly dream spans the whole day; continuous early
    // ticks keep the tight 1h rolling window.
    const since = (await this._cognitionWindow(orgId, opts)).since;
    // Structured connector sources: their schema IS already canonical.
    // Re-synthesizing produces tautological canonicals ("OrgFarm owns 16
    // accounts") and trivial bridges ("US contacts share country:usa with
    // US accounts"). Skip them — recall surfaces the records directly.
    const STRUCTURED_SOURCES = [
      'salesforce', 'salesforce-sandbox', 'hubspot', 'pipedrive',
      'github', 'linear', 'jira', 'confluence',
    ];
    let recentRaw;
    if (orgIsRemote(orgId)) {
      // Remote orgs: central has 0 rows — pull the working set from the agent.
      // Exclude existing synthesis outputs (tags carry synthesis:*) and keep only
      // fact/decision; the agent list is the sole source of truth for this org.
      const agentRows = await amrListRecent(orgId, null, 400);
      recentRaw = agentRows
        .filter(r => {
          const mt = r.memory_type || r.memoryType;
          if (!['fact', 'decision'].includes(mt)) return false;
          const tags = r.tags || [];
          if (tags.some(t => ['synthesis:canonical', 'synthesis:bridge', 'canonical-summary', 'synthesized', 'internal-audit', 'governance'].includes(t))) return false;
          return true;
        })
        .map(r => ({
          id:          r.id,
          title:       r.title,
          content:     r.content,
          tags:        r.tags || [],
          memoryType:  r.memory_type || r.memoryType || 'fact',
          userId:      null,
          project:     null,
          createdAt:   r.created_at || r.createdAt,
          sourceMetadata: null,
        }));
    } else {
      recentRaw = await this.prisma.memory.findMany({
        where: {
          orgId,
          createdAt:  { gte: since },
          deletedAt:  null,
          memoryType: { in: ['fact', 'decision'] },
          OR: [
            { visibility: 'organization' },
            ...(personalUserIds.length ? [{ visibility: 'private', userId: { in: personalUserIds } }] : []),
          ],
          // Exclude the governance swarm's OWN output. Reflections + every synthesis
          // tier carry a non-null cognitive_layer_role; without this filter the
          // agents' internal-audit/reflection memories dominate clustering and the
          // only canonical that ever reaches the floor is a tautological
          // "governance (N sources)". This is the cognition layer eating its own
          // exhaust — the single biggest reason synthesis produced no real knowledge.
          cognitiveLayerRole: null,
          // Exclude existing synthesis outputs + governance audit tags from the source pool
          NOT: { tags: { hasSome: ['synthesis:canonical', 'synthesis:bridge', 'canonical-summary', 'synthesized', 'internal-audit', 'governance'] } },
        },
        take: 400,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, title: true, content: true, tags: true,
          memoryType: true, userId: true, project: true, createdAt: true,
          sourceMetadata: { select: { sourcePlatform: true } },
        },
      });
    }
    // Drop memories sourced from structured connectors. They get recalled
    // directly by source_id / entity-tag without synthesis layer.
    const recent = recentRaw.filter((m) => {
      const sp = m.sourceMetadata?.sourcePlatform;
      return !sp || !STRUCTURED_SOURCES.includes(sp);
    });
    if (recent.length < recentRaw.length) {
      this.logger.log(`[cognition] structured-source gate: ${recentRaw.length - recent.length} memories skipped (${STRUCTURED_SOURCES.join(',')})`);
    }

    if (recent.length < clusterMin) return 0;

    // ── Build tag→members buckets (tag-intersection: a memory joins every bucket for each topic tag) ──
    const buckets = new Map(); // tag → Memory[]
    for (const m of recent) {
      const topicTags = (m.tags || []).filter(t => !SYS_TAG_RE.test(t));
      if (topicTags.length === 0) {
        // Fall back to project name so org-level memories aren't orphaned
        const key = m.project || 'untagged';
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(m);
      } else {
        for (const tag of topicTags) {
          if (!buckets.has(tag)) buckets.set(tag, []);
          buckets.get(tag).push(m);
        }
      }
    }

    // Hybrid cluster enrichment (gated, default OFF). Tag buckets above are a
    // purely lexical grouping; recall is hybrid (lexical FTS + vector HNSW), so
    // make clustering hybrid too — pull vector-similar memories from the SAME
    // window into each bucket even when they don't share the tag. Bounded: one
    // hybridSearch per bucket, ≤5 added, window-only (no extra DB fetch).
    if (process.env.COGNITION_HYBRID_CLUSTER !== 'false' && this.engine?.vectorStore?.hybridSearch) {
      const recentById = new Map(recent.map((m) => [m.id, m]));
      for (const [tag, members] of buckets.entries()) {
        if (members.length < 2) continue;
        const have = new Set(members.map((m) => m.id));
        const seed = `${members[0].title || ''} ${(members[0].content || '').slice(0, 200)} ${tag}`.trim();
        let hits = [];
        try {
          hits = await this.engine.vectorStore.hybridSearch(seed, {
            org_id: orgId, is_latest: true, limit: 12,
          }) || [];
        } catch { hits = []; }
        let added = 0;
        for (const h of hits) {
          if (added >= 5) break;
          const id = h.payload?.memory_id || h.id;
          if (!id || have.has(id)) continue;
          const m = recentById.get(id); // enrich only from the window pool
          if (!m) continue;
          members.push(m);
          have.add(id);
          added += 1;
        }
      }
    }

    // ── Mechanism #2: graph-neighborhood reach into OLD memories ──────────────
    // The rolling window makes a cluster see only recent members; an insight that
    // connects "what you said months ago" with "what arrived today" needs the OLD
    // members too. For each ACTIVE cluster (≥2 recent members on a real
    // entity/topic tag — the cross-source join key), pull older memories sharing
    // that exact tag from BEYOND the window, bounded by NEIGHBOR_REACH_MAX.
    // Grounded (same real entity, not cosine coincidence), token-bounded (cap per
    // active cluster; only active clusters expand → dead history never self-dreams),
    // additive to the synthesis member set so canonicals span past + present.
    if (process.env.COGNITION_NEIGHBORHOOD_REACH !== 'false') {
      let reachedTotal = 0;
      for (const [tag, members] of buckets.entries()) {
        // Reach for the cluster's DEFINING tag (the bucket key) — it is already
        // a non-SYS topic tag (clustering filters SYS_TAG_RE, which includes
        // entity:/topic:, so bucket keys are filename:/custom/project tags). That
        // shared tag IS the grounded cross-source join key. Skip only the
        // project-fallback buckets (no real tag to match old against).
        if (members.length < 2) continue;        // only active clusters
        if (tag === 'untagged') continue;        // project-fallback, not a real tag
        const have = new Set(members.map((m) => m.id));
        let older = [];
        if (orgIsRemote(orgId)) {
          // Remote: no central back-catalog. The agent recent list (already loaded
          // as recentRaw) is the working set; skip the separate back-catalog query.
          older = [];
        } else {
          try {
            older = await this.prisma.memory.findMany({
              where: {
                orgId, deletedAt: null,
                createdAt: { lt: since },               // the back-catalog, any age
                tags: { has: tag },                     // the shared entity = grounding
                memoryType: { in: ['fact', 'decision'] },
                cognitiveLayerRole: null,
                NOT: { tags: { hasSome: ['synthesis:canonical', 'synthesis:bridge', 'canonical-summary', 'synthesized', 'internal-audit', 'governance'] } },
              },
              orderBy: [{ importanceScore: 'desc' }, { createdAt: 'desc' }],
              take: NEIGHBOR_REACH_MAX,
              select: {
                id: true, title: true, content: true, tags: true,
                memoryType: true, userId: true, project: true, createdAt: true,
                sourceMetadata: { select: { sourcePlatform: true } },
              },
            });
          } catch { older = []; }
        }
        for (const m of older) {
          if (have.has(m.id)) continue;
          const sp = m.sourceMetadata?.sourcePlatform;
          if (sp && STRUCTURED_SOURCES.includes(sp)) continue; // structured = self-canonical
          members.push(m); have.add(m.id); reachedTotal += 1;
        }
      }
      if (reachedTotal) this.logger.log(`[cognition] neighborhood reach: pulled ${reachedTotal} older memor${reachedTotal === 1 ? 'y' : 'ies'} into active clusters (past+present)`);
    }

    let writes = 0;

    // ── Sub-pass A: canonical-fact per qualifying cluster ─────────────────────
    for (const [tag, members] of buckets.entries()) {
      if (members.length < clusterMin) continue;
      const hash = clusterHash(`canonical:${tag}`);

      // Phase 2 — look for an existing synthesis on this cluster hash
      const existingSynth = await this.prisma.memory.findFirst({
        where: {
          orgId,
          synthesisClusterHash: hash,
          isLatest: true,
          deletedAt: null,
        },
        select: {
          id: true, content: true, title: true, updatedAt: true,
          synthesisConfidence: true, synthesisEvidenceIds: true, synthesisRevision: true,
        },
      });

      members.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      const promptMembers = members.slice(0, DEFAULT_CLUSTER_MAX);

      if (existingSynth) {
        // Identify source memories created AFTER the last synthesis update
        const newMemories = members.filter(
          m => m.createdAt && new Date(m.createdAt) > new Date(existingSynth.updatedAt)
        );

        if (newMemories.length > 0) {
          // Bump dirty count so cluster-index reflects new evidence found this tick
          await this.clusterIndex.bumpDirty({
            organizationId: orgId,
            userId: members[0].userId,
            clusterHash: hash,
            clusterType: 'canonical-fact',
            by: newMemories.length,
          });
          // Phase 2: delta-update path
          try {
            const decision = await this._maybeDeltaUpdate({
              orgId, userId: members[0].userId, project: members[0].project,
              sourceType: 'canonical-fact', tag, hash,
              existing: existingSynth,
              newMemories,
              allMembers: members,
            });
            if (decision && decision !== 'irrelevant') writes++;
            this.logger.log(`[cognition] canonical tag=${tag} delta=${decision}`);
          } catch (err) {
            this.logger.warn(`[cognition] canonical delta tag=${tag} failed: ${err.message}`);
          }
        } else {
          // No new evidence and synthesis exists — skip if within cooldown
          if (await this._onCooldown(orgId, hash)) continue;
        }
        continue; // existing synthesis handled (either delta or cooldown skip)
      }

      // No existing synthesis — full cooldown check then fresh synthesis
      if (await this._onCooldown(orgId, hash)) continue;
      // Over-dream guard: skip if this entity was already dreamed (any cluster) recently
      if (await this._entityRecentlyDreamed(orgId, tag)) {
        this.logger.log(`[cognition] canonical tag=${tag} — entity dreamed within ${ENTITY_DREAM_COOLDOWN_HOURS}h, skip (over-dream guard)`);
        continue;
      }

      try {
        const result = await this._llmCanonicalFact(tag, promptMembers);
        if (!result) continue;
        if ((result.confidence || 0) < CONFIDENCE_FLOOR) {
          this.logger.log(`[cognition] canonical tag=${tag} confidence=${result.confidence} < floor — dropped`);
          continue;
        }
        // Restatement guard: drop if output is near-verbatim of any single source
        if (this._isRestatement(result.canonical_fact, promptMembers)) {
          this.logger.log(`[cognition] canonical tag=${tag} restatement detected — dropped`);
          continue;
        }
        // Grounding = ALL members the synthesis was built from (including
        // reached past/cross-source members), not just the LLM's self-reported
        // subset. The LLM often omits ids whose facts it nonetheless folded into
        // the canonical (e.g. "founded by X" pulled from an old memory it didn't
        // cite). Under-citing breaks the proof tree (WS4) + retroactive reweight
        // (WS3). Union the prompt set with the LLM hint.
        const _llmEv = (result.supporting_memory_ids || []).filter(id => id);
        const evidenceIds = Array.from(new Set([
          ...promptMembers.map((m) => m.id).filter(Boolean),
          ..._llmEv,
        ]));

        // Duplicate-canonical guard: a memory carrying multiple topic tags
        // (e.g. [url:claude.ai, ai-chat-ingest, from-claude, source:from-claude])
        // joins every per-tag bucket; without this check, a single source
        // set produces N identical canonical-fact memories — one per tag.
        // Skip when ≥80% of evidence overlaps an existing recent canonical
        // for the same user/org (regardless of cluster_hash). The first tag
        // wins; later duplicates short-circuit.
        if (evidenceIds.length > 0) {
          const evidenceSet = new Set(evidenceIds);
          try {
            const recentCanonicals = await this.prisma.memory.findMany({
              where: {
                orgId,
                userId: members[0].userId,
                tags: { has: 'synthesis:canonical' },
                isLatest: true,
                deletedAt: null,
                createdAt: { gte: new Date(Date.now() - 7 * 24 * 3600 * 1000) },
              },
              select: { id: true, title: true, synthesisEvidenceIds: true },
              take: 100,
            });
            for (const ec of recentCanonicals) {
              const otherIds = ec.synthesisEvidenceIds || [];
              if (otherIds.length === 0) continue;
              const overlap = otherIds.filter(id => evidenceSet.has(id)).length;
              const minSize = Math.min(otherIds.length, evidenceIds.length);
              if (minSize > 0 && (overlap / minSize) >= 0.8) {
                this.logger.log(`[cognition] canonical tag=${tag} skipped — evidence set duplicates ${ec.id.slice(0,8)} (${ec.title?.slice(0,40)})`);
                throw new Error('__SKIP_DUPLICATE_CANONICAL__');
              }
            }
          } catch (dupErr) {
            if (dupErr.message === '__SKIP_DUPLICATE_CANONICAL__') continue;
            this.logger.warn(`[cognition] dup-check failed (proceeding): ${dupErr.message}`);
          }
        }

        // C1: serialize per (orgId, clusterHash) so two replicas cannot create the same hash.
        let created;
        try {
          await this.prisma.$transaction(async (tx) => {
            await withGovernanceLock(tx, { orgId, agentName: `synth:${hash}` }, async () => {
              // Re-check under the lock — other replica may have committed by now.
              const alreadyExists = await this.prisma.memory.findFirst({
                where: { orgId, synthesisClusterHash: hash, isLatest: true, deletedAt: null },
                select: { id: true },
              });
              if (alreadyExists) return; // other replica won the race — skip
              created = await this._writeSynthMemory({
                orgId,
                userId:    members[0].userId,
                project:   members[0].project,
                sourceType: 'canonical-fact',
                tag,
                members,
                content:   result.canonical_fact,
                confidence: result.confidence,
                evidenceIds,
                clusterHash: hash,
                extraMeta: {
                  valid_from:      result.valid_from || null,
                  expected_decay:  result.expected_decay || null,
                  supporting_ids:  result.supporting_memory_ids || [],
                },
              });
            });
          }, { timeout: Number(process.env.COGNITION_SYNTH_TXN_TIMEOUT_MS || 10 * 60 * 1000), maxWait: 8000 });
        } catch (lockErr) {
          if (lockErr?.code === 'GOVERNANCE_LOCK_BUSY') {
            this.logger.log?.(`[cognition] synth hash ${hash.slice(0,8)} busy on other replica — skip`);
            continue;
          }
          this.logger.warn(`[cognition] synth hash ${hash.slice(0,8)} failed: ${lockErr?.message || lockErr}`);
          continue;
        }
        if (created) {
          writes++;
          // Register new cluster in cluster_index (Option A: dirty_count=0, tick just created it)
          await this._upsertClusterIndexWithRetry({
            organizationId:    orgId,
            userId:            members[0].userId,
            clusterHash:       hash,
            clusterType:       'canonical-fact',
            topTags:           [tag],
            entityKeys:        deriveEntityKeysFromTags(created.tags),
            latestSynthesisId: created.id,
            latestRevision:    1,
            latestConfidence:  result.confidence,
            evidenceCountTotal: evidenceIds.length,
          });
        }
      } catch (err) {
        this.logger.warn(`[cognition] canonical tag=${tag} failed: ${err.message}`);
      }
    }

    // ── Sub-pass B: synthesis-bridge per qualifying tag-pair ──────────────────
    const tagList = Array.from(buckets.entries())
      .filter(([, members]) => members.length >= 2)
      .map(([tag, members]) => ({ tag, members, centroid: clusterCentroidText(members) }));

    // Build candidate pairs with centroid similarity in [SIM_LOW, SIM_HIGH]
    const bridgeCandidates = [];
    for (let i = 0; i < tagList.length; i++) {
      for (let j = i + 1; j < tagList.length; j++) {
        const a = tagList[i];
        const b = tagList[j];

        // Tags must not co-occur: no memory should share both tags
        const aIds = new Set(a.members.map(m => m.id));
        const bIds = new Set(b.members.map(m => m.id));
        const overlap = [...aIds].filter(id => bIds.has(id)).length;
        if (overlap > 0) continue; // clusters share members → not a bridge candidate

        // Cross-project scope: when off, don't bridge clusters in different projects.
        if (!crossProject && spansMultipleProjects(a.members, b.members)) continue;

        const sim = tokenCosine(a.centroid, b.centroid);
        if (sim < BRIDGE_SIM_LOW || sim > BRIDGE_SIM_HIGH) continue;

        // A2 grounding gate: cosine alone produces coincidental/tautological
        // bridges. Require the two clusters to share ≥ BRIDGE_GROUND_MIN real
        // entities (entity:/person:) — that shared entity IS the actual
        // enterprise connection. No shared entity → not a real bridge → skip.
        const shared = sharedEntityKeys(a.members, b.members);
        if (BRIDGE_GROUND_MIN > 0 && shared.length < BRIDGE_GROUND_MIN) continue;

        bridgeCandidates.push({ a, b, sim, sharedEntities: shared });
      }
    }

    // Sort by similarity (middle of range = most interesting gap to bridge)
    bridgeCandidates.sort((x, y) => {
      const midDist = (v) => Math.abs(v - (BRIDGE_SIM_LOW + BRIDGE_SIM_HIGH) / 2);
      return midDist(x.sim) - midDist(y.sim);
    });

    const topBridges = bridgeCandidates.slice(0, BRIDGE_TOP_K);

    for (const { a, b, sharedEntities } of topBridges) {
      const pairKey = [a.tag, b.tag].sort().join('||');
      const hash    = clusterHash(`bridge:${pairKey}`);

      // Phase 2 — look for existing bridge synthesis on this pair hash
      const existingBridge = await this.prisma.memory.findFirst({
        where: {
          orgId,
          synthesisClusterHash: hash,
          isLatest: true,
          deletedAt: null,
        },
        select: {
          id: true, content: true, title: true, updatedAt: true,
          synthesisConfidence: true, synthesisEvidenceIds: true, synthesisRevision: true,
        },
      });

      const allBridgeMembers = [...a.members, ...b.members];

      if (existingBridge) {
        const newMemories = allBridgeMembers.filter(
          m => m.createdAt && new Date(m.createdAt) > new Date(existingBridge.updatedAt)
        );
        if (newMemories.length > 0) {
          // Bump dirty count for bridge cluster
          await this.clusterIndex.bumpDirty({
            organizationId: orgId,
            userId: a.members[0].userId,
            clusterHash: hash,
            clusterType: 'synthesis-bridge',
            by: newMemories.length,
          });
          try {
            const decision = await this._maybeDeltaUpdate({
              orgId, userId: a.members[0].userId,
              project: a.members[0].project || b.members[0].project || null,
              sourceType: 'synthesis-bridge', tag: pairKey, hash,
              existing: existingBridge,
              newMemories,
              allMembers: allBridgeMembers,
            });
            if (decision && decision !== 'irrelevant') writes++;
            this.logger.log(`[cognition] bridge ${a.tag}||${b.tag} delta=${decision}`);
          } catch (err) {
            this.logger.warn(`[cognition] bridge delta ${a.tag}||${b.tag} failed: ${err.message}`);
          }
        } else {
          if (await this._onCooldown(orgId, hash)) continue;
        }
        continue;
      }

      if (await this._onCooldown(orgId, hash)) continue;

      const aPrompt = a.members.slice(0, 15);
      const bPrompt = b.members.slice(0, 15);

      try {
        const result = await this._llmSynthesisBridge(a.tag, aPrompt, b.tag, bPrompt);
        if (!result) continue;
        if ((result.confidence || 0) < CONFIDENCE_FLOOR) {
          this.logger.log(`[cognition] bridge ${a.tag}||${b.tag} confidence=${result.confidence} < floor — dropped`);
          continue;
        }
        // Restatement guard
        if (this._isRestatement(result.bridge_claim, [...aPrompt, ...bPrompt])) {
          this.logger.log(`[cognition] bridge ${a.tag}||${b.tag} restatement detected — dropped`);
          continue;
        }
        const evidenceIds = [
          ...(result.evidence_a || []).map(e => e.id),
          ...(result.evidence_b || []).map(e => e.id),
        ].filter(id => id);

        // Duplicate-bridge guard: tag-pair clustering produces near-identical
        // bridges when tags only differ in spelling (country:usa vs
        // country:united-states) or when same evidence set co-occurs across
        // multiple tag pairings. Skip when ≥80% of evidence overlaps an
        // existing recent bridge for the same user/org.
        if (evidenceIds.length > 0) {
          const evidenceSet = new Set(evidenceIds);
          try {
            const recentBridges = await this.prisma.memory.findMany({
              where: {
                orgId,
                userId: a.members[0].userId,
                tags: { has: 'synthesis:bridge' },
                isLatest: true,
                deletedAt: null,
                createdAt: { gte: new Date(Date.now() - 7 * 24 * 3600 * 1000) },
              },
              select: { id: true, title: true, synthesisEvidenceIds: true },
              take: 100,
            });
            let skip = false;
            for (const eb of recentBridges) {
              const otherIds = eb.synthesisEvidenceIds || [];
              if (otherIds.length === 0) continue;
              const overlap = otherIds.filter((id) => evidenceSet.has(id)).length;
              const minSize = Math.min(otherIds.length, evidenceIds.length);
              if (minSize > 0 && (overlap / minSize) >= 0.8) {
                this.logger.log(`[cognition] bridge ${a.tag}||${b.tag} skipped — evidence set duplicates ${eb.id.slice(0,8)} (${eb.title?.slice(0,40)})`);
                skip = true;
                break;
              }
            }
            if (skip) continue;
          } catch (dupErr) {
            this.logger.warn(`[cognition] bridge dup-check failed (proceeding): ${dupErr.message}`);
          }
        }

        // C1: serialize per (orgId, clusterHash) so two replicas cannot create the same hash.
        let created;
        try {
          await this.prisma.$transaction(async (tx) => {
            await withGovernanceLock(tx, { orgId, agentName: `synth:${hash}` }, async () => {
              const alreadyExists = await this.prisma.memory.findFirst({
                where: { orgId, synthesisClusterHash: hash, isLatest: true, deletedAt: null },
                select: { id: true },
              });
              if (alreadyExists) return;
              created = await this._writeSynthMemory({
                orgId,
                userId:    a.members[0].userId,
                project:   a.members[0].project || b.members[0].project || null,
                sourceType: 'synthesis-bridge',
                tag:        pairKey,
                members:    allBridgeMembers,
                content:    result.bridge_claim,
                confidence: result.confidence,
                evidenceIds,
                clusterHash: hash,
                extraMeta: {
                  bridge_type:          result.bridge_type || null,
                  actionable_next_step: result.actionable_next_step || null,
                  tag_a: a.tag,
                  tag_b: b.tag,
                  evidence_a: result.evidence_a || [],
                  evidence_b: result.evidence_b || [],
                  grounded_on_entities: sharedEntities || [],
                },
              });
            });
          }, { timeout: Number(process.env.COGNITION_SYNTH_TXN_TIMEOUT_MS || 10 * 60 * 1000), maxWait: 8000 });
        } catch (lockErr) {
          if (lockErr?.code === 'GOVERNANCE_LOCK_BUSY') {
            this.logger.log?.(`[cognition] synth hash ${hash.slice(0,8)} busy on other replica — skip`);
            continue;
          }
          this.logger.warn(`[cognition] synth hash ${hash.slice(0,8)} failed: ${lockErr?.message || lockErr}`);
          continue;
        }
        if (created) {
          writes++;
          // Register bridge cluster in cluster_index
          await this._upsertClusterIndexWithRetry({
            organizationId:    orgId,
            userId:            a.members[0].userId,
            clusterHash:       hash,
            clusterType:       'synthesis-bridge',
            topTags:           [a.tag, b.tag],
            entityKeys:        deriveEntityKeysFromTags(created.tags),
            latestSynthesisId: created.id,
            latestRevision:    1,
            latestConfidence:  result.confidence,
            evidenceCountTotal: evidenceIds.length,
          });
        }
      } catch (err) {
        this.logger.warn(`[cognition] bridge ${a.tag}||${b.tag} failed: ${err.message}`);
      }
    }

    // ── Sub-pass C: multi-cluster NARRATIVE bridge ────────────────────────────
    // A hub entity that appears across ≥ NARRATIVE_MIN_CLUSTERS otherwise-separate
    // clusters is the connective thread of an emergent story. Weave those clusters
    // into ONE narrative (the supermemory "stitched a single thought from facts
    // that arrived over months" pattern). Drift-tolerant hub keys (normalized).
    if (NARRATIVE_BRIDGE_ENABLED && tagList.length >= NARRATIVE_MIN_CLUSTERS) {
      try {
        writes += await this._narrativeBridgePass(orgId, tagList, crossProject);
      } catch (err) {
        this.logger.warn(`[cognition] narrative pass failed: ${err.message}`);
      }
    }

    return writes;
  }

  // ─── Sub-pass C: multi-cluster narrative bridge ──────────────────────────────
  // Groups clusters by a shared NORMALIZED hub entity; for each hub linking
  // ≥ NARRATIVE_MIN_CLUSTERS clusters, weaves them into one grounded narrative.
  // crossProject=false → a hub whose clusters span >1 project is skipped (the
  // emergent narrative stays project-local unless the org enabled cross-project).
  async _narrativeBridgePass(orgId, tagList, crossProject = false) {
    let writes = 0;

    // hub (normalized entity/person key) → set of cluster indices it spans
    const hubMap = new Map();
    tagList.forEach((cl, idx) => {
      const keys = new Set();
      for (const m of cl.members) {
        for (const t of (m.tags || [])) {
          const mm = /^(entity|person):(.+)$/i.exec(t);
          if (!mm) continue;
          const nk = normalizeEntity(mm[2]);
          if (nk) keys.add(`${mm[1].toLowerCase()}:${nk}`);
        }
      }
      for (const k of keys) {
        if (!hubMap.has(k)) hubMap.set(k, new Set());
        hubMap.get(k).add(idx);
      }
    });

    const hubs = [...hubMap.entries()]
      .filter(([, set]) => set.size >= NARRATIVE_MIN_CLUSTERS)
      .map(([key, set]) => ({ key, idxs: [...set] }))
      .sort((x, y) => y.idxs.length - x.idxs.length)
      .slice(0, NARRATIVE_TOP_K);

    for (const hub of hubs) {
      const clusters = hub.idxs.slice(0, NARRATIVE_MAX_CLUSTERS).map((i) => tagList[i]);
      // Cross-project scope: when off, a narrative whose clusters span >1 project
      // is skipped — the emergent story stays project-local.
      if (!crossProject && spansMultipleProjects(...clusters.map((c) => c.members))) continue;
      const clusterTags = clusters.map((c) => c.tag).sort();
      const hash = clusterHash(`narrative:${hub.key}:${clusterTags.join('|')}`);

      // Skip if a narrative already exists on this hub+clusters or on cooldown.
      const existing = await this.prisma.memory.findFirst({
        where: { orgId, synthesisClusterHash: hash, isLatest: true, deletedAt: null },
        select: { id: true },
      });
      if (existing) continue;
      if (await this._onCooldown(orgId, hash)) continue;

      // Bounded member set across the spanned clusters.
      const members = clusters.flatMap((c) => c.members.slice(0, 8));
      if (members.length < NARRATIVE_MIN_CLUSTERS) continue;

      try {
        const result = await this._llmNarrativeBridge(hub.key, clusters);
        if (!result || !result.narrative) continue;
        if ((result.confidence || 0) < CONFIDENCE_FLOOR) {
          this.logger.log(`[cognition] narrative hub=${hub.key} confidence=${result.confidence} < floor — dropped`);
          continue;
        }
        if (this._isRestatement(result.narrative, members)) {
          this.logger.log(`[cognition] narrative hub=${hub.key} restatement — dropped`);
          continue;
        }
        const evidenceIds = (result.supporting_memory_ids || []).filter(Boolean);
        // C1: serialize narrative create per (orgId, clusterHash).
        let created;
        try {
          await this.prisma.$transaction(async (tx) => {
            await withGovernanceLock(tx, { orgId, agentName: `synth:${hash}` }, async () => {
              const alreadyExists = await this.prisma.memory.findFirst({
                where: { orgId, synthesisClusterHash: hash, isLatest: true, deletedAt: null },
                select: { id: true },
              });
              if (alreadyExists) return;
              created = await this._writeSynthMemory({
                orgId,
                userId:  members[0].userId,
                project: members[0].project || null,
                sourceType: 'synthesis-bridge',
                tag: `narrative:${hub.key}`,
                members,
                content: result.narrative,
                confidence: result.confidence,
                evidenceIds,
                clusterHash: hash,
                extraMeta: {
                  narrative: true,
                  hub_entity: hub.key,
                  cluster_tags: clusterTags,
                  bridge_type: result.bridge_type || 'narrative',
                  actionable_next_step: result.actionable_next_step || null,
                },
              });
            });
          }, { timeout: Number(process.env.COGNITION_SYNTH_TXN_TIMEOUT_MS || 10 * 60 * 1000), maxWait: 8000 });
        } catch (lockErr) {
          if (lockErr?.code === 'GOVERNANCE_LOCK_BUSY') {
            this.logger.log?.(`[cognition] synth hash ${hash.slice(0,8)} busy on other replica — skip`);
            continue;
          }
          this.logger.warn(`[cognition] synth hash ${hash.slice(0,8)} failed: ${lockErr?.message || lockErr}`);
          continue;
        }
        if (created) {
          writes++;
          this.logger.log(`[cognition] narrative hub=${hub.key} clusters=${clusters.length} → ${String(created.id).slice(0, 8)}`);
          await this._upsertClusterIndexWithRetry({
            organizationId: orgId, userId: members[0].userId, clusterHash: hash,
            clusterType: 'synthesis-bridge', topTags: clusterTags,
            entityKeys: deriveEntityKeysFromTags(created.tags),
            latestSynthesisId: created.id, latestRevision: 1,
            latestConfidence: result.confidence, evidenceCountTotal: evidenceIds.length,
          });
        }
      } catch (err) {
        this.logger.warn(`[cognition] narrative hub=${hub.key} failed: ${err.message}`);
      }
    }
    return writes;
  }

  // ─── Cooldown check ──────────────────────────────────────────────────────────
  // Returns true if we should SKIP this cluster entirely.
  // Phase 2: we no longer skip if new evidence exists — delta-update path takes
  /**
   * H14: wrap clusterIndex.upsertOnSynthesis with one retry.
   * On failure after both attempts, logs a warn-level message (does NOT crash the tick).
   */
  async _upsertClusterIndexWithRetry(opts) {
    try {
      await this.clusterIndex.upsertOnSynthesis(opts);
    } catch (firstErr) {
      try {
        await this.clusterIndex.upsertOnSynthesis(opts);
      } catch (secondErr) {
        this.logger.warn(
          `[cognition] cluster_index upsert failed for synthesis ${opts.latestSynthesisId} hash ${opts.clusterHash} — will self-heal next full tick: ${secondErr.message}`
        );
      }
    }
  }

  // over instead. Cooldown only skips if updatedAt is within the window AND
  // no source memories are newer than the existing synthesis.
  // cooldownHours defaults to COOLDOWN_HOURS so existing 1-arg callers are
  // unaffected; principle distillation passes PRINCIPLE_COOLDOWN_HOURS.
  async _onCooldown(orgId, hash, cooldownHours = COOLDOWN_HOURS) {
    const cutoff = new Date(Date.now() - cooldownHours * 3600 * 1000);
    const existing = await this.prisma.memory.findFirst({
      where: {
        orgId,
        synthesisClusterHash: hash,
        isLatest: true,
        deletedAt: null,
      },
      select: { id: true, updatedAt: true },
    });
    if (!existing) return false;
    // Only cooldown (skip entirely) if updated recently — delta path will still
    // fire if new evidence has arrived since then, so we let synthesizeForOrg
    // call _maybeDeltaUpdate instead of returning true here.
    return existing.updatedAt >= cutoff;
  }

  // ─── Entity over-dream guard ─────────────────────────────────────────────────
  // Returns true if the cluster's dominant entity/person was already dreamed
  // (folded into ANY latest synthesis carrying that entity) within cooldownHours —
  // even under a different cluster_hash. Prevents the same entity being re-dreamed
  // repeatedly ("overdone"). Only gates entity:/person: tags; topic tags are too
  // broad and would over-suppress legitimately distinct clusters.
  //
  // Drift-tolerant: the comparison is on the NORMALIZED entity key, not the raw
  // tag string. Entity tags are LLM-generated with only prompt-level
  // canonicalization, so the same real entity drifts across spellings ("Solvis",
  // "Solvis GmbH", "solvis-gmbh"). A raw-string match would treat each alias as
  // "never dreamed" and the guard would be silently bypassed. We normalize both
  // sides via entity-normalize.js so aliases collapse to one coverage unit.
  async _entityRecentlyDreamed(orgId, tag, cooldownHours = ENTITY_DREAM_COOLDOWN_HOURS) {
    if (!tag || cooldownHours <= 0) return false;
    const m = /^(entity|person):(.+)$/i.exec(tag);
    if (!m) return false;
    const cutoff = new Date(Date.now() - cooldownHours * 3600 * 1000);

    // Fast path: exact-tag match (GIN-indexed `tags @> ARRAY[tag]`). Catches the
    // common no-drift case without scanning.
    const exact = await this.prisma.memory.findFirst({
      where: {
        orgId, memoryType: 'synthesis', isLatest: true, deletedAt: null,
        updatedAt: { gte: cutoff }, tags: { has: tag },
      },
      select: { id: true },
    });
    if (exact) return true;

    // Drift path: normalize the entity key and compare against the normalized
    // entity/person tags of recent syntheses (bounded — a window's worth of
    // dreams is small). Catches alias spellings the exact match misses.
    const wantKey = normalizeEntity(m[2]);
    if (!wantKey) return false;
    const prefix = m[1].toLowerCase();
    const recent = await this.prisma.memory.findMany({
      where: {
        orgId, memoryType: 'synthesis', isLatest: true, deletedAt: null,
        updatedAt: { gte: cutoff },
      },
      select: { tags: true },
      take: 500,
    });
    const ENT_RE = /^(entity|person):(.+)$/i;
    for (const r of recent) {
      for (const t of (r.tags || [])) {
        const mm = ENT_RE.exec(t);
        if (!mm || mm[1].toLowerCase() !== prefix) continue;
        if (normalizeEntity(mm[2]) === wantKey) return true;
      }
    }
    return false;
  }

  // ─── Restatement guard ────────────────────────────────────────────────────────
  _isRestatement(outputText, sourceMembers) {
    if (!outputText) return false;
    for (const m of sourceMembers) {
      const sim = tokenCosine(outputText, m.content || '');
      if (sim > RESTATEMENT_THRESHOLD) return true;
    }
    return false;
  }

  // ─── Canonical-fact LLM prompt ───────────────────────────────────────────────
  async _llmCanonicalFact(tag, members) {
    const facts = members.map((m, i) => {
      const c  = stripIngestStamp((m.content || '').replace(/\s+/g, ' ')).slice(0, 600);
      const ts = m.createdAt ? new Date(m.createdAt).toISOString().slice(0, 10) : 'unknown-date';
      return `[${m.id}] (recorded ${ts}) ${m.title ? m.title + ' — ' : ''}${c}`;
    }).join('\n');

    const prompt = `You are distilling durable organizational knowledge into a CANONICAL FACT that the system will trust and recall later. Below are ${members.length} memories sharing the tag "${tag}".

GROUNDING — strict (this becomes a trusted memory; hallucination poisons recall):
- Use ONLY information stated in the memories below. Do NOT invent names, numbers, dates, roles, products, or events that are not present in the evidence.
- ${RECORDED_DATE_NOTE}
- Preserve every proper noun EXACTLY as written — people, organizations, products, projects, places, dates. Name the specific entity; NEVER replace a name with "the team", "a person", "the product", "the company".
- If a detail is not supported by the evidence, omit it rather than guess. Every claim must trace to at least one cited [id].

TASK — write the canonical fact this cluster establishes:
- 2–4 sentences. State precisely WHAT is true, WHO is involved (by name), and HOW they relate — roles, decisions, relationships, intentions.
- It must hold across ≥3 of these memories (cite their ids in supporting_memory_ids).
- Durable: the stable truth, not a one-off event detail; should survive ~6 months.
- Richer than any single source — synthesize the relationships, do not copy one memory.

REJECT: vague qualifiers ("is involved with", "is connected to … through …"), unsupported specifics, generic platitudes, bare enumerations ("X and Y and Z").

Memories:
${facts}

Output JSON only:
{ "canonical_fact": "<2-4 grounded sentences naming the real entities>", "entities": ["<every proper noun referenced, verbatim>"], "supporting_memory_ids":[...], "valid_from":"YYYY-MM-DD", "expected_decay":"<what observation would falsify this>", "confidence": 0.0-1.0 }`;

    const raw = await llmWithFallback({
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens:  650,
    }, this.logger);

    if (!raw) return null;
    const parsed = safeParseJSON(raw);
    if (!parsed || !parsed.canonical_fact || parsed.canonical_fact.length < 20) return null;
    return parsed;
  }

  // ─── Synthesis-bridge LLM prompt ────────────────────────────────────────────
  async _llmSynthesisBridge(tagA, membersA, tagB, membersB) {
    const formatCluster = (tag, members) =>
      members.map((m, i) => {
        const c  = stripIngestStamp((m.content || '').replace(/\s+/g, ' ')).slice(0, 400);
        const ts = m.createdAt ? new Date(m.createdAt).toISOString().slice(0, 10) : 'unknown-date';
        return `  [${m.id}] (recorded ${ts}) ${m.title ? m.title + ' — ' : ''}${c}`;
      }).join('\n');

    const prompt = `Cluster A (tag "${tagA}", ${membersA.length} memories):
${formatCluster(tagA, membersA)}

Cluster B (tag "${tagB}", ${membersB.length} memories):
${formatCluster(tagB, membersB)}

These clusters never co-occur. Find the LATENT BRIDGE — causal | temporal_arc | contradiction | enabling_gap.

GROUNDING — strict:
- The bridge must be supported by the actual content of BOTH clusters. Do NOT invent a connection that the evidence does not show. If there is no real bridge, set confidence low.
- Name the specific entities and dates on both sides EXACTLY as written (people, organizations, products, projects). Never use "the team" / "the project" when a name is available.
- ${RECORDED_DATE_NOTE} A shared recorded date is NOT a bridge — reject "same day" links built on it.

REJECT: restatement, "X and Y are connected through Z", generic summary, speculative links with no evidence, any link whose only basis is a shared recorded/ingest date.

Output JSON only:
{ "bridge_type":"causal|temporal_arc|contradiction|enabling_gap", "bridge_claim":"<2-3 sentences naming the entities + dates on both sides, with the grounded mechanism of the link>", "entities":["<proper nouns from both clusters>"], "evidence_a":[{"id":"<uuid>","why":"<short reason grounded in that memory>"}], "evidence_b":[{"id":"<uuid>","why":"<short reason>"}], "confidence": 0.0-1.0, "actionable_next_step":"<one concrete sentence>" }`;

    const raw = await llmWithFallback({
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.15,
      max_tokens:  700,
    }, this.logger);

    if (!raw) return null;
    const parsed = safeParseJSON(raw);
    if (!parsed || !parsed.bridge_claim || parsed.bridge_claim.length < 20) return null;
    return parsed;
  }

  // ─── Multi-cluster narrative bridge LLM ──────────────────────────────────────
  // Weaves ≥3 clusters that all share `hubKey` into ONE emergent narrative. The
  // hub entity is the connective thread; the clusters are events/facts that
  // arrived separately. Output is a single thought, NOT a list or a summary.
  async _llmNarrativeBridge(hubKey, clusters) {
    const blocks = clusters.map((cl, ci) => {
      const lines = cl.members.slice(0, 8).map((m) => {
        const c  = stripIngestStamp((m.content || '').replace(/\s+/g, ' ')).slice(0, 320);
        const ts = m.createdAt ? new Date(m.createdAt).toISOString().slice(0, 10) : 'unknown-date';
        return `    [${m.id}] (recorded ${ts}) ${m.title ? m.title + ' — ' : ''}${c}`;
      }).join('\n');
      return `  Cluster ${ci + 1} (tag "${cl.tag}"):\n${lines}`;
    }).join('\n\n');

    const prompt = `These ${clusters.length} clusters of memories all involve the same entity: "${hubKey}". They were recorded SEPARATELY, at different times, in no particular order, and do NOT otherwise co-occur.

${blocks}

Stitch them into a SINGLE emergent NARRATIVE — the one thought a sharp analyst forms after seeing all of these together, that no single cluster states on its own. This is dot-connecting across time, not a summary.

STRICT GROUNDING (this becomes a trusted memory):
- Use ONLY what the memories state. Do NOT invent facts, dates, numbers, or links. Name "${hubKey}" and every other proper noun + date EXACTLY as written.
- ${RECORDED_DATE_NOTE}
- The narrative must DEPEND on combining ≥2 of the clusters — it cannot be derivable from one alone.
- One coherent thought (3–5 sentences), naming the specific events and how they connect through "${hubKey}".

REJECT (output nothing rather than these): a bulleted list, a per-cluster recap, generic advice, platitudes, anything true for any company, single-cluster restatement.

Output JSON only:
{ "narrative":"<3-5 grounded sentences weaving the clusters into one emergent thought through ${hubKey}>", "bridge_type":"causal|temporal_arc|contradiction|enabling_gap|opportunity|risk", "supporting_memory_ids":["<ids from ≥2 different clusters>"], "confidence":0.0-1.0, "actionable_next_step":"<one concrete sentence>" }`;

    const raw = await llmWithFallback({
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens:  800,
    }, this.logger);

    if (!raw) return null;
    const parsed = safeParseJSON(raw);
    if (!parsed || !parsed.narrative || parsed.narrative.length < 30) return null;
    return parsed;
  }

  // ─── Phase 2: Confidence cap per revision ────────────────────────────────────
  // Prevents overconfidence early in a synthesis's life. The cap loosens as
  // the same claim is reaffirmed across multiple ticks.
  _capConfidence(rawConf, revision, evidenceCount = null) {
    const revCap = revision === 1 ? 0.85
               : revision === 2 ? 0.90
               : revision === 3 ? 0.94
               : 0.98;
    // H12: confidence must be bounded by ACTUAL SUPPORT, not just how many times
    // the synthesis was re-touched. Without this, a synthesis REAFFIRMed 4× on the
    // same 2 sources climbs to 0.98 — false confidence on thin support. The
    // support cap rises with the TRUE evidence total (evidenceCountTotal, which is
    // tracked even though synthesisEvidenceIds is capped at 20 hot ids). The
    // effective cap is the tighter of the two. evidenceCount=null → revision-only
    // (backward compatible).
    let cap = revCap;
    if (Number.isFinite(evidenceCount) && evidenceCount !== null) {
      const supportCap = evidenceCount >= 12 ? 0.98
                       : evidenceCount >= 6 ? 0.94
                       : evidenceCount >= 3 ? 0.90
                       : 0.85;
      cap = Math.min(revCap, supportCap);
    }
    return Math.min(cap, rawConf);
  }

  // ─── WS3: retroactive re-sweep (temper stale syntheses on late contradictions) ─
  /**
   * Backward sweep — the piece the forward 1h-window synthesis can't do.
   *
   * Re-examines syntheses (canonical/bridge/principle) older than
   * STALE_REWEIGHT_DAYS for Contradicts edges that arrived AFTER they were last
   * updated, and tempers their confidence DOWN (forward synthesis only ratchets
   * up). A synthesis that got contradicted weeks later no longer sits at 0.9
   * forever. Deliberately reads beyond the 1h window — scoped ONLY to already-
   * synthesized rows, never first-pass synthesis, so token cost stays bounded
   * (no LLM call: this is a pure edge-count + confidence update).
   *
   * Idempotent + cheap: capped at REWEIGHT_MAX_PER_TICK, oldest-updated first,
   * and touching updatedAt means a tempered row isn't re-picked until it goes
   * stale again. Hysteresis: only tempers when NEW contradictions exist, so a
   * row can't flap.
   *
   * @param {string} orgId
   * @returns {Promise<number>} count tempered
   */
  async reweightStaleForOrg(orgId) {
    if ((process.env.COGNITION_REWEIGHT_ENABLED || 'true').toLowerCase() === 'false') return 0;
    if (!this.prisma?.memory) return 0;
    const staleBefore = new Date(Date.now() - STALE_REWEIGHT_DAYS * 24 * 3600 * 1000);
    let stale = [];
    try {
      stale = await this.prisma.memory.findMany({
        where: {
          orgId,
          isLatest: true,
          deletedAt: null,
          cognitiveLayerRole: { in: ['canonical', 'bridge', 'principle'] },
          updatedAt: { lt: staleBefore },
        },
        orderBy: { updatedAt: 'asc' },
        take: REWEIGHT_MAX_PER_TICK,
        select: { id: true, synthesisConfidence: true, synthesisRevision: true, updatedAt: true, title: true },
      });
    } catch (err) {
      this.logger.warn(`[cognition][reweight] query failed org=${orgId}: ${err.message}`);
      return 0;
    }
    if (!stale.length) return 0;

    let tempered = 0;
    for (const synth of stale) {
      try {
        // Count Contradicts edges that target this synthesis AND arrived after
        // it was last reweighted/written. Those are the "discovered after the
        // fact" contradictions the forward pass never saw.
        const newContradictions = await this.prisma.relationship.count({
          where: {
            toId: synth.id,
            type: 'Contradicts',
            createdAt: { gt: synth.updatedAt },
          },
        });
        if (newContradictions <= 0) continue; // hysteresis — only temper on new evidence

        const prior = synth.synthesisConfidence != null ? synth.synthesisConfidence : 0.7;
        const temperedConf = Math.max(
          REWEIGHT_CONF_FLOOR,
          prior * (1 - REWEIGHT_TEMPER_PER_HIT * newContradictions),
        );
        if (temperedConf >= prior) continue; // never raise here

        await this.prisma.memory.update({
          where: { id: synth.id },
          data: {
            synthesisConfidence: temperedConf,
            synthesisRevision: (synth.synthesisRevision || 1) + 1,
            updatedAt: new Date(),
          },
        });
        tempered += 1;
        this.logger.log(`[cognition][reweight] org=${orgId} tempered ${synth.id.slice(0, 8)} ${prior.toFixed(2)}→${temperedConf.toFixed(2)} (${newContradictions} late contradiction(s))`);
      } catch (err) {
        this.logger.warn(`[cognition][reweight] temper failed id=${synth.id?.slice(0, 8)}: ${err.message}`);
      }
    }
    return tempered;
  }

  // ─── Phase 2: Delta-update existing synthesis with new evidence ───────────────
  /**
   * Called when a cluster hash already has a synthesis memory (isLatest=true)
   * AND source memories have been created AFTER that synthesis was last updated.
   *
   * Asks the LLM whether new evidence REAFFIRMS, EXTENDs, CONTRADICTs, or is
   * IRRELEVANT to the existing claim. DB actions differ per decision:
   *
   *   REAFFIRM  → UPDATE synthesis columns in place (revision++, conf++)
   *   EXTEND    → route new memory through engine, Extends edge to prior
   *   CONTRADICT → route new memory with operator='Updates' (supersedes prior)
   *   IRRELEVANT → no-op
   *
   * Returns: 'reaffirm' | 'extend' | 'contradict' | 'irrelevant' | null (error/skip)
   */
  async _maybeDeltaUpdate({
    orgId, userId, project, sourceType, tag, hash,
    existing,      // Prisma Memory row (must include synthesis cols)
    newMemories,   // source memories created after existing.updatedAt
    allMembers,    // full cluster (for writing new synthesis if needed)
  }) {
    if (!newMemories || newMemories.length === 0) return null;

    // Build delta prompt
    const priorDate = existing.updatedAt
      ? new Date(existing.updatedAt).toISOString().slice(0, 10)
      : 'unknown';
    const priorConf = (existing.synthesisConfidence || 0).toFixed(2);
    const priorRev  = existing.synthesisRevision || 1;

    const newEvidenceText = newMemories.map(m => {
      const ts = m.createdAt ? new Date(m.createdAt).toISOString().slice(0, 10) : 'unknown';
      const c  = stripIngestStamp((m.content || '').replace(/\s+/g, ' ')).slice(0, 500);
      return `[${m.id}] (${ts}) ${m.title ? m.title + ' — ' : ''}${c}`;
    }).join('\n');

    const prompt = `PREVIOUS SYNTHESIS (revision ${priorRev}, confidence ${priorConf}, last_updated ${priorDate}):
  claim: "${(existing.content || '').slice(0, 800)}"
  evidence_ids: [${(existing.synthesisEvidenceIds || []).join(', ')}]

NEW EVIDENCE SINCE ${priorDate} (${newMemories.length} memories):
${newEvidenceText}

Decide ONE of:
  REAFFIRM     — new evidence supports prior claim → bump confidence, append evidence_ids
  EXTEND       — new evidence adds nuance, claim still core-true → expand claim text
  CONTRADICT   — new evidence falsifies → supersede with new claim
  IRRELEVANT   — new evidence not material → skip

Output JSON only:
{
  "decision": "REAFFIRM|EXTEND|CONTRADICT|IRRELEVANT",
  "new_claim": "<updated claim text, or null if REAFFIRM with no text change, or IRRELEVANT>",
  "new_confidence": <0.0-1.0>,
  "rationale": "<one sentence>",
  "evidence_to_add": [<new_memory_ids_that_support_decision>]
}`;

    let parsed;
    try {
      const raw = await llmWithFallback({
        messages:    [{ role: 'user', content: prompt }],
        temperature: 0.10,
        max_tokens:  400,
      }, this.logger);
      parsed = safeParseJSON(raw);
    } catch (err) {
      this.logger.warn(`[cognition] delta-update LLM failed hash=${hash}: ${err.message}`);
      return null;
    }

    if (!parsed || !parsed.decision) {
      this.logger.warn(`[cognition] delta-update bad JSON hash=${hash}`);
      return null;
    }

    const decision = (parsed.decision || '').toUpperCase();
    const llmConf  = typeof parsed.new_confidence === 'number' ? parsed.new_confidence : existing.synthesisConfidence || 0.7;

    this.logger.log(`[cognition] delta-update hash=${hash} decision=${decision} rationale=${parsed.rationale}`);

    if (decision === 'IRRELEVANT') {
      return 'irrelevant';
    }

    if (decision === 'REAFFIRM') {
      const newRev    = (existing.synthesisRevision || 1) + 1;
      // Evidence first — the support total bounds the confidence cap (H12).
      const MAX_HOT_EVIDENCE = 20;
      const merged    = [...(existing.synthesisEvidenceIds || []), ...(parsed.evidence_to_add || [])];
      const dedupe    = [...new Set(merged)];
      const hot       = dedupe.slice(-MAX_HOT_EVIDENCE);
      const evidenceCountTotal = dedupe.length;
      // Confidence: take the higher of prior and LLM output, then add 0.05 bump,
      // then apply the per-revision cap bounded by actual support (evidenceCountTotal).
      const rawConf   = Math.min(0.98, Math.max(existing.synthesisConfidence || 0, llmConf) + 0.05);
      const finalConf = this._capConfidence(rawConf, newRev, evidenceCountTotal);
      // H12: the hot window drops the oldest ids silently — surface it. Full count
      // stays in evidenceCountTotal (→ cluster_index) + now bounds confidence above.
      if (dedupe.length > MAX_HOT_EVIDENCE) {
        this.logger.log?.(`[cognition] REAFFIRM evidence truncated ${dedupe.length}→${MAX_HOT_EVIDENCE} hot (total tracked=${evidenceCountTotal}) ${existing.id.slice(0,8)}`);
      }

      await this.prisma.memory.update({
        where: { id: existing.id },
        data: {
          synthesisConfidence:  finalConf,
          synthesisEvidenceIds: hot,
          synthesisRevision:    newRev,
          updatedAt:            new Date(),
          // If LLM provided a refined claim text keep it; otherwise leave content unchanged
          ...(parsed.new_claim && parsed.new_claim.length > 20
            ? { content: parsed.new_claim, title: existing.title }
            : {}),
        },
      }).catch(err => this.logger.warn(`[cognition] reaffirm update failed: ${err.message}`));

      // Inherit entity:/project:/person:/time:/topic: tags from the NEW evidence
      // memories so reaffirmation grows the synthesis' entity coverage over time.
      try {
        const newEvidence = parsed.evidence_to_add || [];
        if (newEvidence.length > 0) {
          const evidenceMems = await this.prisma.memory.findMany({
            where: { id: { in: newEvidence.slice(0, 20) } },
            select: { tags: true },
          });
          const INHERITED_PREFIXES = ['entity:', 'project:', 'person:', 'organization:', 'location:', 'time:', 'topic:'];
          const inherited = new Set();
          for (const em of evidenceMems) {
            for (const t of (em.tags || [])) {
              if (typeof t === 'string' && INHERITED_PREFIXES.some(p => t.startsWith(p))) inherited.add(t);
            }
          }
          if (inherited.size > 0) {
            const cur = await this.prisma.memory.findUnique({ where: { id: existing.id }, select: { tags: true } });
            const mergedTags = Array.from(new Set([...(cur?.tags || []), ...inherited]));
            await this.prisma.memory.update({ where: { id: existing.id }, data: { tags: mergedTags } });
          }
        }
      } catch (inheritErr) {
        this.logger.warn(`[cognition] REAFFIRM entity-tag inheritance failed: ${inheritErr.message}`);
      }

      // Update cluster-index with latest revision state
      const reaffirmTags = (await this.prisma.memory.findUnique({ where: { id: existing.id }, select: { tags: true } }))?.tags || [];
      await this._upsertClusterIndexWithRetry({
        organizationId:    orgId,
        userId,
        clusterHash:       hash,
        clusterType:       sourceType,
        entityKeys:        deriveEntityKeysFromTags(reaffirmTags),
        latestSynthesisId: existing.id,
        latestRevision:    newRev,
        latestConfidence:  finalConf,
        evidenceCountTotal,
      });

      return 'reaffirm';
    }

    if (decision === 'EXTEND') {
      const newRev    = (existing.synthesisRevision || 1) + 1;
      const claim     = (parsed.new_claim && parsed.new_claim.length > 20)
        ? parsed.new_claim
        : (existing.content || '');

      // Evidence first — support total bounds the confidence cap (H12).
      const MAX_HOT_EVIDENCE = 20;
      const rawEvidenceIds = (parsed.evidence_to_add || []).filter(Boolean);
      const mergedEv = [...(existing.synthesisEvidenceIds || []), ...rawEvidenceIds];
      const dedupeEv = [...new Set(mergedEv)];
      const evidenceIds      = dedupeEv.slice(-MAX_HOT_EVIDENCE);
      const evidenceCountTotal = dedupeEv.length;
      const finalConf = this._capConfidence(llmConf, newRev, evidenceCountTotal);
      if (dedupeEv.length > MAX_HOT_EVIDENCE) {
        this.logger.log?.(`[cognition] EXTEND evidence truncated ${dedupeEv.length}→${MAX_HOT_EVIDENCE} hot (total tracked=${evidenceCountTotal}) ${existing.id.slice(0,8)}`);
      }

      // Route new memory through engine with Extends relationship to existing
      const synthTag = sourceType === 'canonical-fact' ? 'synthesis:canonical' : 'synthesis:bridge';
      const unionedTags = new Set();
      for (const m of allMembers) {
        for (const t of (m.tags || [])) {
          if (typeof t === 'string' && t.length > 0 && !SYS_TAG_RE.test(t)) unionedTags.add(t);
        }
      }
      unionedTags.add('cognition-loop');
      unionedTags.add(synthTag);
      unionedTags.add(`topic:${tag.slice(0, 80)}`);

      const title = sourceType === 'canonical-fact'
        ? `Canonical fact (ext): ${tag.slice(0, 55)} rev${newRev}`
        : `Bridge (ext): ${tag.slice(0, 75)} rev${newRev} [conf=${finalConf.toFixed(2)}]`;

      // H13: demote prior BEFORE creating new revision to prevent transient two-is_latest-true window.
      await this.prisma.memory.update({
        where: { id: existing.id },
        data:  { isLatest: false },
      }).catch(err => this.logger.warn(`[cognition] EXTEND: demote prior isLatest failed: ${err.message}`));
      this.logger.log(`[cognition-loop] EXTEND: demoted prior ${existing.id.slice(0, 8)} isLatest=false (rev ${priorRev} → ${newRev})`);

      try {
        const result = await this.engine.ingestMemory({
          user_id:          userId,
          org_id:           orgId,
          content:          claim,
          title,
          memory_type:      'synthesis',
          tags:             Array.from(unionedTags),
          project:          project || null,
          importance_score: sourceType === 'canonical-fact' ? 0.85 : 0.90,
          source_metadata: {
            source_type: sourceType,
            source_id:   `${sourceType}:${hash}:extend:${Date.now()}`,
            metadata: {
              synthesized_at:         new Date().toISOString(),
              topic:                  tag,
              source_count:           allMembers.length,
              source_ids:             allMembers.map(m => m.id),
              model:                  PRIMARY_SYNTHESIS_MODEL,
              generator:              `cognition-loop.${sourceType}.extend`,
              synthesis_confidence:   finalConf,
              synthesis_cluster_hash: hash,
              delta_decision:         'EXTEND',
              parent_synthesis_id:    existing.id,
            },
          },
          _smart_routed: false,
        });
        const newId = result?.id || result?.memoryId || result?.memory?.id || null;
        if (newId) {
          await this.prisma.memory.update({
            where: { id: newId },
            data: {
              synthesisConfidence:  finalConf,
              synthesisEvidenceIds: evidenceIds,
              synthesisClusterHash: hash,
              synthesisRevision:    newRev,
            },
          }).catch(err => this.logger.warn(`[cognition] extend patch cols failed: ${err.message}`));

          // Inherit entity:/project:/person:/time:/topic: tags from evidence —
          // same logic as fresh-synthesis path. Drives cluster_index.entity_keys.
          try {
            const evidenceMems = await this.prisma.memory.findMany({
              where: { id: { in: evidenceIds.slice(0, 20) } },
              select: { tags: true },
            });
            const INHERITED_PREFIXES = ['entity:', 'project:', 'person:', 'organization:', 'location:', 'time:', 'topic:'];
            const inherited = new Set();
            for (const em of evidenceMems) {
              for (const t of (em.tags || [])) {
                if (typeof t === 'string' && INHERITED_PREFIXES.some(p => t.startsWith(p))) inherited.add(t);
              }
            }
            if (inherited.size > 0) {
              const existingRow = await this.prisma.memory.findUnique({
                where: { id: newId },
                select: { tags: true },
              });
              const mergedTags = Array.from(new Set([...(existingRow?.tags || []), ...inherited]));
              await this.prisma.memory.update({ where: { id: newId }, data: { tags: mergedTags } });
            }
          } catch (inheritErr) {
            this.logger.warn(`[cognition] EXTEND entity-tag inheritance failed: ${inheritErr.message}`);
          }
          const extendTags = (await this.prisma.memory.findUnique({ where: { id: newId }, select: { tags: true } }))?.tags || [];

          // Extends edge: new → existing (new extends the prior)
          await this._applyRelationship({
              id:         crypto.randomUUID(),
              from_id:    newId,
              to_id:      existing.id,
              type:       'Extends',
              confidence: finalConf,
              created_by: 'cognition-loop',
              metadata:   { reason: 'delta_extend', topic: tag, revision: newRev },
          }, { orgId, userId }).catch(() => {});

          // Update cluster-index with new synthesis id and revision
          await this._upsertClusterIndexWithRetry({
            organizationId:    orgId,
            userId,
            clusterHash:       hash,
            clusterType:       sourceType,
            entityKeys:        deriveEntityKeysFromTags(extendTags),
            latestSynthesisId: newId,
            latestRevision:    newRev,
            latestConfidence:  finalConf,
            evidenceCountTotal,
          });
        } else {
          // H13 safety: prior was demoted BEFORE create; create produced no row.
          // Re-promote prior so the cluster is never left with zero is_latest.
          await this.prisma.memory.update({
            where: { id: existing.id },
            data:  { isLatest: true },
          }).catch(err => this.logger.warn(`[cognition] EXTEND: re-promote prior after failed create: ${err.message}`));
          this.logger.warn(`[cognition-loop] EXTEND: create returned no id — re-promoted prior ${existing.id.slice(0, 8)}`);
        }
      } catch (err) {
        this.logger.warn(`[cognition] extend engine.ingestMemory failed: ${err.message}`);
        // Demote happened pre-create; restore prior to is_latest on failure.
        await this.prisma.memory.update({
          where: { id: existing.id },
          data:  { isLatest: true },
        }).catch(() => {});
      }

      return 'extend';
    }

    if (decision === 'CONTRADICT') {
      // New memory supersedes existing — route via engine with operator=Updates.
      // smartIngestRouter's _enrichWithTripleOperator will also detect contradiction
      // and may flip existing.isLatest=false automatically. We force-set it here too
      // so the flip is guaranteed regardless of entity-overlap gating.
      const claim     = (parsed.new_claim && parsed.new_claim.length > 20)
        ? parsed.new_claim
        : (existing.content || '');
      // Evidence first — support total bounds the confidence cap (H12).
      const MAX_HOT_EVIDENCE = 20;
      const rawContrEv = (parsed.evidence_to_add || []).filter(Boolean);
      const mergedContr = [...(existing.synthesisEvidenceIds || []), ...rawContrEv];
      const dedupeContr = [...new Set(mergedContr)];
      const evidenceIds = dedupeContr.slice(-MAX_HOT_EVIDENCE);
      const contrEvidenceCountTotal = dedupeContr.length;
      // CONTRADICT resets revision to 1, capped at 0.85 (rev-1) AND by support.
      const finalConf = this._capConfidence(llmConf, 1, contrEvidenceCountTotal);
      if (dedupeContr.length > MAX_HOT_EVIDENCE) {
        this.logger.log?.(`[cognition] CONTRADICT evidence truncated ${dedupeContr.length}→${MAX_HOT_EVIDENCE} hot (total tracked=${contrEvidenceCountTotal}) ${existing.id.slice(0,8)}`);
      }

      const synthTag = sourceType === 'canonical-fact' ? 'synthesis:canonical' : 'synthesis:bridge';
      const unionedTags = new Set();
      for (const m of allMembers) {
        for (const t of (m.tags || [])) {
          if (typeof t === 'string' && t.length > 0 && !SYS_TAG_RE.test(t)) unionedTags.add(t);
        }
      }
      unionedTags.add('cognition-loop');
      unionedTags.add(synthTag);
      unionedTags.add(`topic:${tag.slice(0, 80)}`);

      const title = sourceType === 'canonical-fact'
        ? `Canonical fact: ${tag.slice(0, 60)} (superseded rev1)`
        : `Bridge: ${tag.slice(0, 80)} (superseded rev1) [conf=${finalConf.toFixed(2)}]`;

      // H13: demote prior BEFORE creating new revision so two is_latest=true rows
      // never exist simultaneously for the same synthesisClusterHash.
      await this.prisma.memory.update({
        where: { id: existing.id },
        data:  { isLatest: false },
      }).catch(err => this.logger.warn(`[cognition] contradict flip isLatest failed: ${err.message}`));

      try {
        const result = await this.engine.ingestMemory({
          user_id:          userId,
          org_id:           orgId,
          content:          claim,
          title,
          memory_type:      'synthesis',
          tags:             Array.from(unionedTags),
          project:          project || null,
          importance_score: sourceType === 'canonical-fact' ? 0.85 : 0.90,
          source_metadata: {
            source_type: sourceType,
            source_id:   `${sourceType}:${hash}:contradict:${Date.now()}`,
            metadata: {
              synthesized_at:         new Date().toISOString(),
              topic:                  tag,
              source_count:           allMembers.length,
              source_ids:             allMembers.map(m => m.id),
              model:                  PRIMARY_SYNTHESIS_MODEL,
              generator:              `cognition-loop.${sourceType}.contradict`,
              synthesis_confidence:   finalConf,
              synthesis_cluster_hash: hash,
              delta_decision:         'CONTRADICT',
              superseded_id:          existing.id,
            },
          },
          // Passing parent_id causes smart-router to attempt Updates operator
          parent_id:     existing.id,
          _smart_routed: false,
        });
        const newId = result?.id || result?.memoryId || result?.memory?.id || null;
        if (newId) {
          await this.prisma.memory.update({
            where: { id: newId },
            data: {
              synthesisConfidence:  finalConf,
              synthesisEvidenceIds: evidenceIds,
              synthesisClusterHash: hash,
              synthesisRevision:    1, // reset on contradiction
            },
          }).catch(err => this.logger.warn(`[cognition] contradict patch cols failed: ${err.message}`));

          // Inherit entity tags from new evidence (fresh narrative claim).
          try {
            const evidenceMems = await this.prisma.memory.findMany({
              where: { id: { in: evidenceIds.slice(0, 20) } },
              select: { tags: true },
            });
            const INHERITED_PREFIXES = ['entity:', 'project:', 'person:', 'organization:', 'location:', 'time:', 'topic:'];
            const inherited = new Set();
            for (const em of evidenceMems) {
              for (const t of (em.tags || [])) {
                if (typeof t === 'string' && INHERITED_PREFIXES.some(p => t.startsWith(p))) inherited.add(t);
              }
            }
            if (inherited.size > 0) {
              const cur = await this.prisma.memory.findUnique({ where: { id: newId }, select: { tags: true } });
              const mergedTags = Array.from(new Set([...(cur?.tags || []), ...inherited]));
              await this.prisma.memory.update({ where: { id: newId }, data: { tags: mergedTags } });
            }
          } catch (inheritErr) {
            this.logger.warn(`[cognition] CONTRADICT entity-tag inheritance failed: ${inheritErr.message}`);
          }
          const contradictTags = (await this.prisma.memory.findUnique({ where: { id: newId }, select: { tags: true } }))?.tags || [];

          // Explicit Updates edge
          await this._applyRelationship({
              id:         crypto.randomUUID(),
              from_id:    newId,
              to_id:      existing.id,
              type:       'Updates',
              confidence: finalConf,
              created_by: 'cognition-loop',
              metadata:   { reason: 'delta_contradict', topic: tag },
          }, { orgId, userId }).catch(() => {});

          // Update cluster-index: new synthesis row, revision reset to 1
          await this._upsertClusterIndexWithRetry({
            organizationId:    orgId,
            userId,
            clusterHash:       hash,
            clusterType:       sourceType,
            entityKeys:        deriveEntityKeysFromTags(contradictTags),
            latestSynthesisId: newId,
            latestRevision:    1,
            latestConfidence:  finalConf,
            evidenceCountTotal: contrEvidenceCountTotal,
          });
        } else {
          // H13 safety: prior demoted pre-create, create produced no row — re-promote.
          await this.prisma.memory.update({
            where: { id: existing.id },
            data:  { isLatest: true },
          }).catch(err => this.logger.warn(`[cognition] CONTRADICT: re-promote prior after failed create: ${err.message}`));
          this.logger.warn(`[cognition-loop] CONTRADICT: create returned no id — re-promoted prior ${existing.id.slice(0, 8)}`);
        }
      } catch (err) {
        this.logger.warn(`[cognition] contradict engine.ingestMemory failed: ${err.message}`);
        await this.prisma.memory.update({
          where: { id: existing.id },
          data:  { isLatest: true },
        }).catch(() => {});
      }

      return 'contradict';
    }

    return null;
  }

  // ─── Write synthesis memory via engine gateway ───────────────────────────────
  /**
   * Routes through engine.ingestMemory (canonical gateway) with
   * _smart_routed: false so smartIngestRouter fires:
   * operator inference + entity-co-mention + conflict-detector all execute.
   *
   * IMPORTANT: _smart_routed: false is the correct opt-in flag — it tells the
   * gateway that this payload has NOT already been smart-routed and the router
   * SHOULD run on it. Do NOT pass smartIngest: false (that would skip routing).
   */
  async _writeSynthMemory({
    orgId, userId, project, sourceType, tag, members, content,
    confidence, evidenceIds = [], clusterHash: hash, extraMeta = {},
  }) {
    // Phase A: explicit 3-way (principle | canonical-fact | bridge). Additive —
    // canonical/bridge output is byte-identical to prior behaviour.
    const synthTag = sourceType === 'principle'
      ? 'synthesis:principle'
      : sourceType === 'canonical-fact'
        ? 'synthesis:canonical'
        : 'synthesis:bridge';

    // Collect UNION of topic tags from all source members (inherits routing oracles)
    const unionedTags = new Set();
    for (const m of members) {
      for (const t of (m.tags || [])) {
        if (typeof t === 'string' && t.length > 0 && !SYS_TAG_RE.test(t)) {
          unionedTags.add(t);
        }
      }
    }
    unionedTags.add('cognition-loop');
    unionedTags.add(synthTag);
    unionedTags.add(`topic:${tag.slice(0, 80)}`);
    // M2: mark cross-project syntheses so recall can filter them when the org
    // later disables cross-project dreaming (tag persisted, no migration needed).
    if (spansMultipleProjects(members)) {
      unionedTags.add('scope:cross-project');
    }
    if (sourceType === 'principle') {
      unionedTags.add(`principle:${slugify(tag)}`);
    }

    const title = sourceType === 'principle'
      ? `Principle: ${tag.slice(0, 60)} [conf=${confidence?.toFixed(2)}]`
      : sourceType === 'canonical-fact'
        ? `Canonical fact: ${tag.slice(0, 60)} (${members.length} sources)`
        : `Bridge: ${tag.slice(0, 80)} [conf=${confidence?.toFixed(2)}]`;

    // Remote orgs: engine.ingestMemory + prisma.memory.count both write/read central tables
    // that hold 0 rows for self-host orgs. Force _directInsert (now agent-routed) and skip
    // the central visibility probe (default 'private' is the safe fallback for remote).
    if (orgIsRemote(orgId)) {
      return this._directInsert({ orgId, userId, project, sourceType, tag, members, content, confidence, evidenceIds, hash, title, unionedTags, extraMeta, visibility: 'private' });
    }

    // Inherit visibility conservatively: an org-wide canonical ONLY when EVERY
    // source is org-visible — never fold a user's private memory into a memory
    // the whole org can recall. Default private. Without this, all synthesis was
    // born private-to-the-author and never surfaced for other org members.
    let synthVisibility = 'private';
    try {
      const ids = members.map(m => m.id).filter(Boolean);
      if (ids.length) {
        const nonOrg = await this.prisma.memory.count({
          where: { id: { in: ids }, NOT: { visibility: 'organization' } },
        });
        if (nonOrg === 0) synthVisibility = 'organization';
      }
    } catch { /* default private — fail safe */ }

    // Use engine.ingestMemory so smart-routing fires (operator, entity-co-mention, conflict-detector)
    if (!this.engine) {
      // Engine not wired → fall back to direct prisma insert (preserves synthesis columns)
      return this._directInsert({ orgId, userId, project, sourceType, tag, members, content, confidence, evidenceIds, hash, title, unionedTags, extraMeta, visibility: synthVisibility });
    }

    try {
      // IMPORTANT: graph-engine._buildMemoryRecord reads snake_case field names
      // (user_id, org_id, memory_type, importance_score). Passing camelCase will
      // silently result in undefined fields and a Prisma rejection.
      // source_metadata must be an object matching { source_type, source_id, ... }.
      let finalTags = Array.from(unionedTags);
      const cognitiveLayerRole = sourceType === 'principle'
        ? 'principle'
        : sourceType === 'canonical-fact'
          ? 'canonical'
          : 'bridge';
      const importanceScore = sourceType === 'principle'
        ? 0.92
        : sourceType === 'canonical-fact'
          ? 0.85
          : 0.90;
      const result = await this.engine.ingestMemory({
        user_id:         userId,
        org_id:          orgId,
        content,
        title,
        memory_type:     'synthesis',
        tags:            Array.from(unionedTags),
        project:         project || null,
        importance_score: importanceScore,
        cognitive_layer_role: cognitiveLayerRole,
        visibility:       synthVisibility,
        source_metadata: {
          source_type: sourceType,
          source_id:   `${sourceType}:${hash}:${Date.now()}`,
          metadata: {
            synthesized_at:         new Date().toISOString(),
            topic:                  tag,
            source_count:           members.length,
            source_ids:             members.map(m => m.id),
            model:                  PRIMARY_SYNTHESIS_MODEL,
            generator:              `cognition-loop.${sourceType}`,
            synthesis_confidence:   confidence,
            synthesis_cluster_hash: hash,
            ...extraMeta,
          },
        },
        // _smart_routed: false → run smart-ingest-router (operator + entity-co-mention + conflict-detector)
        _smart_routed: false,
      });

      const newId = result?.id || result?.memoryId || result?.memory?.id || null;

      // Patch synthesis columns directly (engine may not forward unknown fields)
      if (newId) {
        await this.prisma.memory.update({
          where: { id: newId },
          data: {
            synthesisConfidence:  confidence,
            synthesisEvidenceIds: evidenceIds,
            synthesisClusterHash: hash,
            synthesisRevision:    1,
          },
        }).catch(err => this.logger.warn(`[cognition] patch synthesis cols failed: ${err.message}`));

        // Inherit entity:/project:/person:/time: tags from evidence memories.
        // The entity-co-mention LLM consistently returns entities=[] on dense
        // synthesis prose (abstract claims don't trigger proper-noun heuristics
        // reliably). Synthesis is derivative — its entities = union of source
        // memory entities. Cheaper + more accurate than re-running LLM.
        // Drives cluster_index.entity_keys + crossClusterEntityBoost match rate.
        try {
          const evidenceMems = await this.prisma.memory.findMany({
            where: { id: { in: evidenceIds.slice(0, 20) } },
            select: { tags: true },
          });
          const INHERITED_PREFIXES = ['entity:', 'project:', 'person:', 'organization:', 'location:', 'time:', 'topic:'];
          const inherited = new Set();
          for (const em of evidenceMems) {
            for (const t of (em.tags || [])) {
              if (typeof t !== 'string') continue;
              if (INHERITED_PREFIXES.some(p => t.startsWith(p))) inherited.add(t);
            }
          }
          if (inherited.size > 0) {
            const existing = await this.prisma.memory.findUnique({
              where: { id: newId },
              select: { tags: true },
            });
            const mergedTags = Array.from(new Set([
              ...(existing?.tags || []),
              ...inherited,
            ]));
            await this.prisma.memory.update({
              where: { id: newId },
              data: { tags: mergedTags },
            });
            finalTags = mergedTags;
            this.logger.log?.(`[cognition] inherited ${inherited.size} entity/topic tags from ${evidenceMems.length} evidence → synthesis ${newId.slice(0, 8)}`);
          } else {
            const existing = await this.prisma.memory.findUnique({
              where: { id: newId },
              select: { tags: true },
            });
            finalTags = existing?.tags || Array.from(unionedTags);
          }
        } catch (inheritErr) {
          this.logger.warn(`[cognition] entity-tag inheritance failed: ${inheritErr.message}`);
        }

        // Derives edges to evidence sources
        await this._linkDerivesEdges(newId, members, sourceType, tag, { orgId, userId });
      }

      if (newId) await this._embedSynthMemory({ id: newId, userId, orgId, project, title, content, tags: finalTags, sourceType, visibility: synthVisibility });
      return newId ? { id: newId, tags: finalTags } : null;
    } catch (err) {
      this.logger.warn(`[cognition] engine.ingestMemory failed (${err.message}), falling back to direct insert`);
      return this._directInsert({ orgId, userId, project, sourceType, tag, members, content, confidence, evidenceIds, hash, title, unionedTags, extraMeta, visibility: synthVisibility });
    }
  }

  // Direct Prisma insert fallback (used when engine not available or throws).
  // For remote orgs, routes through amrWrite (agent outbox) instead of central Prisma.
  async _directInsert({ orgId, userId, project, sourceType, tag, members, content, confidence, evidenceIds, hash, title, unionedTags, extraMeta, visibility = 'private' }) {
    if (orgIsRemote(orgId)) {
      // Embed centrally (bge-m3 via factory), then push to agent — no central Prisma row.
      let vec = null;
      try {
        const { getEmbedService } = await import('../embeddings/factory.js');
        vec = await getEmbedService().embedOne(`${title}\n${content}`).catch(() => null);
      } catch { /* embedding failure is non-fatal — agent stores without vector */ }
      const id = crypto.randomUUID();
      const cognitiveLayerRole = sourceType === 'principle'
        ? 'principle'
        : sourceType === 'canonical-fact'
          ? 'canonical'
          : 'bridge';
      await amrWrite(orgId, {
        id,
        orgId,
        userId,
        content,
        title,
        tags:              Array.from(unionedTags),
        memoryType:        'synthesis',
        isLatest:          true,
        layer:             'cognitive',
        cognitiveLayerRole,
        confidence,
        createdAt:         new Date().toISOString(),
        project:           project || null,
        projectIds:        [],
      }, vec, []);
      await this._linkDerivesEdges(id, members, sourceType, tag, { orgId, userId });
      return { id };
    }

    const created = await this.prisma.memory.create({
      data: {
        id:                  crypto.randomUUID(),
        userId,
        orgId,
        project:             project || null,
        memoryType:          'synthesis',
        title,
        content,
        tags:                Array.from(unionedTags),
        isLatest:            true,
        visibility,
        importanceScore:     sourceType === 'principle' ? 0.92 : sourceType === 'canonical-fact' ? 0.85 : 0.90,
        // Set cognitive_layer_role on EVERY synthesis tier (mirrors the engine
        // path). Previously canonical/bridge were left null and "relied on the
        // column default" — but there is no default, so the role-keyed recall
        // boost (principle ×1.7 > canonical ×1.6 > bridge ×1.4) and the
        // memories_principle_role_idx partial index never fired for them.
        cognitiveLayerRole: sourceType === 'principle'
          ? 'principle'
          : sourceType === 'canonical-fact'
            ? 'canonical'
            : 'bridge',
        synthesisConfidence: confidence,
        synthesisEvidenceIds: evidenceIds,
        synthesisClusterHash: hash,
        synthesisRevision:   1,
        sourceMetadata: {
          create: {
            sourceType,
            sourceId:  `${sourceType}:${hash}:${Date.now()}`,
            metadata: {
              synthesized_at:         new Date().toISOString(),
              topic:                  tag,
              source_count:           members.length,
              source_ids:             members.map(m => m.id),
              model:                  PRIMARY_SYNTHESIS_MODEL,
              generator:              `cognition-loop.${sourceType}`,
              synthesis_confidence:   confidence,
              synthesis_cluster_hash: hash,
              ...extraMeta,
            },
          },
        },
      },
      select: { id: true },
    }).catch(err => {
      this.logger.warn(`[cognition] direct insert failed: ${err.message}`);
      return null;
    });

    if (created) {
      await this._linkDerivesEdges(created.id, members, sourceType, tag, { orgId, userId });
      await this._embedSynthMemory({ id: created.id, userId, orgId, project, title, content, tags: Array.from(unionedTags), sourceType, visibility });
    }
    return created;
  }

  // Embed + upsert a synthesis memory into the per-tenant Qdrant collection.
  // _writeSynthMemory persists to Postgres only (engine.ingestMemory does not
  // embed the new row; _directInsert is a raw prisma.create), so canonical /
  // bridge / principle were born with ZERO vectors and never entered the vector
  // candidate pool — the whole synthesis tier was invisible to recall. Mirror
  // the Stage-2 fix already applied to compaction summaries. storeMemory embeds
  // the content when no vector is supplied and routes by org_id to org_<id>.
  async _embedSynthMemory({ id, userId, orgId, project, title, content, tags, sourceType, visibility = 'private' }) {
    if (!id) return;
    // this.engine.vectorStore is null on the cron-constructed loop (qdrant is
    // injected onto the server's engine instance, not reliably visible here), so
    // fall back to the qdrant singleton the server itself uses (same instance).
    const vs = this.engine?.vectorStore || getQdrantClient();
    if (!vs?.storeMemory) {
      this.logger.warn?.(`[cognition] synth embed skipped — no qdrant client for ${id}`);
      return;
    }
    const role = sourceType === 'principle' ? 'principle'
      : sourceType === 'canonical-fact' ? 'canonical' : 'bridge';
    const importanceScore = sourceType === 'principle' ? 0.92
      : sourceType === 'canonical-fact' ? 0.85 : 0.90;
    try {
      await vs.storeMemory({
        id, user_id: userId, org_id: orgId, project: project || null,
        memory_type: 'synthesis', title, content, tags: tags || [],
        is_latest: true, importance_score: importanceScore,
        cognitive_layer_role: role, visibility,
        created_at: new Date().toISOString(), source: 'cognition-loop',
      });
      this.logger.log?.(`[cognition] embedded ${sourceType} synth ${String(id).slice(0, 8)}`);
    } catch (err) {
      this.logger.warn(`[cognition] synth embed failed: ${err.message}`);
    }
  }

  // Persist a bounded set of strongest provenance edges. The synthesis memory
  // retains the complete evidence-id list; graph traversal needs a sparse,
  // useful neighbourhood rather than hundreds of equivalent spokes.
  async _linkDerivesEdges(synthId, members, sourceType, tag, { orgId = currentOrg(), userId = null } = {}) {
    const confidence = sourceType === 'canonical-fact' ? 0.88 : 0.82;
    const sourceIds = members
      .filter(src => src?.id)
      .sort((a, b) => Number(b.importanceScore || b.importance_score || b.confidence || 0)
        - Number(a.importanceScore || a.importance_score || a.confidence || 0))
      .slice(0, 10)
      .map(src => src.id);
    if (sourceIds.length) await this._applyRelationship({
      source_ids: sourceIds,
      to_id: synthId,
      type: 'Derives',
      confidence,
      created_by: 'cognition-loop',
      metadata: { reason: sourceType, topic: tag, source_count: members.length, persisted_source_count: sourceIds.length },
    }, { orgId, userId });
    // Do not add synthesis-to-synthesis edges merely because their evidence
    // sets overlap. Traversal can meet at the shared source nodes.
  }

  /**
   * WS4 — link this synthesis to prior syntheses it depends on (shared evidence).
   * @param {string} synthId
   * @param {string[]} evidenceIds  source memory ids this synthesis was built on
   * @param {string} sourceType     'canonical-fact' | 'bridge' | 'principle'
   * @param {string} tag
   */
  async _linkCrossSynthesisEdges(synthId, evidenceIds, sourceType, tag, { orgId = currentOrg(), userId = null } = {}) {
    if (!Array.isArray(evidenceIds) || evidenceIds.length === 0) return;
    // Find OTHER latest syntheses whose evidence overlaps ours.
    const overlapping = await this.prisma.memory.findMany({
      where: {
        id: { not: synthId },
        isLatest: true,
        deletedAt: null,
        cognitiveLayerRole: { in: ['canonical', 'bridge', 'principle'] },
        synthesisEvidenceIds: { hasSome: evidenceIds },
      },
      select: { id: true, cognitiveLayerRole: true },
      take: 5,
    });
    for (const other of overlapping) {
      // principle generalizes canonicals → Implies; everything else → depends_on.
      const kind = sourceType === 'principle' ? 'implies' : 'depends_on';
      try {
        await this._applyRelationship({
            id:         crypto.randomUUID(),
            from_id:    other.id,
            to_id:      synthId,
            type:       'Derives',
            confidence: 0.75,
            created_by: 'cross-synthesis',
            metadata:   { kind, reason: sourceType, topic: tag },
        }, { orgId, userId });
      } catch { /* unique (from,to,Derives) dup — skip */ }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Pass 2 — Drift compaction (lossless, unchanged logic from prior version)
  // ═══════════════════════════════════════════════════════════════════════════

  async compactDriftForOrg(orgId) {
    const recent = await this.prisma.memory.findMany({
      where: {
        orgId,
        isLatest:   true,
        deletedAt:  null,
        memoryType: { in: ['fact', 'decision'] },
        // Exclude the governance swarm's own reflection/audit output (same gate as
        // synthesizeForOrg). Without it, compaction folds 300 internal-audit/
        // reflection rows into junk "Canonical: governance (N memories)" and
        // supersedes them. cognitive_layer_role is non-null on every reflection +
        // synthesis tier; real fact/decision memories have it null.
        cognitiveLayerRole: null,
        NOT: { tags: { hasSome: ['internal-audit', 'governance', 'synthesis:canonical', 'synthesis:bridge', 'canonical-summary', 'synthesized'] } },
      },
      take: 500,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true, userId: true, title: true, content: true, tags: true,
        project: true, createdAt: true, updatedAt: true,
      },
    });
    if (recent.length < DRIFT_COMPACT_THRESHOLD) return 0;

    const buckets = new Map();
    for (const m of recent) {
      // Use module-level SYS_TAG_RE (superset incl. time:/ts:) so compaction
      // buckets match synthesis bucketing exactly — one source of truth.
      const primaryTag = (m.tags || []).find(t => !SYS_TAG_RE.test(t));
      if (!primaryTag) continue;
      if (!buckets.has(primaryTag)) buckets.set(primaryTag, []);
      buckets.get(primaryTag).push(m);
    }

    let compactions = 0;
    for (const [tag, members] of buckets.entries()) {
      if (members.length < DRIFT_COMPACT_THRESHOLD) continue;
      const sorted = members.slice().sort(
        (a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0)
      );
      const chunks = [];
      for (let i = 0; i < sorted.length; i += MAX_MEMBERS_PER_CANONICAL) {
        chunks.push(sorted.slice(i, i + MAX_MEMBERS_PER_CANONICAL));
      }
      for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];
        try {
          const content = await this._buildLosslessSummary(tag, chunk, { partIndex: ci, partCount: chunks.length });
          if (!content || content.length < 20) continue;
          const created = await this._writeSummaryMemory({
            orgId, userId: chunk[0].userId, project: chunk[0].project,
            tag, members: chunk, content, partIndex: ci, partCount: chunks.length,
          });
          if (!created) continue;
          await this._applyRelationship({
            source_ids: chunk.map(src => src.id),
            to_id: created.id,
            type: 'Derives',
            confidence: 0.9,
            created_by: 'cognition-drift-compact',
            metadata: { reason: 'drift_compaction', topic: tag, part: ci + 1, parts: chunks.length },
          }, { orgId, userId: chunk[0].userId });

          // P3: demote folded sources + purge their vectors. The summary is
          // lossless (every source embedded verbatim) so this is zero info
          // loss — it just stops the same fragments requalifying into the
          // 500-row pool forever (compaction starvation, failure-mode #1) and
          // stops them polluting ANN recall. DB rows survive (isLatest=false)
          // for time-travel; only the Qdrant points and the default-view flag
          // are removed. supersedesId points at the canonical for lineage.
          const foldedIds = chunk.map(s => s.id);
          try {
            await this.prisma.memory.updateMany({
              where: { id: { in: foldedIds } },
              data:  { isLatest: false, supersedesId: created.id },
            });
            const purged = await purgeVectorsByMemoryIds(foldedIds, orgId, this.logger);
            this.logger.log(`[cognition-loop] drift-compact tag=${tag} part=${ci + 1}/${chunks.length}: folded ${foldedIds.length} → ${created.id.slice(0, 8)}, demoted+purged ${purged} vectors`);
          } catch (demoteErr) {
            this.logger.warn(`[cognition] drift-compact demote/purge failed tag=${tag}: ${demoteErr.message}`);
          }
          compactions++;
        } catch (err) {
          this.logger.warn(`[cognition] compact tag=${tag} part=${ci + 1}/${chunks.length} failed: ${err.message}`);
        }
      }
    }
    return compactions;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Pass 3 — L2 principle distillation (Phase A, flag-gated PRINCIPLES_ENABLED)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Distill transferable PRINCIPLES (the L2 tier) from clusters of durable
   * memories. A principle is a domain-general "if/then" or normative rule that
   * generalises beyond any single fact — distinct from canonical-fact (one
   * concrete durable fact) and bridge (a latent cross-cluster connection).
   *
   * Reuses the synthesis storage table via _writeSynthMemory(sourceType:
   * 'principle'). Additive: returns 0 immediately when the flag is OFF, so the
   * default-OFF deployment is byte-identical to prior behaviour.
   *
   * @param {string} orgId
   * @returns {Promise<number>} number of principle memories written this tick
   */
  async distillPrinciplesForOrg(orgId) {
    if (!PRINCIPLES_ENABLED) return 0;

    try {
    const candidates = await this.prisma.memory.findMany({
      where: {
        orgId,
        isLatest: true,
        deletedAt: null,
        memoryType: { in: ['fact', 'decision', 'lesson', 'summary'] },
        // Exclude the governance swarm's own reflection/audit output (same gate as
        // synthesizeForOrg). Without it, principle distillation emits junk
        // "Principle: governance/internal-audit/reflection" units.
        cognitiveLayerRole: null,
        NOT: { tags: { hasSome: ['synthesis:principle', 'internal-audit', 'governance', 'synthesis:canonical', 'synthesis:bridge', 'canonical-summary', 'synthesized'] } },
      },
      take: 500,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true, userId: true, title: true, content: true, tags: true,
        project: true, createdAt: true, updatedAt: true, cognitiveLayerRole: true,
      },
    });
    if (candidates.length < PRINCIPLE_CLUSTER_MIN) return 0;

    // Bucket by topic tag (tag-intersection), excluding system tags.
    const buckets = new Map(); // tag → Memory[]
    for (const m of candidates) {
      const topicTags = (m.tags || []).filter(t => !SYS_TAG_RE.test(t));
      for (const tag of topicTags) {
        if (!buckets.has(tag)) buckets.set(tag, []);
        buckets.get(tag).push(m);
      }
    }

    // Cross-project scope: mirror the bridge/narrative path — when cross-project
    // dreaming is OFF, skip principle buckets whose members span multiple projects.
    const crossProject = await crossProjectEnabledForOrg(this.prisma, orgId).catch(() => false);

    let writes = 0;
    for (const [tag, members] of buckets.entries()) {
      if (writes >= PRINCIPLE_TOP_K) break;                 // cap writes per tick
      if (members.length < PRINCIPLE_CLUSTER_MIN) continue;
      if (!crossProject && spansMultipleProjects(members)) continue;

      const hash = clusterHash(`principle:${tag}`);

      // Existing-principle guard (mirror canonical sub-pass): if a principle
      // synthesis already exists on this hash, only proceed when NEW evidence
      // arrived after it; otherwise respect the (longer) principle cooldown.
      const existingPrinciple = await this.prisma.memory.findFirst({
        where: { orgId, synthesisClusterHash: hash, isLatest: true, deletedAt: null },
        select: { id: true, updatedAt: true },
      });
      if (existingPrinciple) {
        const hasNewEvidence = members.some(
          m => m.createdAt && new Date(m.createdAt) > new Date(existingPrinciple.updatedAt)
        );
        if (!hasNewEvidence) continue; // nothing new — leave the existing principle
      } else if (await this._onCooldown(orgId, hash, PRINCIPLE_COOLDOWN_HOURS)) {
        continue;
      }

      members.sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
      const promptMembers = members.slice(0, DEFAULT_CLUSTER_MAX);

      try {
        const facts = promptMembers.map((m) => {
          const c  = stripIngestStamp((m.content || '').replace(/\s+/g, ' ')).slice(0, 500);
          const ts = m.createdAt ? new Date(m.createdAt).toISOString().slice(0, 10) : 'unknown-date';
          return `[${m.id}] (${ts}) ${m.title ? m.title + ' — ' : ''}${c}`;
        }).join('\n');

        const prompt = `You are surfacing a NEW INSIGHT from organizational memory — a specific, non-obvious fact that emerges ONLY by combining these memories and is NOT stated in any single one. This is what a sharp analyst notices after reading everything, that no individual memory says on its own. It must be impossible to find by reading just one memory at ingestion time.

Below are ${promptMembers.length} memories sharing the tag "${tag}".

LENS — favour insights that move the COMPANY forward: surface an opportunity to pursue, a risk to mitigate, or a concrete gap to close. The best insight is one a founder/operator would act on this week.

PRODUCE the single strongest insight (choose the type that fits, ground it in the evidence):
- emergent_connection: memory A + memory B together imply a concrete fact Z that neither states alone.
- pattern: a recurring specific pattern across ≥3 memories (name the instances).
- implication: a concrete consequence that follows from the facts but is never written down.
- tension: a specific contradiction or unresolved conflict between memories.
- gap: a specific missing piece the evidence reveals is absent or blocking.
- opportunity: a specific, grounded chance to grow/improve the company the evidence reveals (name the lever).
- risk: a specific, grounded threat or failure mode the evidence reveals (name what breaks and why).

HARD RULES (violations are rejected):
- SPECIFIC to THIS organization. Name the real entities exactly — people, orgs, products, projects, dates — as written. Reference the concrete facts, not abstractions.
- NEW: must NOT be a restatement of any single memory, and must NOT be derivable from one memory alone — it has to require combining at least two.
- GROUNDED: cite the memory [ids] it emerges from; never invent facts, numbers, or names.
- 2–4 sentences.

REJECT (these are failures, output nothing rather than these): generic advice / best-practices ("always prioritize clarity", "complementary skills help co-founders", "start simple then iterate"), motivational platitudes, anything that would be true for ANY company, single-memory restatements, vague summaries.

Memories:
${facts}

Output JSON only:
{ "insight": "<2-4 specific, grounded sentences naming real entities — the emergent fact>", "insight_type": "emergent_connection|pattern|implication|tension|gap|opportunity|risk", "entities": ["<proper nouns referenced, verbatim>"], "supporting_memory_ids":[...], "confidence": 0.0-1.0 }`;

        const raw = await llmWithFallback({
          messages:    [{ role: 'user', content: prompt }],
          temperature: 0.1,
          max_tokens:  450,
        }, this.logger);
        if (!raw) continue;

        // Reuse the SAME tolerant JSON helper the canonical sub-pass uses.
        const parsed = safeParseJSON(raw);
        // L2 now produces emergent INSIGHT (key 'insight'); fall back to the
        // legacy 'principle' key for any in-flight prompt variant.
        const principleText = parsed?.insight || parsed?.principle;
        const confidence = Number(parsed?.confidence || 0);
        if (!principleText || principleText.length < 20) continue;
        if (confidence < PRINCIPLE_CONFIDENCE_FLOOR) {
          this.logger.log(`[cognition] principle tag=${tag} confidence=${confidence} < floor — dropped`);
          continue;
        }
        // Restatement guard: drop if near-verbatim of any single source member.
        if (this._isRestatement(principleText, promptMembers)) {
          this.logger.log(`[cognition] principle tag=${tag} restatement detected — dropped`);
          continue;
        }

        const evidenceIds = promptMembers.map(m => m.id).filter(Boolean);
        // C1: serialize principle create per (orgId, clusterHash).
        let created;
        try {
          await this.prisma.$transaction(async (tx) => {
            await withGovernanceLock(tx, { orgId, agentName: `synth:${hash}` }, async () => {
              const alreadyExists = await this.prisma.memory.findFirst({
                where: { orgId, synthesisClusterHash: hash, isLatest: true, deletedAt: null },
                select: { id: true },
              });
              if (alreadyExists) return;
              created = await this._writeSynthMemory({
                orgId,
                userId:     members[0].userId,
                project:    members[0].project,
                sourceType: 'principle',
                tag,
                members:    promptMembers,
                content:    principleText,
                confidence,
                evidenceIds,
                clusterHash: hash,
              });
            });
          }, { timeout: Number(process.env.COGNITION_SYNTH_TXN_TIMEOUT_MS || 10 * 60 * 1000), maxWait: 8000 });
        } catch (lockErr) {
          if (lockErr?.code === 'GOVERNANCE_LOCK_BUSY') {
            this.logger.log?.(`[cognition] synth hash ${hash.slice(0,8)} busy on other replica — skip`);
            continue;
          }
          this.logger.warn(`[cognition] synth hash ${hash.slice(0,8)} failed: ${lockErr?.message || lockErr}`);
          continue;
        }
        if (created) {
          writes++;
          this.logger.log(`[cognition] principle tag=${tag} conf=${confidence.toFixed(2)} → ${String(created.id).slice(0, 8)}`);
        }
      } catch (err) {
        this.logger.warn(`[cognition] principle tag=${tag} failed: ${err.message}`);
      }
    }
    return writes;
    } catch (err) {
      this.logger.warn(`[cognition] distillPrinciplesForOrg org=${orgId} failed: ${err.message}`);
      return 0;
    }
  }

  /**
   * Build a LOSSLESS canonical for a topic cluster.
   * 100% information retention — every source memory's full content embedded
   * verbatim under a numbered section. Optionally prepends an LLM header.
   */
  async _buildLosslessSummary(tag, members, { partIndex = 0, partCount = 1 } = {}) {
    const fmtDate = (m) => {
      const d = m.updatedAt || m.createdAt;
      return d ? new Date(d).toISOString().slice(0, 10) : 'unknown-date';
    };
    const sections = members.map((m, i) => {
      const date  = fmtDate(m);
      const title = m.title ? ` — ${m.title}` : '';
      return `[${i + 1}] (${date})${title}\n${(m.content || '').trim()}`;
    }).join('\n\n');

    let header = '';
    try {
      const peek = members.map((m, i) => {
        const c = stripIngestStamp((m.content || '').replace(/\s+/g, ' ')).slice(0, 200);
        return `[${i + 1}] ${m.title ? m.title + ' — ' : ''}${c}`;
      }).join('\n');
      const headerPrompt = `Write ONE sentence (max 30 words) describing what these ${members.length} memories on topic "${tag}" collectively cover. No preamble. No "Summary:" prefix. Plain prose.\n\nMemories:\n${peek}`;
      const raw = await llmWithFallback({
        messages:    [{ role: 'user', content: headerPrompt }],
        temperature: 0.1,
        max_tokens:  80,
      }, this.logger);
      header = String(raw || '').trim().split('\n')[0].slice(0, 240);
    } catch (err) {
      this.logger.warn(`[cognition] header gen failed tag=${tag}: ${err.message}`);
    }

    const partTag = partCount > 1 ? ` (part ${partIndex + 1}/${partCount})` : '';
    const head    = header
      ? `Topic: ${tag}${partTag} — ${header}\n\n`
      : `Topic: ${tag}${partTag}\n\n`;
    return head + sections;
  }

  async _writeSummaryMemory({ orgId, userId, project, tag, members, content, partIndex = 0, partCount = 1 }) {
    const sourceIds = members.map(m => m.id);
    const unionedTags = new Set();
    for (const m of members) {
      for (const t of (m.tags || [])) {
        if (typeof t === 'string' && t.length > 0) unionedTags.add(t);
      }
    }
    unionedTags.add('canonical-summary');
    unionedTags.add(`topic:${tag}`);
    unionedTags.add('cognition-loop');
    unionedTags.add('drift-compaction');
    const summaryTags = Array.from(unionedTags);

    const partSuffix = partCount > 1 ? ` part ${partIndex + 1}/${partCount}` : '';
    const title = `Canonical: ${tag} (${members.length} memories${partSuffix})`;
    const created = await this.prisma.memory.create({
      data: {
        id:             crypto.randomUUID(),
        userId,
        orgId,
        project:        project || null,
        memoryType:     'summary',
        title,
        content,
        tags:           summaryTags,
        isLatest:       true,
        importanceScore: 0.85,
        cognitiveLayerRole: 'compression',
        sourceMetadata: {
          create: {
            sourceType: 'cognition-loop',
            sourceId:   `compact:${tag}:${partIndex + 1}of${partCount}:${Date.now()}`,
            metadata: {
              compacted_at:  new Date().toISOString(),
              topic:         tag,
              source_count:  members.length,
              source_ids:    sourceIds,
              part_index:    partIndex,
              part_count:    partCount,
              model:         PRIMARY_SYNTHESIS_MODEL,
              generator:     'cognition-loop.drift-compact',
              lossless:      true,
            },
          },
        },
      },
      select: { id: true },
    }).catch(err => {
      this.logger.warn(`[cognition] write summary failed: ${err.message}`);
      return null;
    });

    // Stage-2 fix: canonical summaries are born here via prisma.create — a
    // direct-save path that never reached the embedder, so summaries had ZERO
    // vectors system-wide (tag/FTS-only recall of compacted knowledge). Embed +
    // upsert now so the highest-value memory type is semantically recallable.
    // Fire-and-forget; point id = memory id (matches storeMemory contract).
    if (created?.id && this.engine?.vectorStore?.storeMemory) {
      this.engine.vectorStore.storeMemory({
        id:               created.id,
        user_id:          userId,
        org_id:           orgId,
        project:          project || null,
        memory_type:      'summary',
        title,
        content,
        tags:             summaryTags,
        is_latest:        true,
        importance_score: 0.85,
        created_at:       new Date().toISOString(),
        source:           'cognition-loop',
      }).catch(err => this.logger.warn(`[cognition] summary embed failed: ${err.message}`));
    }
    return created;
  }
}
