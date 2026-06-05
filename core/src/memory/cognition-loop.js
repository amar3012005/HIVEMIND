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
import { chatCompletion } from '../knowledge/enterprise/litellm-client.js';
import { ClusterIndex } from './cluster-index.js';

// ─── Model config ──────────────────────────────────────────────────────────────
// Phase 0 cost cut: routine synthesis/compaction is high-volume, low-reasoning
// text writing over already-grounded clusters → cheap model (llama-3.1-8b-instant,
// ~30-60x cheaper than gpt-oss-120b). Reserve expert models for rare verify steps.
// SYNTHESIS_MODEL env kept for back-compat override.
const PRIMARY_SYNTHESIS_MODEL   = process.env.COGNITION_WRITER_MODEL || process.env.SYNTHESIS_MODEL || 'llama-3.1-8b-instant';
// Fallback fires on primary EXCEPTION (gateway down), so escalate to a sturdier model.
const FALLBACK_SYNTHESIS_MODEL  = process.env.SYNTHESIS_FALLBACK_MODEL || 'openai/gpt-oss-20b';
// Legacy constant kept for drift-compaction header prompt (non-critical path)
const SYNTHESIS_MODEL           = PRIMARY_SYNTHESIS_MODEL;

// ─── Clustering / quality thresholds ──────────────────────────────────────────
const DEFAULT_LOOKBACK_HOURS      = Number(process.env.SYNTHESIS_LOOKBACK_HOURS    || 24);
// Adaptive cluster floor: small orgs (≤50 fact+decision memories) can't
// reach 6-member clusters. Scale floor with corpus density so sparse
// tenants get synthesis too.
//   floor = clamp(floor(latest_fact_decision_count / 50), 3, 6)
// Examples: 20 fact+decision → 3 ; 100 → 6 ; 300 → 6 (capped).
// Env override CANONICAL_CLUSTER_MIN still wins when explicitly set.
const CANONICAL_CLUSTER_MIN_HARD  = Number(process.env.CANONICAL_CLUSTER_MIN_HARD  || 6);
const CANONICAL_CLUSTER_MIN_SOFT  = Number(process.env.CANONICAL_CLUSTER_MIN_SOFT  || 3);
const CANONICAL_CLUSTER_MIN_ENV   = process.env.CANONICAL_CLUSTER_MIN != null
  ? Number(process.env.CANONICAL_CLUSTER_MIN)
  : null;
const CANONICAL_CLUSTER_MIN       = CANONICAL_CLUSTER_MIN_ENV ?? CANONICAL_CLUSTER_MIN_HARD;
const DEFAULT_CLUSTER_MIN         = CANONICAL_CLUSTER_MIN; // alias kept for compaction path

