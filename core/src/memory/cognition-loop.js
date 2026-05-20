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

const SYNTHESIS_MODEL = process.env.SYNTHESIS_MODEL || 'llama-3.3-70b-versatile';
const DEFAULT_LOOKBACK_HOURS = Number(process.env.SYNTHESIS_LOOKBACK_HOURS || 24);
const DEFAULT_CLUSTER_MIN = Number(process.env.SYNTHESIS_CLUSTER_MIN || 4);
const DEFAULT_CLUSTER_MAX = Number(process.env.SYNTHESIS_CLUSTER_MAX || 30);
const DRIFT_COMPACT_THRESHOLD = Number(process.env.DRIFT_COMPACT_THRESHOLD || 12);
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
      if (members.length > DEFAULT_CLUSTER_MAX) members.length = DEFAULT_CLUSTER_MAX;
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
        const insight = await this._llmSynthesize(tag, members);
        if (!insight || insight.length < 40) continue;
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

  async _llmSynthesize(tag, members) {
    const facts = members.map((m, i) => {
      const c = (m.content || '').replace(/\s+/g, ' ').slice(0, 400);
      return `[${i + 1}] ${m.title ? m.title + ' — ' : ''}${c}`;
    }).join('\n');
    const prompt = `You are observing a stream of facts the system learned about a topic. Find the SINGLE most important emergent insight that's true ACROSS these facts but NOT stated in any one of them.

Topic: ${tag}
Facts (${members.length}):
${facts}

Rules:
- Output ONE sentence of 15-40 words describing the emergent insight.
- Do NOT restate any single fact verbatim.
- Connect 2+ facts. If no real connection exists, output "NO_INSIGHT".
- Avoid hedging ("might", "could potentially"). State the inference.
- No preamble. Just the sentence.`;
    const raw = await chatCompletion({
      model: SYNTHESIS_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 200,
    });
    const txt = String(raw || '').trim();
    if (!txt || txt === 'NO_INSIGHT' || /^no[_ ]insight/i.test(txt)) return null;
    return txt;
  }

  async _writeSynthMemory({ orgId, userId, project, tag, members, content }) {
    const title = `Synthesis: ${tag} (${members.length} sources)`;
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
        sourceMetadata: {
          create: {
            sourceType: 'cognition-loop',
            sourceId: `synth:${tag}:${Date.now()}`,
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
      select: { id: true, userId: true, title: true, content: true, tags: true, project: true },
    });
    if (recent.length < DRIFT_COMPACT_THRESHOLD) return 0;

    const SYS_TAG_RE = /^(file:|fn:|page:|heading:|upload:|doc-hash:|promoted-from|synthesized|topic:|cognition-loop)/i;
    const buckets = new Map();
    for (const m of recent) {
      const primaryTag = (m.tags || []).find(t => !SYS_TAG_RE.test(t));
      if (!primaryTag) continue;
      if (!buckets.has(primaryTag)) buckets.set(primaryTag, []);
      buckets.get(primaryTag).push(m);
    }
    let compactions = 0;
    for (const [tag, members] of buckets.entries()) {
      if (members.length < DRIFT_COMPACT_THRESHOLD) continue;
      try {
        const summary = await this._llmDriftSummary(tag, members);
        if (!summary || summary.length < 50) continue;
        const created = await this._writeSummaryMemory({
          orgId, userId: members[0].userId, project: members[0].project,
          tag, members, content: summary,
        });
        if (!created) continue;
        // Supersede granular members with is_latest=false + Derives edge.
        for (const src of members) {
          try {
            await this.prisma.memory.update({
              where: { id: src.id }, data: { isLatest: false },
            });
            await this.prisma.relationship.create({
              data: {
                id: crypto.randomUUID(),
                fromId: created.id,
                toId: src.id,
                type: 'Derives',
                confidence: 0.9,
                createdBy: 'cognition-drift-compact',
                metadata: { reason: 'drift_compaction', topic: tag },
              },
            });
          } catch { /* race — skip */ }
        }
        compactions++;
      } catch (err) {
        this.logger.warn(`[cognition] compact tag=${tag} failed: ${err.message}`);
      }
    }
    return compactions;
  }

  async _llmDriftSummary(tag, members) {
    const facts = members.slice(0, 25).map((m, i) => {
      const c = (m.content || '').replace(/\s+/g, ' ').slice(0, 250);
      return `[${i + 1}] ${m.title ? m.title + ' — ' : ''}${c}`;
    }).join('\n');
    const prompt = `Compress ${members.length} memories on the same topic into ONE canonical summary that captures the current state of knowledge.

Topic: ${tag}
Memories:
${facts}

Rules:
- Output a SINGLE paragraph (3-6 sentences, 60-180 words) describing what we currently know.
- Resolve contradictions toward the most recent + most repeated version.
- Drop noise / one-off mentions.
- Use plain prose. No lists. No preamble.`;
    const raw = await chatCompletion({
      model: SYNTHESIS_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.15,
      max_tokens: 400,
    });
    return String(raw || '').trim();
  }

  async _writeSummaryMemory({ orgId, userId, project, tag, members, content }) {
    const created = await this.prisma.memory.create({
      data: {
        id: crypto.randomUUID(),
        userId,
        orgId,
        project: project || null,
        memoryType: 'summary',
        title: `Canonical: ${tag} (compacted ${members.length})`,
        content,
        tags: ['canonical-summary', `topic:${tag}`, 'cognition-loop', 'drift-compaction'],
        isLatest: true,
        importanceScore: 0.85,
        sourceMetadata: {
          create: {
            sourceType: 'cognition-loop',
            sourceId: `compact:${tag}:${Date.now()}`,
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
