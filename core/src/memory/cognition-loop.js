/**
 * Cognition Loop — the "thinking" cron.
 *
 * Two passes run on schedule (default hourly):
 *   1. Synthesis pass: cluster recent memories + edges → ask LLM
 *      "what new insight emerges from these connected facts?" → writes
 *      synthesized:true memory linked back to its sources via Derives.
 *   2. Drift compaction: when a topic cluster grows past THRESHOLD
 *      members, compress into one canonical "as of today" summary;
 *      old members get marked superseded with Derives edges.
 *
 * Both passes are tenant-scoped (per org_id). Loops are idempotent —
 * a synthesis claim that already exists won't be rewritten.
 *
 * Status surfaced via /api/admin/cognition/status.
 */

import crypto from 'crypto';
import { chatCompletion } from '../knowledge/enterprise/litellm-client.js';

const SYNTHESIS_MODEL = process.env.SYNTHESIS_MODEL || 'openai/gpt-oss-120b';
const DEFAULT_LOOKBACK_HOURS = Number(process.env.SYNTHESIS_LOOKBACK_HOURS || 24);
const DEFAULT_CLUSTER_MIN = Number(process.env.SYNTHESIS_CLUSTER_MIN || 4);
const DEFAULT_CLUSTER_MAX = Number(process.env.SYNTHESIS_CLUSTER_MAX || 30);
// Raised from 12 → 24 so transient chat spam doesn't trigger compaction
// every hour. A topic needs to be genuinely active (24+ memories) before
// we pay the LLM cost to canonicalize it.
const DRIFT_COMPACT_THRESHOLD = Number(process.env.DRIFT_COMPACT_THRESHOLD || 24);
// Per-topic cooldown — skip compaction if a canonical-summary for the same
// tag already exists and was created within COOLDOWN_HOURS. Stops repeated
// re-compaction every tick once a topic gets summarized.
const DRIFT_COMPACT_COOLDOWN_HOURS = Number(process.env.DRIFT_COMPACT_COOLDOWN_HOURS || 6);
// Hard cap on members folded into one canonical. Buckets larger than this
// are split into multiple canonicals, each carrying ≤ MAX members. Stops
// the old "compacted 394" pathology where one summary tried to represent
// hundreds of source memories and inevitably lost detail.
const MAX_MEMBERS_PER_CANONICAL = Number(process.env.DRIFT_MAX_MEMBERS_PER_CANONICAL || 10);
const MAX_ORGS_PER_TICK = Number(process.env.COGNITION_MAX_ORGS_PER_TICK || 25);

// In-process status (mirrored in DB via cognition_runs row)
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

