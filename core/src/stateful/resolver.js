/**
 * HIVE-MIND Conflict Resolver
 * Handles temporal inconsistencies and duplicate memories
 * Strategies: latest, highest-confidence, merge
 */

/**
 * Conflict Resolver - Manages conflict resolution strategies
 */
export class ConflictResolver {
  constructor() {
    this.resolutions = new Map();
    this.resolutionHistory = [];
  }

  /**
   * Detect conflicts between memories
   * @param {Array} memories - Array of memory objects
   * @returns {Array} Array of conflict groups
   */
  detectConflicts(memories) {
    const conflicts = [];
    const byHash = new Map();

    // Group memories by content hash
    for (const memory of memories) {
      const hash = this._hashContent(memory.content);
      if (!byHash.has(hash)) {
        byHash.set(hash, []);
      }
      byHash.get(hash).push(memory);
    }

    // Find groups with multiple memories (conflicts)
    for (const [hash, group] of byHash) {
      if (group.length > 1) {
        conflicts.push({
          hash,
          memories: group,
          type: 'duplicate',
          count: group.length
        });
      }
    }

    return conflicts;
  }

  /**
   * Detect conflicts by content similarity (fuzzy matching)
   * @param {Array} memories - Array of memory objects
   * @param {number} threshold - Similarity threshold (0-1)
   * @returns {Array} Array of conflict groups
   */
  detectSimilarConflicts(memories, threshold = 0.85) {
    const conflicts = [];
    const processed = new Set();

    for (let i = 0; i < memories.length; i++) {
      if (processed.has(i)) continue;

      const group = [memories[i]];
      processed.add(i);

      for (let j = i + 1; j < memories.length; j++) {
        if (processed.has(j)) continue;

        const similarity = this._calculateSimilarity(
          memories[i].content,
          memories[j].content
        );

        if (similarity >= threshold) {
          group.push(memories[j]);
          processed.add(j);
        }
      }

      if (group.length > 1) {
        conflicts.push({
          hash: this._hashContent(group[0].content),
          memories: group,
          type: 'similar',
          similarity: this._calculateAverageSimilarity(group),
          count: group.length
        });
      }
    }

    return conflicts;
  }

  /**
   * Resolve conflicts using specified strategy
   * @param {Array} conflicts - Array of conflict groups
   * @param {string} strategy - Resolution strategy
   * @returns {Array} Array of resolutions
   */
  resolveConflicts(conflicts, strategy = 'latest') {
    const resolved = [];

    for (const conflict of conflicts) {
      let resolution;

      switch (strategy) {
        case 'latest':
          resolution = this._resolveLatest(conflict);
          break;
        case 'highest-confidence':
          resolution = this._resolveHighestConfidence(conflict);
          break;
        case 'merge':
          resolution = this._resolveMerge(conflict);
          break;
        case 'user-preference':
          resolution = this._resolveUserPreference(conflict);
          break;
        case 'importance-score':
          resolution = this._resolveByImportance(conflict);
          break;
        case 'temporal-weighted':
          resolution = this._resolveTemporalWeighted(conflict);
          break;
        default:
          resolution = this._resolveLatest(conflict);
      }

      resolved.push(resolution);
      this._recordResolution(resolution);
    }

    return resolved;
  }

  /**
   * Resolve by keeping most recent memory
   */
  _resolveLatest(conflict) {
    const sorted = [...conflict.memories].sort((a, b) => {
      const dateA = new Date(a.created_at || 0);
      const dateB = new Date(b.created_at || 0);
      return dateB.getTime() - dateA.getTime();
    });

    const resolution = {
      type: 'latest',
      strategy: 'latest',
      keep: sorted[0],
      discard: sorted.slice(1),
      timestamp: new Date().toISOString(),
      reason: 'Most recent memory kept'
    };

    return resolution;
  }