async function deriveClusterMin(prisma, orgId) {
  // Env override pins value across all orgs — operators may force a
  // specific floor for benchmarks. Skip the DB lookup.
  if (CANONICAL_CLUSTER_MIN_ENV != null) return CANONICAL_CLUSTER_MIN_ENV;
  try {
    const cnt = await prisma.memory.count({
      where: {
        orgId,
        isLatest: true,
        deletedAt: null,
        memoryType: { in: ['fact', 'decision'] },
      },
    });
    const adaptive = Math.floor(cnt / 50);
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
// Drop synthesis output if cosine(output, any source) > this (restatement guard)
const RESTATEMENT_THRESHOLD       = Number(process.env.RESTATEMENT_THRESHOLD       || 0.92);
const COOLDOWN_HOURS              = Number(process.env.SYNTHESIS_COOLDOWN_HOURS    || 6);
const DRIFT_COMPACT_THRESHOLD     = Number(process.env.DRIFT_COMPACT_THRESHOLD     || 12);
// Hard cap on members folded into one canonical (stops 394-member pathology)
const MAX_MEMBERS_PER_CANONICAL   = Number(process.env.DRIFT_MAX_MEMBERS_PER_CANONICAL || 10);
const MAX_ORGS_PER_TICK           = Number(process.env.COGNITION_MAX_ORGS_PER_TICK  || 25);

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
  let qdrantCollection = process.env.QDRANT_COLLECTION || 'BUNDB AGENT';
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
// Tags that don't form meaningful topic clusters for synthesis purposes
const SYS_TAG_RE = /^(file:|fn:|page:|heading:|upload:|doc-hash:|promoted-from|synthesized|topic:|cognition-loop|synthesis:|knowledge-base$|document$|document-summary$|entity:|time:|ts:|section:|chat$|talk-to-hive$)/i;

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

// ─── Centroid text (bag of all content in a cluster) ─────────────────────────
function clusterCentroidText(members) {
  return members.map(m => `${m.title || ''} ${m.content || ''}`).join(' ').slice(0, 8000);
}

// ─── Cluster hash ─────────────────────────────────────────────────────────────
function clusterHash(tagOrPair) {
  return crypto.createHash('sha256').update(tagOrPair).digest('hex').slice(0, 48);
}

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

  start() {
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
  async runOnce(orgId) {
    if (_status.running) {
      return { skipped: true, reason: 'tick already in progress' };
    }
    _status.running = true;
    const tStart = Date.now();
    try {
      const synth   = await this.synthesizeForOrg(orgId);
      const compact = await this.compactDriftForOrg(orgId);
      _status.last_run_at           = new Date().toISOString();
      _status.last_run_ms           = Date.now() - tStart;
      _status.last_synthesis_count  = synth;
      _status.last_compaction_count = compact;
      _status.next_run_at           = new Date(Date.now() + this._intervalMs).toISOString();
      this.logger.log(`[cognition] manual run org=${orgId} synth=${synth} compact=${compact} ms=${_status.last_run_ms}`);
      await this._persistOrgStatus(orgId, { synth, compact, runMs: Date.now() - tStart, error: null });
      return { synth, compact, ms: _status.last_run_ms };
    } catch (err) {
      _status.errors = [..._status.errors.slice(-9), { org_id: orgId, error: err.message, at: new Date().toISOString() }];
      await this._persistOrgStatus(orgId, { synth: 0, compact: 0, runMs: Date.now() - tStart, error: err.message });
      throw err;
    } finally {
      _status.running = false;
    }
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
      for (const org of orgs) {
        const orgStart = Date.now();
        try {
          const synthN   = await this.synthesizeForOrg(org.id);
          const compactN = await this.compactDriftForOrg(org.id);
          totalSynth   += synthN;
          totalCompact += compactN;
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
      this.logger.log(`[cognition] tick complete orgs=${orgs.length} synth=${totalSynth} compact=${totalCompact} ms=${_status.last_run_ms}`);
    } catch (err) {
      _status.errors = [..._status.errors.slice(-9), { error: err.message, at: new Date().toISOString() }];
      this.logger.error('[cognition] tick failed:', err.message);
    } finally {
      _status.running = false;
      this._timer = setTimeout(() => this._tick(), this._intervalMs);
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
  async synthesizeForOrg(orgId) {
    // Adaptive floor per-org based on corpus density. Small tenants
    // (≤50 fact+decision memories) get floor=3 so they can build
    // synthesis at all; mature tenants stay at floor=6 to keep quality
    // high. Capped at the hard default.
    const clusterMin = await deriveClusterMin(this.prisma, orgId);

    const since = new Date(Date.now() - DEFAULT_LOOKBACK_HOURS * 3600 * 1000);
    // Structured connector sources: their schema IS already canonical.
    // Re-synthesizing produces tautological canonicals ("OrgFarm owns 16
    // accounts") and trivial bridges ("US contacts share country:usa with
    // US accounts"). Skip them — recall surfaces the records directly.
    const STRUCTURED_SOURCES = [
      'salesforce', 'salesforce-sandbox', 'hubspot', 'pipedrive',
      'github', 'linear', 'jira', 'confluence',
    ];
    const recentRaw = await this.prisma.memory.findMany({
      where: {
        orgId,
        createdAt:  { gte: since },
        deletedAt:  null,
        memoryType: { in: ['fact', 'decision'] },
        // Exclude existing synthesis outputs from source pools
        NOT: { tags: { hasSome: ['synthesis:canonical', 'synthesis:bridge', 'canonical-summary', 'synthesized'] } },
      },
      take: 400,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, title: true, content: true, tags: true,
        memoryType: true, userId: true, project: true, createdAt: true,
        sourceMetadata: { select: { sourcePlatform: true } },
      },
    });
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
        const evidenceIds = (result.supporting_memory_ids || []).filter(id => id);

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

        const created = await this._writeSynthMemory({
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
        if (created) {
          writes++;
          // Register new cluster in cluster_index (Option A: dirty_count=0, tick just created it)
          await this.clusterIndex.upsertOnSynthesis({
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

        const sim = tokenCosine(a.centroid, b.centroid);
        if (sim < BRIDGE_SIM_LOW || sim > BRIDGE_SIM_HIGH) continue;

        bridgeCandidates.push({ a, b, sim });
      }
    }

    // Sort by similarity (middle of range = most interesting gap to bridge)
    bridgeCandidates.sort((x, y) => {
      const midDist = (v) => Math.abs(v - (BRIDGE_SIM_LOW + BRIDGE_SIM_HIGH) / 2);
      return midDist(x.sim) - midDist(y.sim);
    });

    const topBridges = bridgeCandidates.slice(0, BRIDGE_TOP_K);

    for (const { a, b } of topBridges) {
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

        const created = await this._writeSynthMemory({
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
          },
        });
        if (created) {
          writes++;
          // Register bridge cluster in cluster_index
          await this.clusterIndex.upsertOnSynthesis({
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

    return writes;
  }

  // ─── Cooldown check ──────────────────────────────────────────────────────────
  // Returns true if we should SKIP this cluster entirely.
  // Phase 2: we no longer skip if new evidence exists — delta-update path takes
  // over instead. Cooldown only skips if updatedAt is within the window AND
  // no source memories are newer than the existing synthesis.
  async _onCooldown(orgId, hash) {
    const cutoff = new Date(Date.now() - COOLDOWN_HOURS * 3600 * 1000);
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
      const c  = (m.content || '').replace(/\s+/g, ' ').slice(0, 600);
      const ts = m.createdAt ? new Date(m.createdAt).toISOString().slice(0, 10) : 'unknown-date';
      return `[${m.id}] (${ts}) ${m.title ? m.title + ' — ' : ''}${c}`;
    }).join('\n');

    const prompt = `Below are ${members.length} memories sharing tag "${tag}". Extract ONE canonical fact:
- Persists across ≥3 of these memories (cite IDs)
- Concrete: names roles, relationships, intentions — NOT "is involved with"
- Survives 6 months without trivial staleness
- NEVER stated verbatim by a single source

REJECT: enumerations ("X and Y and Z"), vague qualifiers, "X is connected to Y through Z".

Memories:
${facts}

Output JSON only:
{ "canonical_fact": "<one sentence>", "supporting_memory_ids":[...], "valid_from":"YYYY-MM-DD", "expected_decay":"<falsifier>", "confidence": 0.0-1.0 }`;

    const raw = await llmWithFallback({
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.15,
      max_tokens:  400,
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
        const c  = (m.content || '').replace(/\s+/g, ' ').slice(0, 400);
        const ts = m.createdAt ? new Date(m.createdAt).toISOString().slice(0, 10) : 'unknown-date';
        return `  [${m.id}] (${ts}) ${m.title ? m.title + ' — ' : ''}${c}`;
      }).join('\n');

    const prompt = `Cluster A (tag "${tagA}", ${membersA.length} memories):
${formatCluster(tagA, membersA)}

Cluster B (tag "${tagB}", ${membersB.length} memories):
${formatCluster(tagB, membersB)}

These clusters never co-occur. Find the LATENT BRIDGE — causal | temporal_arc | contradiction | enabling_gap.

REJECT: restatement, "X and Y are connected through Z", generic summary.

Output JSON only:
{ "bridge_type":"causal|temporal_arc|contradiction|enabling_gap", "bridge_claim":"<one sentence, names entities + dates>", "evidence_a":[{"id":"<uuid>","why":"<short reason>"}], "evidence_b":[{"id":"<uuid>","why":"<short reason>"}], "confidence": 0.0-1.0, "actionable_next_step":"<one sentence>" }`;

    const raw = await llmWithFallback({
      messages:    [{ role: 'user', content: prompt }],
      temperature: 0.20,
      max_tokens:  600,
    }, this.logger);

    if (!raw) return null;
    const parsed = safeParseJSON(raw);
    if (!parsed || !parsed.bridge_claim || parsed.bridge_claim.length < 20) return null;
    return parsed;
  }

  // ─── Phase 2: Confidence cap per revision ────────────────────────────────────
  // Prevents overconfidence early in a synthesis's life. The cap loosens as
  // the same claim is reaffirmed across multiple ticks.
  _capConfidence(rawConf, revision) {
    const cap = revision === 1 ? 0.85
               : revision === 2 ? 0.90
               : revision === 3 ? 0.94
               : 0.98;
    return Math.min(cap, rawConf);
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
      const c  = (m.content || '').replace(/\s+/g, ' ').slice(0, 500);
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
      // Confidence: take the higher of prior and LLM output, then add 0.05 bump,
      // then apply the per-revision cap.
      const rawConf   = Math.min(0.98, Math.max(existing.synthesisConfidence || 0, llmConf) + 0.05);
      const finalConf = this._capConfidence(rawConf, newRev);

      // Cap evidence IDs at MAX_HOT_EVIDENCE (Move 2) + track total
      const MAX_HOT_EVIDENCE = 20;
      const merged    = [...(existing.synthesisEvidenceIds || []), ...(parsed.evidence_to_add || [])];
      const dedupe    = [...new Set(merged)];
      const hot       = dedupe.slice(-MAX_HOT_EVIDENCE);
      const evidenceCountTotal = dedupe.length;

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
      await this.clusterIndex.upsertOnSynthesis({
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
      const finalConf = this._capConfidence(llmConf, newRev);
      const claim     = (parsed.new_claim && parsed.new_claim.length > 20)
        ? parsed.new_claim
        : (existing.content || '');

      // Cap evidence IDs at MAX_HOT_EVIDENCE (Move 2)
      const MAX_HOT_EVIDENCE = 20;
      const rawEvidenceIds = (parsed.evidence_to_add || []).filter(Boolean);
      const mergedEv = [...(existing.synthesisEvidenceIds || []), ...rawEvidenceIds];
      const dedupeEv = [...new Set(mergedEv)];
      const evidenceIds      = dedupeEv.slice(-MAX_HOT_EVIDENCE);
      const evidenceCountTotal = dedupeEv.length;

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

          // Move 2: demote prior revision so recall doesn't double-surface.
          // Extends edge is preserved for time-travel; isLatest=false removes it
          // from the default recall set which filters isLatest=true only.
          await this.prisma.memory.update({
            where: { id: existing.id },
            data:  { isLatest: false },
          }).catch(err => this.logger.warn(`[cognition] EXTEND: demote prior isLatest failed: ${err.message}`));
          this.logger.log(`[cognition-loop] EXTEND: demoted prior ${existing.id.slice(0, 8)} isLatest=false (rev ${priorRev} → ${newRev})`);

          // Extends edge: new → existing (new extends the prior)
          await this.prisma.relationship.create({
            data: {
              id:         crypto.randomUUID(),
              fromId:     newId,
              toId:       existing.id,
              type:       'Extends',
              confidence: finalConf,
              createdBy:  'cognition-loop',
              metadata:   { reason: 'delta_extend', topic: tag, revision: newRev },
            },
          }).catch(() => {});

          // Update cluster-index with new synthesis id and revision
          await this.clusterIndex.upsertOnSynthesis({
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
        }
      } catch (err) {
        this.logger.warn(`[cognition] extend engine.ingestMemory failed: ${err.message}`);
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
      // CONTRADICT resets revision to 1, confidence capped at 0.85 (revision-1 cap)
      const finalConf = this._capConfidence(llmConf, 1);

      // Cap evidence IDs (Move 2)
      const MAX_HOT_EVIDENCE = 20;
      const rawContrEv = (parsed.evidence_to_add || []).filter(Boolean);
      const mergedContr = [...(existing.synthesisEvidenceIds || []), ...rawContrEv];
      const dedupeContr = [...new Set(mergedContr)];
      const evidenceIds = dedupeContr.slice(-MAX_HOT_EVIDENCE);
      const contrEvidenceCountTotal = dedupeContr.length;

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

          // Force-flip old synthesis to isLatest=false (belt-and-suspenders over smart-router)
          await this.prisma.memory.update({
            where: { id: existing.id },
            data:  { isLatest: false },
          }).catch(err => this.logger.warn(`[cognition] contradict flip isLatest failed: ${err.message}`));

          // Explicit Updates edge
          await this.prisma.relationship.create({
            data: {
              id:         crypto.randomUUID(),
              fromId:     newId,
              toId:       existing.id,
              type:       'Updates',
              confidence: finalConf,
              createdBy:  'cognition-loop',
              metadata:   { reason: 'delta_contradict', topic: tag },
            },
          }).catch(() => {});

          // Update cluster-index: new synthesis row, revision reset to 1
          await this.clusterIndex.upsertOnSynthesis({
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
        }
      } catch (err) {
        this.logger.warn(`[cognition] contradict engine.ingestMemory failed: ${err.message}`);
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
    const synthTag = sourceType === 'canonical-fact' ? 'synthesis:canonical' : 'synthesis:bridge';

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

    const title = sourceType === 'canonical-fact'
      ? `Canonical fact: ${tag.slice(0, 60)} (${members.length} sources)`
      : `Bridge: ${tag.slice(0, 80)} [conf=${confidence?.toFixed(2)}]`;

    // Use engine.ingestMemory so smart-routing fires (operator, entity-co-mention, conflict-detector)
    if (!this.engine) {
      // Engine not wired → fall back to direct prisma insert (preserves synthesis columns)
      return this._directInsert({ orgId, userId, project, sourceType, tag, members, content, confidence, evidenceIds, hash, title, unionedTags, extraMeta });
    }

    try {
      // IMPORTANT: graph-engine._buildMemoryRecord reads snake_case field names
      // (user_id, org_id, memory_type, importance_score). Passing camelCase will
      // silently result in undefined fields and a Prisma rejection.
      // source_metadata must be an object matching { source_type, source_id, ... }.
      let finalTags = Array.from(unionedTags);
      const cognitiveLayerRole = sourceType === 'canonical-fact' ? 'canonical' : 'bridge';
      const result = await this.engine.ingestMemory({
        user_id:         userId,
        org_id:          orgId,
        content,
        title,
        memory_type:     'synthesis',
        tags:            Array.from(unionedTags),
        project:         project || null,
        importance_score: sourceType === 'canonical-fact' ? 0.85 : 0.90,
        cognitive_layer_role: cognitiveLayerRole,
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
        await this._linkDerivesEdges(newId, members, sourceType, tag);
      }

      return newId ? { id: newId, tags: finalTags } : null;
    } catch (err) {
      this.logger.warn(`[cognition] engine.ingestMemory failed (${err.message}), falling back to direct insert`);
      return this._directInsert({ orgId, userId, project, sourceType, tag, members, content, confidence, evidenceIds, hash, title, unionedTags, extraMeta });
    }
  }

  // Direct Prisma insert fallback (used when engine not available or throws)
  async _directInsert({ orgId, userId, project, sourceType, tag, members, content, confidence, evidenceIds, hash, title, unionedTags, extraMeta }) {
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
        importanceScore:     sourceType === 'canonical-fact' ? 0.85 : 0.90,
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
      await this._linkDerivesEdges(created.id, members, sourceType, tag);
    }
    return created;
  }

  // Derives edges to all source members
  async _linkDerivesEdges(synthId, members, sourceType, tag) {
    for (const src of members) {
      try {
        await this.prisma.relationship.create({
          data: {
            id:         crypto.randomUUID(),
            fromId:     synthId,
            toId:       src.id,
            type:       'Derives',
            confidence: sourceType === 'canonical-fact' ? 0.88 : 0.82,
            createdBy:  'cognition-loop',
            metadata:   { reason: sourceType, topic: tag, source_count: members.length },
          },
        });
      } catch { /* dup or FK race — skip */ }
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
      },
      take: 500,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true, userId: true, title: true, content: true, tags: true,
        project: true, createdAt: true, updatedAt: true,
      },
    });
    if (recent.length < DRIFT_COMPACT_THRESHOLD) return 0;

    // SYS_TAG_RE for compaction excludes synthesis outputs from re-compaction
    const COMPACT_SYS_TAG_RE = /^(file:|fn:|page:|heading:|upload:|doc-hash:|promoted-from|synthesized|topic:|cognition-loop|synthesis:|knowledge-base$|document$|document-summary$|entity:|section:|chat$|talk-to-hive$)/i;

    const buckets = new Map();
    for (const m of recent) {
      const primaryTag = (m.tags || []).find(t => !COMPACT_SYS_TAG_RE.test(t));
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
          for (const src of chunk) {
            try {
              await this.prisma.relationship.create({
                data: {
                  id:         crypto.randomUUID(),
                  fromId:     created.id,
                  toId:       src.id,
                  type:       'Derives',
                  confidence: 0.9,
                  createdBy:  'cognition-drift-compact',
                  metadata:   { reason: 'drift_compaction', topic: tag, part: ci + 1, parts: chunks.length },
                },
              });
            } catch { /* race — skip */ }
          }

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
        const c = (m.content || '').replace(/\s+/g, ' ').slice(0, 200);
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
              model:         SYNTHESIS_MODEL,
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

  // Legacy lossy summary — kept for reference, no longer called.
  // eslint-disable-next-line no-unused-vars
  async _llmDriftSummary(tag, members) {
    // Replaced by _buildLosslessSummary. Kept so git blame shows history.
    return null;
  }
}
