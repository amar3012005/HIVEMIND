import { CognitiveTool, clusterHash } from './base-tool.js';

const MIN_MEMBERS    = Number(process.env.COMPRESSION_MIN_MEMBERS || 3);
const COOLDOWN_HOURS = Number(process.env.COMPRESSION_COOLDOWN_HOURS || 12);

/**
 * Cluster compression — collapses N similar memories into a canonical-summary.
 *
 * Uses cognition-loop._buildLosslessSummary (deterministic concat with
 * separators — no LLM, preserves all source content). When members ≥ 24
 * we ALSO call _llmDriftSummary for a higher-density rewrite.
 */
export class CompressionTool extends CognitiveTool {
  get name() { return 'compression'; }
  get cognitiveRole() { return 'compression'; }

  async assess({ verifications, orgId }) {
    if (!Array.isArray(verifications) || verifications.length < MIN_MEMBERS) {
      return { applicable: false, reason: 'fewer_than_min_verifications' };
    }
    // Group verifications by hypothesis topic. Compression fires when a
    // single topic accumulates ≥ MIN_MEMBERS verifications.
    const groups = new Map();
    const STOP = new Set(['the','and','for','that','with','from','this','have','will','are','was','were','been','one','two','more','about','into','only','also','can','any','its','their','our','verification','summary']);
    for (const v of verifications) {
      const sum = (v.content?.summary || '').toLowerCase();
      const topic = (sum.match(/[a-z][a-z0-9_-]{3,}/g) || []).find((t) => !STOP.has(t));
      if (!topic) continue;
      if (!groups.has(topic)) groups.set(topic, []);
      groups.get(topic).push(v);
    }

    let best = null;
    for (const [topic, group] of groups) {
      if (group.length < MIN_MEMBERS) continue;
      const evidenceIds = [...new Set(group.flatMap((v) => v.content?.related_memory_ids || []))];
      if (evidenceIds.length < MIN_MEMBERS) continue;
      const score = group.length + evidenceIds.length * 0.5;
      if (!best || score > best.score) {
        best = { topic, evidence_ids: evidenceIds.slice(0, 24), score };
      }
    }
    if (!best) return { applicable: false, reason: 'no_topic_cluster_min_size' };

    const hash = clusterHash(`compression:${best.topic}:${best.evidence_ids.sort().join(',')}`);
    if (await this.isOnCooldown(orgId, hash, { hours: COOLDOWN_HOURS })) {
      return { applicable: false, reason: 'cooldown', cluster_hash: hash };
    }
    if (await this.hasOpenProposal(orgId, hash, this.name, { hours: COOLDOWN_HOURS })) {
      return { applicable: false, reason: 'open_proposal_exists', cluster_hash: hash };
    }
    return {
      applicable: true,
      topic: best.topic,
      evidence_ids: best.evidence_ids,
      cluster_hash: hash,
      confidence: Math.min(0.92, 0.65 + 0.02 * best.evidence_ids.length),
    };
  }

  async execute({ orgId, userId, topic, evidence_ids, cluster_hash, dryRun = false }) {
    if (!orgId) return { status: 'failed', error: 'orgId_required' };
    if (!Array.isArray(evidence_ids) || evidence_ids.length < MIN_MEMBERS) {
      return { status: 'failed', error: 'need_at_least_3_evidence' };
    }
    if (dryRun) return { status: 'dry_run', topic, count: evidence_ids.length };

    if (cluster_hash && await this.isOnCooldown(orgId, cluster_hash, { hours: COOLDOWN_HOURS })) {
      return { status: 'skipped', reason: 'cooldown' };
    }

    const members = await this._fetch(evidence_ids);
    if (members.length < MIN_MEMBERS) return { status: 'failed', error: 'evidence_not_fetchable' };

    const loop = await this.getLoop();
    if (!loop) return { status: 'failed', error: 'cognition_loop_unavailable' };

    // Lossless deterministic summary (no LLM) is the canonical path.
    let content = '';
    try {
      content = await loop._buildLosslessSummary(topic, members, { partIndex: 0, partCount: 1 });
    } catch (err) {
      return { status: 'failed', error: `summary_build: ${err.message}` };
    }
    if (!content) return { status: 'failed', error: 'summary_empty' };

    // Dedup: existing compression with same hash → skip (compression is deterministic).
    const existing = cluster_hash ? await this.findExistingByHash(orgId, cluster_hash) : null;
    if (existing) {
      return { status: 'skipped', reason: 'duplicate', existing_id: existing.id };
    }

    // Pick a non-null tag for the title. Falls back to the most common
    // entity:* tag across members, then to 'cluster'.
    let effectiveTag = topic && topic !== 'null' ? topic : null;
    if (!effectiveTag) {
      const entityCounts = new Map();
      for (const m of members) {
        for (const t of (m.tags || [])) {
          if (typeof t === 'string' && t.startsWith('entity:')) {
            const name = t.slice(7).replace(/_/g, ' ');
            entityCounts.set(name, (entityCounts.get(name) || 0) + 1);
          }
        }
      }
      const best = [...entityCounts.entries()].sort((a, b) => b[1] - a[1])[0];
      effectiveTag = best?.[0] || 'cluster';
    }

    // Write via cognition-loop helper for engine routing.
    const written = await loop._writeSummaryMemory({
      orgId, userId,
      project: members[0].project || null,
      tag: effectiveTag,
      members,
      content,
      partIndex: 0,
      partCount: 1,
    }).catch((err) => ({ error: err.message }));

    if (written?.error) return { status: 'failed', error: written.error };

    if (written?.id) {
      try {
        await this.prisma.memory.update({
          where: { id: written.id },
          data: {
            cognitiveLayerRole: 'compression',
            synthesisClusterHash: cluster_hash,
            synthesisEvidenceIds: evidence_ids,
          },
        });
      } catch (updErr) {
        this.logger?.warn?.(`[compression-tool] post-write update failed: ${updErr.message}`);
      }
      try { await loop._linkDerivesEdges(written.id, members, 'compression', topic); } catch {}
    }

    if (cluster_hash) await this.recordCooldown(orgId, cluster_hash);

    return {
      status: 'executed',
      memory_id: written?.id || null,
      content_preview: content.slice(0, 300),
      evidence_count: members.length,
      tokens_used: 0, // deterministic — no LLM
    };
  }

  async _fetch(ids) {
    if (!this.prisma || !ids?.length) return [];
    return this.prisma.memory.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, content: true, title: true, tags: true, project: true, orgId: true, userId: true, createdAt: true, documentDate: true },
    });
  }
}