export class CognitionLoop {
  constructor({ prisma, memoryGraphEngine, persistentMemoryStore, logger = console }) {
    this.prisma = prisma;
    this.engine = memoryGraphEngine;
    this.store = persistentMemoryStore;
    this.logger = logger;
    this._timer = null;
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
   * Manual single-org trigger. Same status-counter update as the auto
   * tick — call from /api/cognition/synthesize-now so the UI sees fresh
   * last_run / last_synthesis_count / last_compaction_count.
   */
  async runOnce(orgId) {
    if (_status.running) {
      return { skipped: true, reason: 'tick already in progress' };
    }
    _status.running = true;
    const tStart = Date.now();
    try {
      const synth = await this.synthesizeForOrg(orgId);
      const compact = await this.compactDriftForOrg(orgId);
      _status.last_run_at = new Date().toISOString();
      _status.last_run_ms = Date.now() - tStart;
      _status.last_synthesis_count = synth;
      _status.last_compaction_count = compact;
      _status.next_run_at = new Date(Date.now() + this._intervalMs).toISOString();
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
    if (_status.running) return; // re-entrancy guard
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
          const synthN = await this.synthesizeForOrg(org.id);
          const compactN = await this.compactDriftForOrg(org.id);
          totalSynth += synthN;
          totalCompact += compactN;
        } catch (perOrgErr) {
          this.logger.warn(`[cognition] org=${org.id} failed: ${perOrgErr.message}`);
          _status.errors = [..._status.errors.slice(-9), { org_id: org.id, error: perOrgErr.message, at: new Date().toISOString() }];
        }
      }
      _status.last_run_at = new Date().toISOString();
      _status.last_run_ms = Date.now() - tStart;
      _status.last_synthesis_count = totalSynth;
      _status.last_compaction_count = totalCompact;
      _status.next_run_at = new Date(Date.now() + this._intervalMs).toISOString();
      this.logger.log(`[cognition] tick complete orgs=${orgs.length} synth=${totalSynth} compact=${totalCompact} ms=${_status.last_run_ms}`);
    } catch (err) {
      _status.errors = [..._status.errors.slice(-9), { error: err.message, at: new Date().toISOString() }];
      this.logger.error('[cognition] tick failed:', err.message);
    } finally {
      _status.running = false;
      this._timer = setTimeout(() => this._tick(), this._intervalMs);
    }
  }

  /**
   * Pass 1 — Synthesis.
   * Pulls last-N-hour memories with non-zero edge degree, batches by
   * shared tag, asks LLM for an emergent insight per batch, writes the
   * synthesized memory with Derives edges to sources.
   */
  async synthesizeForOrg(orgId) {
    const since = new Date(Date.now() - DEFAULT_LOOKBACK_HOURS * 3600 * 1000);
    // Recent memories with at least one outgoing/incoming relation.
    // Filter on memory_type=fact|decision (skip preferences / chat dumps).
    const recent = await this.prisma.memory.findMany({
      where: {
        orgId,
        createdAt: { gte: since },
        deletedAt: null,
        memoryType: { in: ['fact', 'decision'] },
      },
      take: 200,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, title: true, content: true, tags: true,
        memoryType: true, userId: true, project: true,
        createdAt: true,
      },
    });
    if (recent.length < DEFAULT_CLUSTER_MIN) return 0;

    // Group by primary tag (first non-system tag) — cheap shared-topic proxy.
    const SYS_TAG_RE = /^(file:|fn:|page:|heading:|upload:|doc-hash:|promoted-from)/i;
    const buckets = new Map();
    for (const m of recent) {
      const primaryTag = (m.tags || []).find(t => !SYS_TAG_RE.test(t)) || (m.project || 'untagged');
      if (!buckets.has(primaryTag)) buckets.set(primaryTag, []);
      buckets.get(primaryTag).push(m);
    }
    let writes = 0;
    for (const [tag, members] of buckets.entries()) {
      if (members.length < DEFAULT_CLUSTER_MIN) continue;
      // Sort newest-first so the LLM sees the most-recent facts (which
      // tend to dominate the emergent insight). Then split:
      //   members        → FULL set, all get Derives edges (attribution kept)
      //   promptMembers  → newest CLUSTER_MAX, sent to the LLM
      members.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      const promptMembers = members.slice(0, DEFAULT_CLUSTER_MAX);

      // Skip if a synthesis for this tag already ran in the last cycle.
      const recentSynth = await this.prisma.memory.findFirst({
        where: {
          orgId,
          tags: { hasEvery: ['synthesized', `topic:${tag}`] },
          createdAt: { gte: since },
        },
        select: { id: true },
      });
      if (recentSynth) continue;
      try {
        const insight = await this._llmSynthesize(tag, promptMembers, members.length);
        if (!insight || insight.length < 40) continue;
        // Pass FULL `members` (not promptMembers) so every source gets a
        // Derives edge even when the cluster exceeded the prompt cap.
        const synthMemory = await this._writeSynthMemory({
          orgId, userId: members[0].userId, project: members[0].project,
          tag, members, content: insight,
        });
        if (synthMemory) writes++;
      } catch (err) {
        this.logger.warn(`[cognition] synthesize tag=${tag} failed: ${err.message}`);
      }
    }
    return writes;
  }

  async _llmSynthesize(tag, members, totalMembers = null) {
    const facts = members.map((m, i) => {
      const c = (m.content || '').replace(/\s+/g, ' ').slice(0, 500);
      const ts = m.createdAt ? new Date(m.createdAt).toISOString().slice(0, 10) : 'unknown-date';
      return `[${i + 1}] (${ts}) ${m.title ? m.title + ' — ' : ''}${c}`;
    }).join('\n');
    const overflowNote = totalMembers && totalMembers > members.length
      ? `\n(Note: ${totalMembers - members.length} older memories on this topic exist but are omitted; reason about the most-recent set.)`
      : '';
    const prompt = `Find the single most important EMERGENT INSIGHT across the facts below — something true across the set but not stated in any one fact alone.

Topic: ${tag}
Facts (${members.length}${totalMembers && totalMembers > members.length ? ` of ${totalMembers} newest-first` : ''}):
${facts}${overflowNote}

Rules:
- Output ONE sentence, 15-40 words.
- Preserve specific entity names, dates, and numbers — never generalize them away.
- Cite the source facts you connected using inline [N] markers (at least 2 distinct [N]).
- Do NOT restate any single fact verbatim.
- Avoid hedging ("might", "could potentially"). State the inference.
- If no real connection exists across at least 2 facts, output exactly: NO_INSIGHT
- No preamble. Just the sentence with its [N] markers.`;
    const raw = await chatCompletion({
      model: SYNTHESIS_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 300,
    });
    const txt = String(raw || '').trim();
    if (!txt || txt === 'NO_INSIGHT' || /^no[_ ]insight/i.test(txt)) return null;
    return txt;
  }

  async _writeSynthMemory({ orgId, userId, project, tag, members, content }) {
    const title = `Synthesis: ${tag} (${members.length} sources)`;
    const sourceIds = members.map(m => m.id);
    // Insert directly via store so we bypass smart-routing pre-flight.
    const created = await this.prisma.memory.create({
      data: {
        id: crypto.randomUUID(),
        userId,
        orgId,
        project: project || null,
        memoryType: 'synthesis',
        title,
        content,
        tags: ['synthesized', `topic:${tag}`, 'cognition-loop'],
        isLatest: true,
        importanceScore: 0.75,
        // Attribution lives on the SourceMetadata relation (Memory itself
        // has no top-level metadata column). FE / recall can read
        // memory.sourceMetadata.metadata.source_ids to skip a graph walk.
        sourceMetadata: {
          create: {
            sourceType: 'cognition-loop',
            sourceId: `synth:${tag}:${Date.now()}`,
            metadata: {
              synthesized_at: new Date().toISOString(),
              topic: tag,
              source_count: members.length,
              source_ids: sourceIds,
              model: SYNTHESIS_MODEL,
              generator: 'cognition-loop.synthesize',
            },
          },
        },
      },
      select: { id: true },
    }).catch(err => {
      this.logger.warn(`[cognition] write synth failed: ${err.message}`);
      return null;
    });
    if (!created) return null;

    // Link via Derives edges to every source member
    for (const src of members) {
      try {
        await this.prisma.relationship.create({
          data: {
            id: crypto.randomUUID(),
            fromId: created.id,
            toId: src.id,
            type: 'Derives',
            confidence: 0.85,
            createdBy: 'cognition-loop',
            metadata: { reason: 'continuous_synthesis', topic: tag, members_count: members.length },
          },
        });
      } catch { /* dup or FK race — skip */ }
    }
    return created;
  }

  /**
   * Pass 2 — Drift compaction.
   * Buckets memories by primary tag. When a bucket grows past
   * DRIFT_COMPACT_THRESHOLD, generate ONE canonical "as of today"
   * summary memory + mark all members superseded with Derives edges
   * pointing at the new summary. Old memories stay queryable (is_latest
   * just becomes false; the bi-temporal ledger keeps them).
   */
  async compactDriftForOrg(orgId) {
    const recent = await this.prisma.memory.findMany({
      where: {
        orgId,
        isLatest: true,
        deletedAt: null,
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

    // Excluded from bucketing: tags that aren't real topic clusters.
    // Also excluded: knowledge-base / document / document-summary —
    // those mark user-uploaded source-of-truth (PDF chunks, segments).
    // Compacting them loses the original chunks because we set
    // isLatest=false on every source, which then disappear from default
    // recall. KB docs are durable facts, not "drifting" beliefs.
    //
    // Extended exclusions: agent/surface markers ("react-agent", "via:*",
    // "agent:*", "assistant:*", "model:*"), platform tags ("manual",
    // "talk-to-hive", "chat"), and the new auto-stamped tags ("ts:*",
    // "time:*"). These tags appear on nearly every memory and would
    // collect huge buckets that don't represent real topics.
    const SYS_TAG_RE = /^(file:|fn:|page:|heading:|upload:|doc-hash:|promoted-from|synthesized|topic:|cognition-loop|knowledge-base$|document$|document-summary$|entity:|section:|chat$|talk-to-hive$|react-agent$|manual$|via:|agent:|assistant:|model:|ts:|time:|source:|sub-source:)/i;
    const buckets = new Map();
    for (const m of recent) {
      const primaryTag = (m.tags || []).find(t => !SYS_TAG_RE.test(t));
      if (!primaryTag) continue;
      if (!buckets.has(primaryTag)) buckets.set(primaryTag, []);
      buckets.get(primaryTag).push(m);
    }

    // Pre-fetch recent canonicals for cooldown check. Skip topics that
    // already have a fresh canonical-summary so we don't re-compact every
    // hour. The cooldown is per-topic — different topics can still compact.
    const cooldownCutoff = new Date(Date.now() - DRIFT_COMPACT_COOLDOWN_HOURS * 3600 * 1000);
    const recentCanonicals = await this.prisma.memory.findMany({
      where: {
        orgId,
        deletedAt: null,
        tags: { has: 'canonical-summary' },
        createdAt: { gte: cooldownCutoff },
      },
      select: { tags: true },
      take: 200,
    });
    const cooldownTopics = new Set();
    for (const c of recentCanonicals) {
      for (const t of (c.tags || [])) {
        if (typeof t === 'string' && t.startsWith('topic:')) {
          cooldownTopics.add(t.slice('topic:'.length));
        }
      }
    }
    let compactions = 0;
    for (const [tag, members] of buckets.entries()) {
      if (members.length < DRIFT_COMPACT_THRESHOLD) continue;
      if (cooldownTopics.has(tag)) {
        // Recent canonical already exists for this topic — wait for next
        // cooldown window before re-compacting.
        continue;
      }
      // Newest-first split into chunks ≤ MAX_MEMBERS_PER_CANONICAL. Each
      // chunk becomes its OWN canonical so all source memories are covered
      // and no canonical fans in more than the cap.
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
            tag, members: chunk, content,
            partIndex: ci, partCount: chunks.length,
          });
          if (!created) continue;
          // Derive (NOT supersede). Granular members stay isLatest=true so
          // the agent still sees the original chunks alongside the canonical.
          for (const src of chunk) {
            try {
              await this.prisma.relationship.create({
                data: {
                  id: crypto.randomUUID(),
                  fromId: created.id,
                  toId: src.id,
                  type: 'Derives',
                  confidence: 0.9,
                  createdBy: 'cognition-drift-compact',
                  metadata: { reason: 'drift_compaction', topic: tag, part: ci + 1, parts: chunks.length },
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
   *
   * Contract:
   *   • 100% information retention — every source memory's full content is
   *     embedded verbatim under a numbered section. No LLM compression.
   *   • Optionally prepends an LLM-generated header (1-2 sentences) using
   *     SYNTHESIS_MODEL (gpt-oss-120b by default) for readability; failure
   *     to generate the header just omits it — never blocks compaction.
   *   • Caller guarantees `members.length ≤ MAX_MEMBERS_PER_CANONICAL`.
   */
  async _buildLosslessSummary(tag, members, { partIndex = 0, partCount = 1 } = {}) {
    const fmtDate = (m) => {
      const d = m.updatedAt || m.createdAt;
      return d ? new Date(d).toISOString().slice(0, 10) : 'unknown-date';
    };
    const sections = members.map((m, i) => {
      const date = fmtDate(m);
      const title = m.title ? ` — ${m.title}` : '';
      const body = (m.content || '').trim();
      return `[${i + 1}] (${date})${title}\n${body}`;
    }).join('\n\n');

    // Header is purely cosmetic. Try LLM; if it fails or is empty, skip.
    let header = '';
    try {
      const peek = members.map((m, i) => {
        const c = (m.content || '').replace(/\s+/g, ' ').slice(0, 200);
        return `[${i + 1}] ${m.title ? m.title + ' — ' : ''}${c}`;
      }).join('\n');
      const headerPrompt = `Write ONE sentence (max 30 words) describing what these ${members.length} memories on topic "${tag}" collectively cover. No preamble. No "Summary:" prefix. Plain prose.

Memories:
${peek}`;
      const raw = await chatCompletion({
        model: SYNTHESIS_MODEL,
        messages: [{ role: 'user', content: headerPrompt }],
        temperature: 0.1,
        max_tokens: 80,
      });
      header = String(raw || '').trim().split('\n')[0].slice(0, 240);
    } catch (err) {
      this.logger.warn(`[cognition] header gen failed tag=${tag}: ${err.message}`);
    }

    const partTag = partCount > 1 ? ` (part ${partIndex + 1}/${partCount})` : '';
    const head = header
      ? `Topic: ${tag}${partTag} — ${header}\n\n`
      : `Topic: ${tag}${partTag}\n\n`;
    return head + sections;
  }

  // Legacy lossy summary — kept for reference, no longer called by drift compaction.
  // eslint-disable-next-line no-unused-vars
  async _llmDriftSummary(tag, members) {
    // Newest-first so the summary reflects the current state of knowledge.
    const sorted = members.slice().sort(
      (a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0)
    );
    const BATCH = 25;
    const formatBatch = (batch, offset) => batch.map((m, i) => {
      const c = (m.content || '').replace(/\s+/g, ' ').slice(0, 280);
      const ts = m.createdAt ? new Date(m.createdAt).toISOString().slice(0, 10) : 'unknown-date';
      return `[${offset + i + 1}] (${ts}) ${m.title ? m.title + ' — ' : ''}${c}`;
    }).join('\n');

    const singlePass = async (batch, offset, isFinal = true) => {
      const facts = formatBatch(batch, offset);
      const prompt = `Compress the memories below on a single topic into one canonical summary that captures the current state of knowledge.

Topic: ${tag}
Memories (newest first):
${facts}

Rules:
- Output a SINGLE paragraph (3-6 sentences, 60-200 words).
- Preserve specific entity names, dates, numbers, and identifiers verbatim — never generalize them away.
- Resolve contradictions toward the MOST RECENT and most-repeated version; explicitly note the supersession only if material.
- Drop one-off mentions that don't recur.
- Use plain prose. No lists. No preamble. No "Summary:" prefix.${isFinal ? '' : '\n- This is a partial — focus on facts in THIS batch only.'}`;
      const raw = await chatCompletion({
        model: SYNTHESIS_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.15,
        max_tokens: 450,
      });
      return String(raw || '').trim();
    };

    // Small cluster — one pass.
    if (sorted.length <= BATCH) {
      return singlePass(sorted, 0, true);
    }

    // Big cluster — map (partial summaries) then reduce (final summary).
    const partials = [];
    for (let i = 0; i < sorted.length; i += BATCH) {
      const batch = sorted.slice(i, i + BATCH);
      try {
        const p = await singlePass(batch, i, false);
        if (p) partials.push(p);
      } catch (err) {
        this.logger.warn(`[cognition] drift partial batch=${i} failed: ${err.message}`);
      }
    }
    if (partials.length === 0) return '';
    if (partials.length === 1) return partials[0];

    // Reducer pass — merge partials into one canonical.
    const reducerPrompt = `Merge the partial summaries below — each was generated from a slice of memories on the same topic — into ONE canonical summary that captures the current state of knowledge across all ${sorted.length} memories.

Topic: ${tag}
Partials (newest content prioritized in the first partial):
${partials.map((p, i) => `[P${i + 1}] ${p}`).join('\n\n')}

Rules:
- Output a SINGLE paragraph (3-6 sentences, 60-220 words).
- Preserve specific entity names, dates, numbers, and identifiers from the partials verbatim.
- Resolve any cross-partial conflicts toward the FIRST partial (newest).
- Drop redundant phrasing across partials.
- Use plain prose. No lists. No preamble.`;
    try {
      const raw = await chatCompletion({
        model: SYNTHESIS_MODEL,
        messages: [{ role: 'user', content: reducerPrompt }],
        temperature: 0.12,
        max_tokens: 500,
      });
      return String(raw || '').trim();
    } catch (err) {
      this.logger.warn(`[cognition] drift reducer failed: ${err.message} — returning first partial`);
      return partials[0];
    }
  }

  async _writeSummaryMemory({ orgId, userId, project, tag, members, content, partIndex = 0, partCount = 1 }) {
    const sourceIds = members.map(m => m.id);
    // FULL UNION of every tag from every source — no filter. Canonical
    // inherits all routing oracles (filename:, doc-hash:, entity:, page:,
    // heading:, kind:, section:, topic:, plus any ad-hoc tags). Tag
    // explosion is acceptable: GIN index on tags handles it.
    const unionedTags = new Set();
    for (const m of members) {
      for (const t of (m.tags || [])) {
        if (typeof t === 'string' && t.length > 0) unionedTags.add(t);
      }
    }
    // Canonical identity tags — added last so they always win on dedupe.
    unionedTags.add('canonical-summary');
    unionedTags.add(`topic:${tag}`);
    unionedTags.add('cognition-loop');
    unionedTags.add('drift-compaction');
    const summaryTags = Array.from(unionedTags);

    const partSuffix = partCount > 1 ? ` part ${partIndex + 1}/${partCount}` : '';
    const created = await this.prisma.memory.create({
      data: {
        id: crypto.randomUUID(),
        userId,
        orgId,
        project: project || null,
        memoryType: 'summary',
        title: `Canonical: ${tag} (${members.length} memories${partSuffix})`,
        content,
        tags: summaryTags,
        isLatest: true,
        importanceScore: 0.85,
        sourceMetadata: {
          create: {
            sourceType: 'cognition-loop',
            sourceId: `compact:${tag}:${partIndex + 1}of${partCount}:${Date.now()}`,
            metadata: {
              compacted_at: new Date().toISOString(),
              topic: tag,
              source_count: members.length,
              source_ids: sourceIds,
              part_index: partIndex,
              part_count: partCount,
              model: SYNTHESIS_MODEL,
              generator: 'cognition-loop.drift-compact',
              lossless: true,
            },
          },
        },
      },
      select: { id: true },
    }).catch(err => {
      this.logger.warn(`[cognition] write summary failed: ${err.message}`);
      return null;
    });
    return created;
  }
}
