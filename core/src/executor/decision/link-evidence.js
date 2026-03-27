// core/src/executor/decision/link-evidence.js

/**
 * Decision Intelligence — Evidence Linker
 *
 * Cross-platform search for corroborating and conflicting evidence.
 * Uses existing searchMemories infrastructure.
 *
 * @module executor/decision/link-evidence
 */

/**
 * Link cross-platform evidence for a decision.
 * @param {{ decision_statement: string, tags: string[], source_platform: string, scope?: object }} input
 * @param {object} memoryStore - PrismaGraphStore with searchMemories()
 * @returns {Promise<{ supporting: object[], conflicting: object[], evidence_strength: number, related_decisions: object[] }>}
 */
export async function linkEvidence(input, memoryStore) {
  if (!memoryStore?.searchMemories) {
    return { supporting: [], conflicting: [], evidence_strength: 0, related_decisions: [] };
  }

  const { decision_statement, tags = [], source_platform, scope } = input;

  // Search for related content across all platforms
  const results = await memoryStore.searchMemories({
    query: decision_statement,
    n_results: 20,
    tags: tags.length ? tags : undefined,
    project: scope?.project,
  });

  const supporting = [];
  const conflicting = [];
  const related_decisions = [];

  for (const r of results) {
    if (r.score < 0.2) continue; // too weak

    const evidence = {
      platform: r.source_platform || 'unknown',
      ref_id: r.id,
      snippet: (r.content || '').substring(0, 200),
      score: r.score,
      tags: r.tags,
      timestamp: r.created_at,
    };

    // Skip same-platform same-content
    if (r.source_platform === source_platform && r.score > 0.95) continue;

    // Check if this is a related decision
    if (r.memory_type === 'decision') {
      related_decisions.push({
        id: r.id,
        relationship_type: 'related',
        statement: r.content?.substring(0, 100),
      });
      continue;
    }

    // Simple heuristic: high similarity = supporting, contradicting keywords = conflicting
    const hasContradiction = /\b(but|however|disagree|instead|rather|won't|shouldn't|against)\b/i.test(r.content || '');
    if (hasContradiction && r.score > 0.3) {
      conflicting.push(evidence);
    } else {
      supporting.push(evidence);
    }
  }

  // Evidence strength: based on unique platforms and count
  const uniquePlatforms = new Set(supporting.map(e => e.platform));
  const evidence_strength = Math.min(1, (supporting.length * 0.2) + (uniquePlatforms.size * 0.3));

  return {
    supporting: supporting.slice(0, 10),
    conflicting: conflicting.slice(0, 5),
    evidence_strength: +evidence_strength.toFixed(2),
    related_decisions,
  };
}
