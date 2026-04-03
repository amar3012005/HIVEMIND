/**
 * ResultReranker
 *
 * Multi-signal reranking for post-retrieval precision boost.
 * Combines: vector score, recency, confirmation count, relationship density,
 * query-term overlap (BM25-like), and source authority.
 *
 * No external model needed — purely algorithmic.
 */

export class ResultReranker {
  constructor(options = {}) {
    this.weights = {
      vectorScore: options.vectorScoreWeight ?? 0.40,
      termOverlap: options.termOverlapWeight ?? 0.25,
      recency: options.recencyWeight ?? 0.15,
      authority: options.authorityWeight ?? 0.10,
      relationshipDensity: options.relationshipDensityWeight ?? 0.10,
    };
  }

  /**
   * Rerank results based on multiple signals.
   * @param {string} query - original search query
   * @param {Object[]} results - search results with score, content, metadata, etc.
   * @param {Object} options - { boostRecent?: boolean, boostConfirmed?: boolean }
   * @returns {Object[]} reranked results with _rerank metadata
   */
  rerank(query, results, options = {}) {
    if (!results || results.length <= 1) return results;

    const queryTerms = this._tokenize(query);
    const now = Date.now();

    const scored = results.map(result => {
      const signals = {
        vectorScore: this._normalizeScore(result.score || 0),
        termOverlap: this._computeTermOverlap(queryTerms, result.content || ''),
        recency: this._computeRecency(result.created_at || result.document_date, now),
        authority: this._computeAuthority(result),
        relationshipDensity: this._computeRelationshipDensity(result),
      };

      const combinedScore = Object.entries(this.weights).reduce(
        (sum, [key, weight]) => sum + (signals[key] || 0) * weight, 0
      );

      return {
        ...result,
        _rerank: {
          originalScore: result.score,
          combinedScore,
          signals,
          rank: 0, // set after sorting
        },
        score: combinedScore, // override score with reranked score
      };
    });

    // Sort by combined score descending
    scored.sort((a, b) => b._rerank.combinedScore - a._rerank.combinedScore);

    // Assign ranks
    scored.forEach((r, i) => { r._rerank.rank = i + 1; });

    return scored;
  }

  _tokenize(text) {
    return (text || '').toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);
  }

  _normalizeScore(score) {
    // Assume scores are 0-1 range from vector search
    return Math.min(1, Math.max(0, score));
  }

  _computeTermOverlap(queryTerms, content) {
    if (!queryTerms.length || !content) return 0;
    const contentLower = content.toLowerCase();
    const contentTokens = new Set(this._tokenize(contentLower));

    let matches = 0;
    for (const term of queryTerms) {
      if (contentTokens.has(term)) matches++;
      // Also check for substring match (partial term overlap)
      else if (contentLower.includes(term)) matches += 0.5;
    }
    return Math.min(1, matches / queryTerms.length);
  }

  _computeRecency(dateStr, now) {
    if (!dateStr) return 0.3; // neutral for unknown dates
    const date = new Date(dateStr).getTime();
    if (isNaN(date)) return 0.3;

    const ageMs = now - date;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    // Decay curve: 1.0 for today, 0.5 at 30 days, 0.2 at 180 days
    if (ageDays <= 0) return 1.0;
    if (ageDays <= 7) return 0.9;
    if (ageDays <= 30) return 0.7;
    if (ageDays <= 90) return 0.5;
    if (ageDays <= 180) return 0.3;
    return 0.15;
  }

  _computeAuthority(result) {
    let authority = 0.5; // base

    // Higher confidence facts
    const confidence = result.importance_score || result.confidence || 0.5;
    authority += (confidence - 0.5) * 0.3;

    // Confirmed facts boost
    const confirmed = result.metadata?.confirmedCount || result.confirmedCount || 1;
    if (confirmed > 1) authority += Math.min(0.2, confirmed * 0.05);

    // Source authority: knowledge_base > manual > connector
    const source = result.source || result.metadata?.source_platform || 'manual';
    if (source === 'knowledge_base' || source === 'notion' || source === 'document') authority += 0.1;
    if (source === 'gmail' || source === 'slack') authority -= 0.05;

    return Math.min(1, Math.max(0, authority));
  }

  _computeRelationshipDensity(result) {
    // Results with more relationships are more connected = more authoritative
    const relCount = result.relationships?.length || result.metadata?.relationship_count || 0;
    if (relCount === 0) return 0.3;
    if (relCount <= 2) return 0.5;
    if (relCount <= 5) return 0.7;
    return 0.9;
  }
}
