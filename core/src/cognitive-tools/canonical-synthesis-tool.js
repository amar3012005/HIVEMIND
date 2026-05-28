import { CognitiveTool, clusterHash, isRestatement, capConfidence, jaccard } from './base-tool.js';

const CONFIDENCE_FLOOR = Number(process.env.CANONICAL_CONFIDENCE_FLOOR || 0.7);
const COOLDOWN_HOURS   = Number(process.env.CANONICAL_COOLDOWN_HOURS   || 1);
// Tier window: only assess verifications from the last N hours so 1h ticks
// don't reprocess the same backlog every cycle.
const WINDOW_HOURS     = Number(process.env.CANONICAL_WINDOW_HOURS     || 1);

/**
 * Canonical fact synthesizer.
 *
 * Trigger: ≥2 likely_true verifications share ≥1 evidence memory id.
 * Cluster hash: sha256(topic + sorted evidence_ids).
 * Cooldown: 6h per cluster_hash per org.
 * Dedup: existing canonical with same hash → delta-update revision instead of new write.
 */
export class CanonicalSynthesisTool extends CognitiveTool {
  get name() { return 'canonical_synthesis'; }
  get cognitiveRole() { return 'canonical'; }

  async assess({ verifications, orgId }) {
    if (!Array.isArray(verifications) || verifications.length === 0) {
      return { applicable: false, reason: 'no_verifications' };
    }
    // Tier window filter: only verifications created within WINDOW_HOURS.
    const windowMs = WINDOW_HOURS * 60 * 60 * 1000;
    const sinceTs = Date.now() - windowMs;
    const inWindow = verifications.filter((v) => {
      const ts = v?.timestamp ? new Date(v.timestamp).getTime() : Date.now();
      return ts >= sinceTs;
    });
    if (inWindow.length === 0) return { applicable: false, reason: 'no_verifications_in_window' };
    const liked = inWindow.filter((v) => v.content?.verdict === 'likely_true');
    if (liked.length < 2) return { applicable: false, reason: 'fewer_than_2_likely_true' };

    // Find shared evidence ids appearing in ≥2 liked verifications.
    const evCount = new Map();
    for (const v of liked) {
      for (const id of (v.content?.related_memory_ids || v.content?.evidence_refs || [])) {
        evCount.set(id, (evCount.get(id) || 0) + 1);
      }
    }
    const sharedIds = [...evCount.entries()].filter(([, n]) => n >= 2).map(([id]) => id);
    if (sharedIds.length === 0) return { applicable: false, reason: 'no_shared_evidence' };

    // Pull topic from the liked verifications' summaries: pick the most
    // frequent non-stopword token.
    const tokenFreq = new Map();
    const STOP = new Set(['the','and','for','that','with','from','this','have','will','are','was','were','been','one','two','more','about','into','only','also','can','any','its','their','our']);
    for (const v of liked) {
      const sum = (v.content?.summary || '').toLowerCase();
      for (const tok of sum.match(/[a-z][a-z0-9_-]{3,}/g) || []) {
        if (STOP.has(tok)) continue;
        tokenFreq.set(tok, (tokenFreq.get(tok) || 0) + 1);
      }
    }
    const topic = [...tokenFreq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'canonical';

    const sortedEvidence = [...new Set(sharedIds)].sort();
    const hash = clusterHash(`${topic}:${sortedEvidence.join(',')}`);

    if (await this.isOnCooldown(orgId, hash, { hours: COOLDOWN_HOURS })) {
      return { applicable: false, reason: 'cooldown', cluster_hash: hash };
    }
    if (await this.hasOpenProposal(orgId, hash, this.name, { hours: COOLDOWN_HOURS })) {
      return { applicable: false, reason: 'open_proposal_exists', cluster_hash: hash };
    }

    return {
      applicable: true,
      topic,
      evidence_ids: sortedEvidence.slice(0, 12),
      cluster_hash: hash,
      confidence: Math.min(0.95, 0.6 + 0.05 * liked.length + 0.04 * sharedIds.length),
    };
  }

  async execute({ orgId, userId, topic, evidence_ids, cluster_hash, confidence, dryRun = false }) {
    if (!orgId) return { status: 'failed', error: 'orgId_required' };
    if (!Array.isArray(evidence_ids) || evidence_ids.length < 2) {
      return { status: 'failed', error: 'need_at_least_2_evidence' };
    }
    if (dryRun) return { status: 'dry_run', topic, evidence_count: evidence_ids.length };

    // Re-check cooldown — Turing may have proposed before another run wrote it.
    if (cluster_hash && await this.isOnCooldown(orgId, cluster_hash, { hours: COOLDOWN_HOURS })) {
      return { status: 'skipped', reason: 'cooldown' };
    }

    // Fetch evidence memories for the LLM prompt.
    const members = await this._fetchMembers(evidence_ids);
    if (members.length < 2) return { status: 'failed', error: 'evidence_not_fetchable' };

    // Dedup: if an existing canonical with same hash exists, delta-update.
    const existing = cluster_hash ? await this.findExistingByHash(orgId, cluster_hash) : null;

    const loop = await this.getLoop();
    if (!loop) return { status: 'failed', error: 'cognition_loop_unavailable' };

    let llmResult = null;
    let tokensUsed = 0;
    try {
      llmResult = await loop._llmCanonicalFact(topic, members);
    } catch (err) {
      return { status: 'failed', error: `llm: ${err.message}` };
    }
    if (!llmResult?.canonical_fact) return { status: 'failed', error: 'llm_empty' };
    tokensUsed = Number(llmResult.tokens_used || 0);
    this.tokensUsedLifetime += tokensUsed;

    const llmConf = Number(llmResult.confidence ?? confidence ?? 0.7);
    if (llmConf < CONFIDENCE_FLOOR) {
      return { status: 'skipped', reason: 'confidence_below_floor', llm_confidence: llmConf };
    }
    if (isRestatement(llmResult.canonical_fact, members)) {
      return { status: 'skipped', reason: 'restatement_detected' };
    }

    // Evidence-set ≥80% overlap dedup against ALL existing canonicals on same topic.
    const sameTopicCanonicals = await this.prisma.memory.findMany({
      where: {
        orgId, deletedAt: null,
        cognitiveLayerRole: 'canonical',
        tags: { has: `topic:${topic.slice(0, 80)}` },
      },
      select: { id: true, synthesisEvidenceIds: true, synthesisRevision: true, synthesisClusterHash: true },
      take: 50,
    });
    for (const c of sameTopicCanonicals) {
      const j = jaccard(c.synthesisEvidenceIds || [], evidence_ids);
      if (j >= 0.8 && c.synthesisClusterHash !== cluster_hash) {
        return { status: 'skipped', reason: 'evidence_overlap_with_existing', overlap: j, existing_id: c.id };
      }
    }

    // Write via cognition-loop helper so smart-routing / entity-co-mention fires.
    const written = await loop._writeSynthMemory({
      orgId, userId,
      project: members[0].project || null,
      sourceType: 'canonical-fact',
      tag: topic,
      members,
      content: llmResult.canonical_fact,
      confidence: capConfidence(llmConf, existing?.synthesisRevision || 1),
      evidenceIds: llmResult.supporting_memory_ids?.length ? llmResult.supporting_memory_ids : evidence_ids,
      clusterHash: cluster_hash,
      extraMeta: { generator: 'governance.turing.tool', llm_tokens: tokensUsed, llm_confidence: llmConf },
    }).catch((err) => ({ error: err.message }));

    if (written?.error) return { status: 'failed', error: written.error };

    // Cognitive role tagging — graph-engine should propagate but bake-in for safety.
    if (written?.id) {
      try {
        await this.prisma.memory.update({
          where: { id: written.id },
          data: { cognitiveLayerRole: 'canonical' },
        });
      } catch (updErr) {
        this.logger?.warn?.(`[canonical-tool] role update failed: ${updErr.message}`);
      }
      // Link Derives edges from canonical → each evidence.
      try { await loop._linkDerivesEdges(written.id, members, 'canonical-fact', topic); } catch {}
    }

    if (cluster_hash) await this.recordCooldown(orgId, cluster_hash);

    return {
      status: 'executed',
      memory_id: written?.id || null,
      content_preview: llmResult.canonical_fact.slice(0, 200),
      evidence_count: members.length,
      tokens_used: tokensUsed,
      delta_update: !!existing,
    };
  }

  async _fetchMembers(ids) {
    if (!this.prisma) return [];
    const rows = await this.prisma.memory.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, content: true, title: true, tags: true, project: true, orgId: true, userId: true, createdAt: true, documentDate: true },
    });
    return rows;
  }
}
