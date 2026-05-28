import { CognitiveTool, clusterHash, jaccard } from './base-tool.js';

const MIN_MEMBERS    = Number(process.env.COMPRESSION_MIN_MEMBERS || 3);
const COOLDOWN_HOURS = Number(process.env.COMPRESSION_COOLDOWN_HOURS || 12);
const WINDOW_HOURS   = Number(process.env.COMPRESSION_WINDOW_HOURS || 12);
const MIN_ENTITIES   = Number(process.env.COMPRESSION_MIN_ENTITIES || 2);
const MIN_PURITY     = Number(process.env.COMPRESSION_MIN_PURITY || 0.5);
const DRIFT_SPLIT    = Number(process.env.COMPRESSION_DRIFT_SPLIT || 0.5);

/**
 * Cluster compression — collapses N similar memories from the last
 * WINDOW_HOURS into a canonical-summary.
 *
 * Cluster keying is ENTITY-SET based (not weak topic-word regex). Memories
 * share a cluster when their top entity:* tags overlap. Hash is stable so
 * re-runs APPEND new members instead of creating parallel canonicals.
 *
 * Re-compression behaviour:
 *   - Hash exists + entity-overlap >= 50% → APPEND new members, bump revision
 *   - Hash novel                          → CREATE new compression
 *   - Hash exists + drift > 50%           → SPLIT (seal old, create new)
 */
export class CompressionTool extends CognitiveTool {
  get name() { return 'compression'; }
  get cognitiveRole() { return 'compression'; }

  /**
   * Pull last WINDOW_HOURS of non-compression memories for the org and
   * cluster them by entity-set. Returns the best applicable cluster.
   */
  async assess({ orgId } = {}) {
    if (!this.prisma || !orgId) {
      return { applicable: false, reason: 'no_prisma_or_org' };
    }
    const since = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000);

    let members;
    try {
      members = await this.prisma.memory.findMany({
        where: {
          orgId,
          deletedAt: null,
          createdAt: { gte: since },
          // Skip already-compressed memories so we don't re-compress canonicals.
          NOT: { cognitiveLayerRole: 'compression' },
        },
        select: {
          id: true, tags: true, content: true, title: true,
          project: true, createdAt: true, userId: true,
        },
        take: 500,
      });
    } catch (err) {
      this.logger?.warn?.(`[compression] fetch failed: ${err.message}`);
      return { applicable: false, reason: 'fetch_failed' };
    }

    if (members.length < MIN_MEMBERS) {
      return { applicable: false, reason: 'fewer_than_min_in_window' };
    }

    // Group by entity-set fingerprint. Top-3 entity tags, sorted, joined.
    const clusters = new Map(); // fingerprint -> { entitySet[], members[] }
    for (const m of members) {
      const entities = (m.tags || [])
        .filter((t) => typeof t === 'string' && t.startsWith('entity:'))
        .sort();
      if (entities.length < MIN_ENTITIES) continue;
      const fp = entities.slice(0, 3).join('|');
      if (!clusters.has(fp)) {
        clusters.set(fp, { entitySet: entities.slice(0, 3), members: [] });
      }
      clusters.get(fp).members.push({ memory: m, entities: new Set(entities) });
    }

    // Pick best cluster: size * purity.
    let best = null;
    for (const [fp, c] of clusters) {
      if (c.members.length < MIN_MEMBERS) continue;

      // Purity gate: average pairwise entity-overlap must be >= MIN_PURITY.
      const purities = [];
      for (let i = 0; i < c.members.length; i += 1) {
        for (let j = i + 1; j < c.members.length; j += 1) {
          purities.push(jaccard(c.members[i].entities, c.members[j].entities));
        }
      }
      const avgPurity = purities.length
        ? purities.reduce((a, b) => a + b, 0) / purities.length
        : 0;
      if (avgPurity < MIN_PURITY) continue;

      const score = c.members.length * (0.5 + 0.5 * avgPurity);
      if (!best || score > best.score) {
        best = {
          fingerprint: fp,
          entitySet: c.entitySet,
          members: c.members.map((x) => x.memory),
          score,
          purity: avgPurity,
        };
      }
    }
    if (!best) {
      return { applicable: false, reason: 'no_pure_entity_cluster_in_window' };
    }

    // Stable hash from entity-set (NOT topic word). Same cluster ⇒ same hash.
    const hash = clusterHash(`compression:${best.entitySet.join('|')}`);

    // Re-compression decision: check existing canonical for this hash.
    const existing = await this.findExistingByHash(orgId, hash);
    let mode = 'create';
    let appendMemberIds = best.members.map((m) => m.id);
    if (existing) {
      // Compute drift: how many NEW members vs. existing evidence set.
      const existingEvidence = new Set(existing.synthesisEvidenceIds || []);
      const newOnly = best.members.filter((m) => !existingEvidence.has(m.id));
      if (newOnly.length === 0) {
        return { applicable: false, reason: 'no_new_members_since_last', cluster_hash: hash };
      }
      const overlapRatio = (best.members.length - newOnly.length) / best.members.length;
      if (overlapRatio < DRIFT_SPLIT) {
        // Drift exceeded — split rather than pollute existing canonical.
        mode = 'split';
      } else {
        mode = 'append';
        appendMemberIds = newOnly.map((m) => m.id);
      }
    }