  /**
   * Resolve by highest confidence score
   */
  _resolveHighestConfidence(conflict) {
    const sorted = [...conflict.memories].sort((a, b) => {
      const confA = a.confidence !== undefined ? a.confidence : 1.0;
      const confB = b.confidence !== undefined ? b.confidence : 1.0;
      return confB - confA;
    });

    const resolution = {
      type: 'highest-confidence',
      strategy: 'highest-confidence',
      keep: sorted[0],
      discard: sorted.slice(1),
      timestamp: new Date().toISOString(),
      reason: `Highest confidence (${sorted[0].confidence || 1.0}) kept`
    };

    return resolution;
  }

  /**
   * Resolve by importance score
   */
  _resolveByImportance(conflict) {
    const sorted = [...conflict.memories].sort((a, b) => {
      const impA = a.importance_score !== undefined ? a.importance_score : 0.5;
      const impB = b.importance_score !== undefined ? b.importance_score : 0.5;
      return impB - impA;
    });

    const resolution = {
      type: 'importance-score',
      strategy: 'importance-score',
      keep: sorted[0],
      discard: sorted.slice(1),
      timestamp: new Date().toISOString(),
      reason: `Highest importance score (${sorted[0].importance_score || 0.5}) kept`
    };

    return resolution;
  }

  /**
   * Resolve by temporal weighting (recency + importance)
   */
  _resolveTemporalWeighted(conflict) {
    const now = new Date();
    const sorted = [...conflict.memories].map(memory => {
      const created = new Date(memory.created_at || 0);
      const daysOld = (now - created) / (1000 * 60 * 60 * 24);

      // Recency score: decays over 30 days
      const recencyScore = Math.exp(-daysOld / 30);

      // Importance score
      const importanceScore = memory.importance_score !== undefined
        ? memory.importance_score
        : 0.5;

      // Combined score
      const weightedScore = (recencyScore * 0.5) + (importanceScore * 0.5);

      return { ...memory, weightedScore };
    }).sort((a, b) => b.weightedScore - a.weightedScore);

    const resolution = {
      type: 'temporal-weighted',
      strategy: 'temporal-weighted',
      keep: sorted[0],
      discard: sorted.slice(1),
      timestamp: new Date().toISOString(),
      reason: `Temporal weight score: ${sorted[0].weightedScore.toFixed(3)} kept`
    };

    return resolution;
  }

  /**
   * Merge conflicting memories
   */
  _resolveMerge(conflict) {
    const mergedContent = this._mergeContent(conflict.memories);

    const resolution = {
      type: 'merge',
      strategy: 'merge',
      merged: {
        content: mergedContent,
        sources: conflict.memories.map(m => m.id),
        sourceCount: conflict.memories.length,
        timestamp: new Date().toISOString()
      },
      timestamp: new Date().toISOString(),
      reason: 'Conflicting memories merged'
    };

    return resolution;
  }

  /**
   * Merge content from multiple memories
   */
  _mergeContent(memories) {
    // Deduplicate content
    const contents = memories.map(m => m.content);
    const unique = [...new Set(contents)];

    // Add metadata about sources
    const sourceInfo = memories.map((m, i) => {
      const date = new Date(m.created_at || 0).toISOString().split('T')[0];
      return `  - [${i + 1}] ${date}: ${m.content.substring(0, 100)}${m.content.length > 100 ? '...' : ''}`;
    }).join('\n');

    return `MERGED MEMORY
================
Sources: ${memories.length}
Created: ${new Date().toISOString()}

Content from ${memories.length} sources:

${unique.join('\n\n---\n\n')}

Source Details:
${sourceInfo}
`;
  }

  /**
   * User preference resolution (manual)
   */
  _resolveUserPreference(conflict) {
    const resolution = {
      type: 'user-preference',
      strategy: 'user-preference',
      keep: null, // User selection
      discard: conflict.memories.slice(1),
      options: conflict.memories,
      timestamp: new Date().toISOString(),
      reason: 'Awaiting user selection'
    };

    return resolution;
  }

  /**
   * Record resolution for history
   */
  _recordResolution(resolution) {
    this.resolutionHistory.push(resolution);
    this.resolutions.set(resolution.keep?.id || resolution.merged?.sources?.[0], resolution);
  }

  /**
   * Get resolution history
   */
  getResolutionHistory() {
    return [...this.resolutionHistory];
  }

  /**
   * Get resolution by hash
   */
  getResolution(hash) {
    return this.resolutions.get(hash);
  }

