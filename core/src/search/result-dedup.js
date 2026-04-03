/**
 * Post-retrieval semantic deduplication.
 * Collapses near-duplicate search results before returning to caller.
 *
 * Strategy: Token-overlap based similarity (fast, no LLM needed).
 * Groups results by content similarity, keeps the highest-scored representative.
 */

const DEDUP_SIMILARITY_THRESHOLD = 0.70; // 70% token overlap = duplicate

/**
 * Tokenize content for comparison.
 */
function tokenize(text) {
  if (!text || typeof text !== 'string') return new Set();
  return new Set(
    text.toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2)
  );
}

/**
 * Compute Jaccard similarity between two token sets.
 */
function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  const smaller = setA.size <= setB.size ? setA : setB;
  const larger = setA.size > setB.size ? setA : setB;
  for (const token of smaller) {
    if (larger.has(token)) intersection++;
  }
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * Deduplicate an array of search results.
 *
 * @param {Array} results - Array of memory objects (must have .content and .score or .id)
 * @param {Object} options
 * @param {number} options.threshold - Similarity threshold (default 0.70)
 * @param {boolean} options.mergeTags - Merge tags from duplicates into representative
 * @returns {Array} Deduplicated results, preserving order by score
 */
export function deduplicateResults(results, options = {}) {
  if (!results || results.length <= 1) return results || [];

  const threshold = options.threshold ?? DEDUP_SIMILARITY_THRESHOLD;
  const mergeTags = options.mergeTags ?? true;

  // Tokenize all results
  const tokenized = results.map(r => ({
    result: r,
    tokens: tokenize(r.content || r.parent_chunk || ''),
    score: r.score || 0,
  }));

  // Greedy clustering: iterate in score order, skip items similar to existing representatives
  const representatives = [];
  const duplicateMap = new Map(); // representative index -> [duplicate indices]

  for (let i = 0; i < tokenized.length; i++) {
    let isDuplicate = false;

    for (let j = 0; j < representatives.length; j++) {
      const repIdx = representatives[j];
      const sim = jaccardSimilarity(tokenized[i].tokens, tokenized[repIdx].tokens);

      if (sim >= threshold) {
        isDuplicate = true;
        // Track as duplicate of this representative
        if (!duplicateMap.has(repIdx)) duplicateMap.set(repIdx, []);
        duplicateMap.get(repIdx).push(i);
        break;
      }
    }

    if (!isDuplicate) {
      representatives.push(i);
    }
  }

  // Build output: representatives with merged metadata
  return representatives.map(repIdx => {
    const rep = { ...tokenized[repIdx].result };
    const dupes = duplicateMap.get(repIdx) || [];

    if (dupes.length > 0) {
      rep._dedup = {
        duplicates_collapsed: dupes.length,
        duplicate_ids: dupes.map(d => tokenized[d].result.id).filter(Boolean),
      };

      // Merge tags from duplicates
      if (mergeTags) {
        const allTags = new Set(rep.tags || []);
        for (const d of dupes) {
          for (const t of (tokenized[d].result.tags || [])) allTags.add(t);
        }
        rep.tags = [...allTags];
      }

      // Keep highest importance score from duplicates
      for (const d of dupes) {
        const dupeScore = tokenized[d].result.importance_score || 0;
        if (dupeScore > (rep.importance_score || 0)) {
          rep.importance_score = dupeScore;
        }
      }
    }

    return rep;
  });
}
