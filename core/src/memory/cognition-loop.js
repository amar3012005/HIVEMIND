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

// ─── Model config ──────────────────────────────────────────────────────────────
const PRIMARY_SYNTHESIS_MODEL   = process.env.SYNTHESIS_MODEL        || 'openai/gpt-oss-120b';
const FALLBACK_SYNTHESIS_MODEL  = process.env.SYNTHESIS_FALLBACK_MODEL || 'openai/gpt-oss-20b';
// Legacy constant kept for drift-compaction header prompt (non-critical path)
const SYNTHESIS_MODEL           = PRIMARY_SYNTHESIS_MODEL;

// ─── Clustering / quality thresholds ──────────────────────────────────────────
const DEFAULT_LOOKBACK_HOURS      = Number(process.env.SYNTHESIS_LOOKBACK_HOURS    || 24);
const CANONICAL_CLUSTER_MIN       = Number(process.env.CANONICAL_CLUSTER_MIN       || 6);
const DEFAULT_CLUSTER_MIN         = CANONICAL_CLUSTER_MIN; // alias kept for compaction path
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

// ─── Tag filters ───────────────────────────────────────────────────────────────
// Tags that don't form meaningful topic clusters for synthesis purposes
const SYS_TAG_RE = /^(file:|fn:|page:|heading:|upload:|doc-hash:|promoted-from|synthesized|topic:|cognition-loop|synthesis:|knowledge-base$|document$|document-summary$|entity:|time:|ts:|section:|chat$|talk-to-hive$)/i;

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
    this.prisma  = prisma;
    this.engine  = memoryGraphEngine;
    this.store   = persistentMemoryStore;
    this.logger  = logger;
    this._timer  = null;
    this._intervalMs = Number(process.env.COGNITION_INTERVAL_MS || 60 * 60 * 1000); // 1h
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
      return { synth, compact, ms: _status.last_run_ms };
    } catch (err) {
      _status.errors = [..._status.errors.slice(-9), { org_id: orgId, error: err.message, at: new Date().toISOString() }];
      throw err;
    } finally {
      _status.running = false;
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
        try {
          const synthN   = await this.synthesizeForOrg(org.id);
          const compactN = await this.compactDriftForOrg(org.id);
          totalSynth   += synthN;
          totalCompact += compactN;
        } catch (perOrgErr) {
          this.logger.warn(`[cognition] org=${org.id} failed: ${perOrgErr.message}`);
          _status.errors = [..._status.errors.slice(-9), { org_id: org.id, error: perOrgErr.message, at: new Date().toISOString() }];
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
    const since = new Date(Date.now() - DEFAULT_LOOKBACK_HOURS * 3600 * 1000);
    const recent = await this.prisma.memory.findMany({
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
      },
    });

    if (recent.length < CANONICAL_CLUSTER_MIN) return 0;

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
      if (members.length < CANONICAL_CLUSTER_MIN) continue;
      const hash = clusterHash(`canonical:${tag}`);
      if (await this._onCooldown(orgId, hash)) continue;

      members.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      const promptMembers = members.slice(0, DEFAULT_CLUSTER_MAX);

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
        const created = await this._writeSynthMemory({
          orgId,
          userId:    members[0].userId,
          project:   members[0].project,
          sourceType: 'canonical-fact',
          tag,
          members,
          content:   result.canonical_fact,
          confidence: result.confidence,
          evidenceIds: (result.supporting_memory_ids || []).filter(id => id),
          clusterHash: hash,
          extraMeta: {
            valid_from:      result.valid_from || null,
            expected_decay:  result.expected_decay || null,
            supporting_ids:  result.supporting_memory_ids || [],
          },
        });
        if (created) writes++;
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
        const allMembers = [...a.members, ...b.members];
        const evidenceIds = [
          ...(result.evidence_a || []).map(e => e.id),
          ...(result.evidence_b || []).map(e => e.id),
        ].filter(id => id);

        const created = await this._writeSynthMemory({
          orgId,
          userId:    a.members[0].userId,
          project:   a.members[0].project || b.members[0].project || null,
          sourceType: 'synthesis-bridge',
          tag:        pairKey,
          members:    allMembers,
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
        if (created) writes++;
      } catch (err) {
        this.logger.warn(`[cognition] bridge ${a.tag}||${b.tag} failed: ${err.message}`);
      }
    }

    return writes;
  }

  // ─── Cooldown check ──────────────────────────────────────────────────────────
  async _onCooldown(orgId, hash) {
    const cutoff = new Date(Date.now() - COOLDOWN_HOURS * 3600 * 1000);
    const existing = await this.prisma.memory.findFirst({
      where: {
        orgId,
        synthesisClusterHash: hash,
        createdAt: { gte: cutoff },
        deletedAt: null,
      },
      select: { id: true },
    });
    return Boolean(existing);
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
      const result = await this.engine.ingestMemory({
        user_id:         userId,
        org_id:          orgId,
        content,
        title,
        memory_type:     'synthesis',
        tags:            Array.from(unionedTags),
        project:         project || null,
        importance_score: sourceType === 'canonical-fact' ? 0.85 : 0.90,
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

        // Derives edges to evidence sources
        await this._linkDerivesEdges(newId, members, sourceType, tag);
      }

      return newId ? { id: newId } : null;
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
    return this.prisma.memory.create({
      data: {
        id:             crypto.randomUUID(),
        userId,
        orgId,
        project:        project || null,
        memoryType:     'summary',
        title:          `Canonical: ${tag} (${members.length} memories${partSuffix})`,
        content,
        tags:           summaryTags,
        isLatest:       true,
        importanceScore: 0.85,
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
  }

  // Legacy lossy summary — kept for reference, no longer called.
  // eslint-disable-next-line no-unused-vars
  async _llmDriftSummary(tag, members) {
    // Replaced by _buildLosslessSummary. Kept so git blame shows history.
    return null;
  }
}
