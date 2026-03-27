// core/src/executor/decision/recall-decision.js

/**
 * Decision Intelligence — Decision Recall
 *
 * Provenance-aware decision retrieval with multi-signal ranking.
 *
 * @module executor/decision/recall-decision
 */

/**
 * Recall decisions with provenance-aware multi-signal ranking.
 * @param {{ query: string, scope?: object, project?: string, top_k?: number }} input
 * @param {object} memoryStore
 * @returns {Promise<{ decisions: object[], total_found: number, done: boolean }>}
 */
export async function recallDecision(input, memoryStore) {
  if (!memoryStore?.searchMemories) {
    return { decisions: [], total_found: 0, done: true };
  }

  const { query, scope, project, top_k = 5 } = input;

  const results = await memoryStore.searchMemories({
    query,
    memory_type: 'decision',
    project: project || scope?.project,
    n_results: top_k * 3, // over-fetch for re-ranking
  });

  const now = Date.now();
  const decisions = results.map(r => {
    const meta = r.metadata || {};
    const semanticMatch = r.score || 0;
    const isValidated = meta.status === 'validated' ? 1 : 0.5;
    const evidenceStrength = meta.evidence_strength || 0;
    const ageMs = now - new Date(r.created_at || 0).getTime();
    const recencyScore = Math.max(0, 1 - (ageMs / (30 * 86400000))); // decay over 30 days
    const scopeMatch = (project && meta.scope?.project === project) ? 1 : 0.5;
    const contradictionPenalty = (meta.evidence?.conflicting?.length || 0) > 0 ? 0.2 : 0;

    const recall_score =
      0.35 * semanticMatch +
      0.20 * isValidated +
      0.15 * evidenceStrength +
      0.15 * recencyScore +
      0.10 * scopeMatch +
      0.05 * (1 - contradictionPenalty);

    // Completeness: how much of the decision object is filled
    const fields = [meta.rationale, meta.evidence?.supporting?.length, meta.participants?.length];
    const completeness_score = fields.filter(Boolean).length / fields.length;

    return {
      decision_id: r.id,
      decision_statement: r.content,
      decision_type: meta.decision_type,
      rationale: meta.rationale,
      evidence: meta.evidence,
      participants: meta.participants,
      confidence: meta.confidence,
      evidence_strength: meta.evidence_strength,
      status: meta.status,
      scope: meta.scope,
      detected_at: meta.detected_at,
      recall_score: +recall_score.toFixed(3),
      completeness_score: +completeness_score.toFixed(2),
    };
  });

  // Sort by recall_score descending
  decisions.sort((a, b) => b.recall_score - a.recall_score);

  return {
    decisions: decisions.slice(0, top_k),
    total_found: decisions.length,
    done: true,
  };
}