  /**
   * Clear resolution history
   */
  clearHistory() {
    this.resolutions.clear();
    this.resolutionHistory = [];
  }

  /**
   * Hash content for conflict detection
   */
  _hashContent(content) {
    // Simple hash function for conflict detection
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
  }

  /**
   * Calculate content similarity using Levenshtein distance
   */
  _calculateSimilarity(str1, str2) {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;

    if (longer.length === 0) {
      return 1.0;
    }

    const editDistance = this._levenshteinDistance(longer, shorter);
    return 1.0 - (editDistance / longer.length);
  }

  /**
   * Calculate Levenshtein distance
   */
  _levenshteinDistance(s, t) {
    if (s.length === 0) return t.length;
    if (t.length === 0) return s.length;

    const matrix = [];
    for (let i = 0; i <= t.length; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= s.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= t.length; i++) {
      for (let j = 1; j <= s.length; j++) {
        if (t.charAt(i - 1) === s.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1,      // insertion
            matrix[i - 1][j] + 1       // deletion
          );
        }
      }
    }

    return matrix[t.length][s.length];
  }

  /**
   * Calculate average similarity in a group
   */
  _calculateAverageSimilarity(memories) {
    if (memories.length < 2) return 1.0;

    let totalSimilarity = 0;
    let count = 0;

    for (let i = 0; i < memories.length; i++) {
      for (let j = i + 1; j < memories.length; j++) {
        totalSimilarity += this._calculateSimilarity(
          memories[i].content,
          memories[j].content
        );
        count++;
      }
    }

    return count > 0 ? totalSimilarity / count : 1.0;
  }

  /**
   * Get statistics about resolutions
   */
  getStats() {
    const byType = {};
    for (const resolution of this.resolutionHistory) {
      byType[resolution.type] = (byType[resolution.type] || 0) + 1;
    }

    return {
      totalResolutions: this.resolutionHistory.length,
      byType,
      uniqueConflictsResolved: this.resolutions.size,
      avgConflictsPerResolution: this.resolutionHistory.length > 0
        ? this.resolutionHistory.reduce((sum, r) => sum + r.discard?.length, 0) / this.resolutionHistory.length
        : 0
    };
  }

  /**
   * Export resolutions for audit
   */
  exportResolutions() {
    return this.resolutionHistory.map(r => ({
      ...r,
      keep: r.keep ? { id: r.keep.id, content: r.keep.content } : null,
      discard: r.discard?.map(d => ({ id: d.id, content: d.content })) || []
    }));
  }
}

/**
 * Factory function to create conflict resolver
 */
export function getConflictResolver() {
  return new ConflictResolver();
}

/**
 * Resolve conflicts in a set of memories
 * @param {Object} params
 * @param {Array} params.memories - Array of memory objects
 * @param {string} [params.strategy='latest'] - Resolution strategy
 * @returns {Object} Resolution result
 */
export function resolveMemoryConflicts({ memories, strategy = 'latest' }) {
  const resolver = getConflictResolver();

  // Detect conflicts
  const conflicts = resolver.detectConflicts(memories);

  // Resolve conflicts
  const resolutions = resolver.resolveConflicts(conflicts, strategy);

  // Apply resolutions to memories
  const appliedResolutions = resolutions.map(resolution => {
    if (resolution.type === 'merge') {
      // For merge, create a new merged memory
      return {
        ...resolution,
        mergedMemory: {
          id: `merged-${resolution.merged.sources[0]}-${Date.now()}`,
          content: resolution.merged.content,
          is_latest: true,
          created_at: new Date().toISOString()
        }
      };
    } else {
      // For other strategies, mark memories appropriately
      const memoriesMap = new Map();
      for (const m of resolution.discard) {
        memoriesMap.set(m.id, { ...m, is_latest: false });
      }
      memoriesMap.set(resolution.keep.id, { ...resolution.keep, is_latest: true });

      return {
        ...resolution,
        updatedMemories: Array.from(memoriesMap.values())
      };
    }
  });

  return {
    conflicts,
    resolutions,
    appliedResolutions,
    stats: resolver.getStats()
  };
}