    if (await this.isOnCooldown(orgId, hash, { hours: COOLDOWN_HOURS })) {
      return { applicable: false, reason: 'cooldown', cluster_hash: hash };
    }
    if (await this.hasOpenProposal(orgId, hash, this.name, { hours: COOLDOWN_HOURS })) {
      return { applicable: false, reason: 'open_proposal_exists', cluster_hash: hash };
    }

    // Topic = best entity:* tag, human-readable.
    const topicTag = best.entitySet[0] || '';
    const topic = topicTag.startsWith('entity:')
      ? topicTag.slice(7).replace(/_/g, ' ')
      : 'cluster';

    return {
      applicable: true,
      topic,
      entity_set: best.entitySet,
      evidence_ids: best.members.map((m) => m.id),
      append_ids: appendMemberIds,
      mode, // 'create' | 'append' | 'split'
      existing_id: existing?.id || null,
      cluster_hash: hash,
      confidence: Math.min(0.95, 0.55 + 0.25 * best.purity + 0.02 * best.members.length),
      purity: best.purity,
      window_hours: WINDOW_HOURS,
    };
  }

  async execute({
    orgId, userId, topic, evidence_ids, append_ids, mode = 'create',
    existing_id, cluster_hash, dryRun = false,
  } = {}) {
    if (!orgId) return { status: 'failed', error: 'orgId_required' };
    if (!Array.isArray(evidence_ids) || evidence_ids.length < MIN_MEMBERS) {
      return { status: 'failed', error: 'need_at_least_3_evidence' };
    }
    if (dryRun) return { status: 'dry_run', topic, count: evidence_ids.length, mode };
    if (cluster_hash && await this.isOnCooldown(orgId, cluster_hash, { hours: COOLDOWN_HOURS })) {
      return { status: 'skipped', reason: 'cooldown' };
    }

    const members = await this._fetch(evidence_ids);
    if (members.length < MIN_MEMBERS) return { status: 'failed', error: 'evidence_not_fetchable' };

    const loop = await this.getLoop();
    if (!loop) return { status: 'failed', error: 'cognition_loop_unavailable' };

    let content = '';
    try {
      content = await loop._buildLosslessSummary(topic, members, { partIndex: 0, partCount: 1 });
    } catch (err) {
      return { status: 'failed', error: `summary_build: ${err.message}` };
    }
    if (!content) return { status: 'failed', error: 'summary_empty' };

    // ─── APPEND mode: update existing canonical with bumped revision ───
    if (mode === 'append' && existing_id) {
      try {
        const existing = await this.prisma.memory.findUnique({ where: { id: existing_id } });
        if (!existing) {
          // Fall through to create — existing got deleted between assess+exec.
        } else {
          const mergedEvidence = [
            ...new Set([
              ...(existing.synthesisEvidenceIds || []),
              ...evidence_ids,
            ]),
          ].slice(0, 50);
          const nextRevision = (existing.synthesisRevision || 1) + 1;

          // Rebuild content over union of evidence
          const allMembers = await this._fetch(mergedEvidence);
          const newContent = await loop._buildLosslessSummary(topic, allMembers, { partIndex: 0, partCount: 1 });

          await this.prisma.memory.update({
            where: { id: existing_id },
            data: {
              content: newContent || existing.content,
              title: `Canonical: ${topic} (${allMembers.length} memories · rev ${nextRevision})`,
              synthesisEvidenceIds: mergedEvidence,
              synthesisRevision: nextRevision,
              updatedAt: new Date(),
            },
          });
          await this.recordCooldown(orgId, cluster_hash);
          try {
            const newMembers = await this._fetch(append_ids || []);
            if (newMembers.length) {
              await loop._linkDerivesEdges(existing_id, newMembers, 'compression', topic);
            }
          } catch {}
          return {
            status: 'executed',
            mode: 'append',
            memory_id: existing_id,
            evidence_count: mergedEvidence.length,
            revision: nextRevision,
            tokens_used: 0,
          };
        }
      } catch (err) {
        this.logger?.warn?.(`[compression] append failed, falling back to create: ${err.message}`);
      }
    }

    // ─── CREATE / SPLIT mode: new canonical memory ───
    const written = await loop._writeSummaryMemory({
      orgId, userId,
      project: members[0].project || null,
      tag: topic,
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
            synthesisRevision: 1,
          },
        });
      } catch (updErr) {
        this.logger?.warn?.(`[compression] post-write update failed: ${updErr.message}`);
      }
      try { await loop._linkDerivesEdges(written.id, members, 'compression', topic); } catch {}
    }

    if (cluster_hash) await this.recordCooldown(orgId, cluster_hash);

    return {
      status: 'executed',
      mode: mode === 'split' ? 'split' : 'create',
      memory_id: written?.id || null,
      content_preview: content.slice(0, 300),
      evidence_count: members.length,
      tokens_used: 0,
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
