/**
 * reflector.js
 * Reflector agent — reviews accumulated observations, detects superseded facts,
 * merges related items, and prunes low-priority entries when token budget is exceeded.
 */

import { parseObservation, formatObservation, estimateTokens } from './observation-store.js';

/**
 * Compute the Jaccard token overlap between two strings.
 * Tokenises by splitting on whitespace and lowercasing.
 * @param {string} a
 * @param {string} b
 * @returns {number} value in [0, 1]
 */
function jaccardOverlap(a, b) {
  const tokenise = (s) => new Set(s.toLowerCase().split(/\s+/).filter(Boolean));
  const setA = tokenise(a);
  const setB = tokenise(b);

  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

export class Reflector {
  /**
   * @param {object} [options]
   * @param {number} [options.tokenThreshold=15000] — prune 🟢 entries above this limit
   */
  constructor(options = {}) {
    this.tokenThreshold = options.tokenThreshold ?? 15000;
  }

  /**
   * Full reflection pipeline.
   * @param {string[]} observations — formatted observation lines
   * @returns {Promise<{observations: string[], superseded: string[], merged: number, pruned: number}>}
   */
  async reflect(observations) {
    // Step 1: detect superseded
    const { current: afterSupersede, superseded } = this.detectSuperseded(observations);

    // Step 2: merge related
    const { merged: afterMerge, mergeCount } = this.mergeRelated(afterSupersede);

    // Step 3: prune low-priority if total tokens exceed threshold
    const { pruned: finalObs, pruneCount } = this._pruneIfNeeded(afterMerge);

    return {
      observations: finalObs,
      superseded,
      merged: mergeCount,
      pruned: pruneCount,
    };
  }

  /**
   * Detect superseded observations using pairwise Jaccard overlap (≥40% → older is superseded).
   * @param {string[]} observations
   * @returns {{current: string[], superseded: string[]}}
   */
  detectSuperseded(observations) {
    const supersededSet = new Set();

    for (let i = 0; i < observations.length; i++) {
      for (let j = i + 1; j < observations.length; j++) {
        if (supersededSet.has(i) || supersededSet.has(j)) continue;

        const obsI = parseObservation(observations[i]);
        const obsJ = parseObservation(observations[j]);

        const overlap = jaccardOverlap(
          observations[i],
          observations[j]
        );

        if (overlap >= 0.4) {
          // Supersede the older one (earlier observationDate)
          const dateI = obsI.observationDate ?? '';
          const dateJ = obsJ.observationDate ?? '';

          if (dateI <= dateJ) {
            supersededSet.add(i);
          } else {
            supersededSet.add(j);
          }
        }
      }
    }

    const current = observations.filter((_, idx) => !supersededSet.has(idx));
    const superseded = observations.filter((_, idx) => supersededSet.has(idx));

    return { current, superseded };
  }

  /**
   * Merge related observations: same date + >30% Jaccard overlap.
   * Groups are merged greedily; merged content is capped at 250 chars.
   * The highest priority emoji is preserved.
   * @param {string[]} observations
   * @returns {{merged: string[], mergeCount: number}}
   */
  mergeRelated(observations) {
    // Build adjacency groups by same date + >30% overlap
    const parsed = observations.map((line) => parseObservation(line));
    const n = observations.length;
    const group = Array.from({ length: n }, (_, i) => i); // union-find parent

    function find(x) {
      while (group[x] !== x) {
        group[x] = group[group[x]];
        x = group[x];
      }
      return x;
    }

    function union(x, y) {
      group[find(x)] = find(y);
    }

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (parsed[i].observationDate !== parsed[j].observationDate) continue;
        const overlap = jaccardOverlap(observations[i], observations[j]);
        if (overlap > 0.3) {
          union(i, j);
        }
      }
    }

    // Collect groups
    const groups = new Map(); // rootIdx → [indices]
    for (let i = 0; i < n; i++) {
      const root = find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(i);
    }

    const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
    const PRIORITY_EMOJI_MAP = { high: '🔴', medium: '🟡', low: '🟢' };

    let mergeCount = 0;
    const result = [];

    for (const [, indices] of groups) {
      if (indices.length === 1) {
        result.push(observations[indices[0]]);
        continue;
      }

      // This is a merge — count it
      mergeCount++;

      // Pick highest priority
      let bestPriority = 'low';
      for (const idx of indices) {
        const p = parsed[idx].priority;
        if (PRIORITY_ORDER[p] < PRIORITY_ORDER[bestPriority]) {
          bestPriority = p;
        }
      }

      // Use the date of the first item in group (all same date)
      const observationDate = parsed[indices[0]].observationDate;

      // Combine content, cap at 250 chars
      const combinedContent = indices
        .map((idx) => parsed[idx].content)
        .join(' ')
        .slice(0, 250);

      result.push(
        formatObservation({
          content: combinedContent,
          priority: bestPriority,
          observationDate: observationDate ?? new Date().toISOString().slice(0, 10),
        })
      );
    }

    return { merged: result, mergeCount };
  }

  /**
   * Prune 🟢 (low-priority) observations when total token count exceeds the threshold.
   * Removes lowest-priority entries first until under budget.
   * @param {string[]} observations
   * @returns {{pruned: string[], pruneCount: number}}
   */
  _pruneIfNeeded(observations) {
    const totalTokens = observations.reduce((sum, o) => sum + estimateTokens(o), 0);
    if (totalTokens <= this.tokenThreshold) {
      return { pruned: observations, pruneCount: 0 };
    }

    // Collect indices of low-priority observations, sorted by date (oldest first)
    const lowPriority = observations
      .map((o, i) => ({ idx: i, parsed: parseObservation(o) }))
      .filter(({ parsed }) => parsed.priority === 'low')
      .sort((a, b) => (a.parsed.observationDate ?? '').localeCompare(b.parsed.observationDate ?? ''));

    const toRemove = new Set();
    let remaining = totalTokens;

    for (const { idx } of lowPriority) {
      if (remaining <= this.tokenThreshold) break;
      remaining -= estimateTokens(observations[idx]);
      toRemove.add(idx);
    }

    const pruned = observations.filter((_, i) => !toRemove.has(i));
    return { pruned, pruneCount: toRemove.size };
  }
}
