import { CognitiveTool, clusterHash, isRestatement, capConfidence } from './base-tool.js';

const CONFIDENCE_FLOOR = Number(process.env.BRIDGE_CONFIDENCE_FLOOR || 0.7);
const COOLDOWN_HOURS   = Number(process.env.BRIDGE_COOLDOWN_HOURS   || 4);
// Bootstrap-friendly default: 48h. Bridge needs cross-cluster signal which
// rarely forms in 4h on a young memory store.
const WINDOW_HOURS     = Number(process.env.BRIDGE_WINDOW_HOURS     || 48);

/**
 * Cross-cluster bridge synthesizer.
 *
 * Trigger: 2 likely_true clusters with disjoint evidence sets that share
 * at least one entity tag.
 * LLM call: cognition-loop._llmSynthesisBridge produces the bridge text.
 */
export class BridgeSynthesisTool extends CognitiveTool {
  get name() { return 'bridge_synthesis'; }
  get cognitiveRole() { return 'bridge'; }

  async assess({ verifications, orgId }) {
    // Tier window filter: only verifications from last WINDOW_HOURS.
    const sinceTs = Date.now() - WINDOW_HOURS * 60 * 60 * 1000;
    const inWindow = (verifications || []).filter((v) => {
      const ts = v?.timestamp ? new Date(v.timestamp).getTime() : Date.now();
      return ts >= sinceTs;
    });
    const liked = inWindow.filter((v) => v.content?.verdict === 'likely_true');
    if (liked.length < 2) return { applicable: false, reason: 'fewer_than_2_likely_true' };

    const evidenceOf = (v) => new Set(v.content?.related_memory_ids || v.content?.evidence_refs || []);

    // Pull real entity:* tags from the referenced memories. Verifications'
    // synthetic 'verification' tokens are useless for cluster matching.
    const allEvidenceIds = [...new Set(liked.flatMap((v) => [...evidenceOf(v)]))];
    let tagMap = new Map(); // memId -> entity tag set
    if (this.prisma && allEvidenceIds.length) {
      try {
        const rows = await this.prisma.memory.findMany({
          where: { id: { in: allEvidenceIds }, deletedAt: null },
          select: { id: true, tags: true },
        });
        for (const r of rows) {
          const ents = (r.tags || [])
            .filter((t) => typeof t === 'string' && t.startsWith('entity:'))
            .map((t) => t.slice(7).toLowerCase());
          tagMap.set(r.id, new Set(ents));
        }
      } catch (err) {
        this.logger?.warn?.(`[bridge] tag fetch failed: ${err.message}`);
      }
    }
    const entitiesOf = (v) => {
      const out = new Set();
      for (const memId of evidenceOf(v)) {
        const ents = tagMap.get(memId);
        if (ents) for (const e of ents) out.add(e);
      }
      if (out.size > 0) return out;
      // Last-resort fallback only when memories have no entity tags at all.
      const tokens = (v.content?.summary || '').match(/\b[A-Z][a-zA-Z0-9_-]{2,}\b/g) || [];
      return new Set(tokens.map((t) => t.toLowerCase()));
    };

    let best = null;
    for (let i = 0; i < liked.length; i += 1) {
      for (let j = i + 1; j < liked.length; j += 1) {
        const ei = evidenceOf(liked[i]);
        const ej = evidenceOf(liked[j]);
        const disjoint = [...ei].every((id) => !ej.has(id));
        if (!disjoint || ei.size === 0 || ej.size === 0) continue;
        const eA = entitiesOf(liked[i]);
        const eB = entitiesOf(liked[j]);
        const shared = [...eA].find((t) => eB.has(t));
        if (!shared) continue;
        const score = (ei.size + ej.size) / 2;
        if (!best || score > best.score) {
          best = {
            score,
            sharedEntity: shared,
            evidenceA: [...ei],
            evidenceB: [...ej],
            confidence: 0.7 + Math.min(0.2, 0.02 * (ei.size + ej.size)),
          };
        }
      }
    }
    if (!best) return { applicable: false, reason: 'no_bridge_pair' };

    const allIds = [...best.evidenceA, ...best.evidenceB].sort();
    const hash = clusterHash(`bridge:${best.sharedEntity}:${allIds.join(',')}`);
    if (await this.isOnCooldown(orgId, hash, { hours: COOLDOWN_HOURS })) {
      return { applicable: false, reason: 'cooldown', cluster_hash: hash };
    }
    if (await this.hasOpenProposal(orgId, hash, this.name, { hours: COOLDOWN_HOURS })) {
      return { applicable: false, reason: 'open_proposal_exists', cluster_hash: hash };
    }

    return {
      applicable: true,
      bridge_tag: best.sharedEntity,
      evidence_ids_a: best.evidenceA.slice(0, 8),
      evidence_ids_b: best.evidenceB.slice(0, 8),
      cluster_hash: hash,
      confidence: best.confidence,
    };
  }

  async execute({ orgId, userId, bridge_tag, evidence_ids_a, evidence_ids_b, cluster_hash, confidence, dryRun = false }) {
    if (!orgId) return { status: 'failed', error: 'orgId_required' };
    if (!Array.isArray(evidence_ids_a) || !Array.isArray(evidence_ids_b)) {
      return { status: 'failed', error: 'evidence_a_b_required' };
    }
    if (dryRun) return { status: 'dry_run', shared_entity: bridge_tag };

    if (cluster_hash && await this.isOnCooldown(orgId, cluster_hash, { hours: COOLDOWN_HOURS })) {
      return { status: 'skipped', reason: 'cooldown' };
    }

    const membersA = await this._fetch(evidence_ids_a);
    const membersB = await this._fetch(evidence_ids_b);
    if (membersA.length < 1 || membersB.length < 1) {
      return { status: 'failed', error: 'evidence_not_fetchable' };
    }

    const loop = await this.getLoop();
    if (!loop) return { status: 'failed', error: 'cognition_loop_unavailable' };

    let llmResult = null;
    try {
      llmResult = await loop._llmSynthesisBridge(bridge_tag, membersA, bridge_tag, membersB);
    } catch (err) {
      return { status: 'failed', error: `llm: ${err.message}` };
    }
    if (!llmResult?.bridge) return { status: 'failed', error: 'llm_empty' };
    const tokensUsed = Number(llmResult.tokens_used || 0);
    this.tokensUsedLifetime += tokensUsed;

    const llmConf = Number(llmResult.confidence ?? confidence ?? 0.7);
    if (llmConf < CONFIDENCE_FLOOR) {
      return { status: 'skipped', reason: 'confidence_below_floor', llm_confidence: llmConf };
    }
    const allMembers = [...membersA, ...membersB];
    if (isRestatement(llmResult.bridge, allMembers)) {
      return { status: 'skipped', reason: 'restatement_detected' };
    }

    const existing = cluster_hash ? await this.findExistingByHash(orgId, cluster_hash) : null;
    const written = await loop._writeSynthMemory({
      orgId, userId,
      project: allMembers[0].project || null,
      sourceType: 'synthesis-bridge',
      tag: bridge_tag,
      members: allMembers,
      content: llmResult.bridge,
      confidence: capConfidence(llmConf, existing?.synthesisRevision || 1),
      evidenceIds: [...evidence_ids_a, ...evidence_ids_b],
      clusterHash: cluster_hash,
      extraMeta: { generator: 'governance.turing.tool', llm_tokens: tokensUsed, bridge_tag, llm_confidence: llmConf },
    }).catch((err) => ({ error: err.message }));

    if (written?.error) return { status: 'failed', error: written.error };

    if (written?.id) {
      try {
        await this.prisma.memory.update({
          where: { id: written.id },
          data: { cognitiveLayerRole: 'bridge' },
        });
      } catch (updErr) {
        this.logger?.warn?.(`[bridge-tool] role update failed: ${updErr.message}`);
      }
      try { await loop._linkDerivesEdges(written.id, allMembers, 'synthesis-bridge', bridge_tag); } catch {}
    }

    if (cluster_hash) await this.recordCooldown(orgId, cluster_hash);

    return {
      status: 'executed',
      memory_id: written?.id || null,
      content_preview: llmResult.bridge.slice(0, 200),
      bridge_tag,
      tokens_used: tokensUsed,
      delta_update: !!existing,
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
