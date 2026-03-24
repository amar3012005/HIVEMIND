/**
 * Byzantine-Robust Score Consensus
 *
 * Before committing critical memory Updates, routes evaluation through
 * a consensus protocol using Geometric Median (Weiszfeld's algorithm)
 * to tolerate up to floor((n-1)/2) faulty or hallucinating agents.
 *
 * Architecture (per NotebookLM research):
 *   - 3D evaluation vector: [factuality, relevance, consistency] (0-100)
 *   - Geometric Median via Weiszfeld's iterative algorithm
 *   - 2-sigma outlier detection from median
 *   - Commit threshold: average score >= 80/100
 *   - Minimum 3 voters for Byzantine tolerance
 *   - Heuristic ConsensusVoter (no LLM calls) as deterministic baseline
 *
 * @module memory/byzantine-consensus
 */

import { computeTokenSimilarity } from './conflict-detector.js';

// ---------------------------------------------------------------------------
// Weiszfeld Solver (Geometric Median)
// ---------------------------------------------------------------------------

/**
 * Compute geometric median of a set of points in R^d using Weiszfeld's algorithm.
 *
 * @param {number[][]} points — array of d-dimensional vectors
 * @param {number} [maxIterations=1000]
 * @param {number} [convergenceThreshold=1e-5]
 * @returns {{ median: number[], iterations: number, converged: boolean }}
 */
export function weiszfeldSolver(points, maxIterations = 1000, convergenceThreshold = 1e-5) {
  if (points.length === 0) return { median: [], iterations: 0, converged: true };
  if (points.length === 1) return { median: [...points[0]], iterations: 0, converged: true };

  const dim = points[0].length;

  // Initialize with centroid
  const y = new Array(dim).fill(0);
  for (const p of points) {
    for (let d = 0; d < dim; d++) y[d] += p[d];
  }
  for (let d = 0; d < dim; d++) y[d] /= points.length;

  let iterations = 0;
  let converged = false;

  for (let iter = 0; iter < maxIterations; iter++) {
    iterations++;
    const num = new Array(dim).fill(0);
    let den = 0;

    for (const x of points) {
      const dist = euclideanDistance(x, y);
      if (dist < 1e-10) continue; // Skip coincident points
      const w = 1 / dist;
      for (let d = 0; d < dim; d++) num[d] += x[d] * w;
      den += w;
    }

    if (den < 1e-10) break;

    const nextY = num.map(n => n / den);
    const shift = euclideanDistance(y, nextY);

    for (let d = 0; d < dim; d++) y[d] = nextY[d];

    if (shift < convergenceThreshold) {
      converged = true;
      break;
    }
  }

  return { median: y, iterations, converged };
}

/**
 * Euclidean distance between two vectors.
 */
function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += (a[i] - b[i]) ** 2;
  }
  return Math.sqrt(sum);
}

// ---------------------------------------------------------------------------
// Heuristic Consensus Voter
// ---------------------------------------------------------------------------

const HEDGING_WORDS = /\b(might|maybe|possibly|probably|perhaps|i think|seems|could be|appears|allegedly|reportedly|unclear)\b/gi;
const NEGATION_WORDS = /\b(not|never|cannot|can't|don't|doesn't|won't|isn't|aren't|wasn't|weren't|false|incorrect|wrong)\b/gi;
const CITATION_SIGNALS = /\b(according to|source|reference|study|research|data shows|evidence|confirmed)\b/gi;
const SPECIFICITY_SIGNALS = /\b(\d{4}[-/]\d{2}|https?:\/\/|@|#|\d+\.\d+|v\d+)\b/gi;

/**
 * ConsensusVoter — deterministic heuristic voter (no LLM calls).
 *
 * Evaluates a proposed memory operation on 3 dimensions:
 *   - Factuality: hedging words, citations, specificity
 *   - Relevance: token overlap with existing memory/context
 *   - Consistency: contradiction detection, negation patterns
 */
export class ConsensusVoter {
  /**
   * Vote on whether a proposed memory operation should be committed.
   *
   * @param {object} proposedMemory — { content, memory_type, tags }
   * @param {Array} existingMemories — related existing memories for context
   * @returns {{ scores: [number, number, number], shouldCommit: boolean, confidence: number, reasoning: string }}
   */
  vote(proposedMemory, existingMemories = []) {
    const content = proposedMemory.content || '';

    const factuality = this._scoreFactuality(content);
    const relevance = this._scoreRelevance(content, existingMemories);
    const consistency = this._scoreConsistency(content, existingMemories);

    const scores = [factuality, relevance, consistency];
    const avg = (factuality + relevance + consistency) / 3;
    const shouldCommit = avg >= 80;

    const reasons = [];
    if (factuality < 60) reasons.push(`low factuality (${factuality}): hedging detected`);
    if (relevance < 60) reasons.push(`low relevance (${relevance}): weak overlap`);
    if (consistency < 60) reasons.push(`low consistency (${consistency}): contradictions detected`);

    return {
      scores,
      shouldCommit,
      confidence: avg / 100,
      reasoning: reasons.length > 0 ? reasons.join('; ') : 'all dimensions pass threshold'
    };
  }

  /**
   * Factuality: 100 = strong factual content, 0 = highly hedged/vague.
   */
  _scoreFactuality(content) {
    const hedgeCount = (content.match(HEDGING_WORDS) || []).length;
    const citationCount = (content.match(CITATION_SIGNALS) || []).length;
    const specificityCount = (content.match(SPECIFICITY_SIGNALS) || []).length;

    let score = 85; // Base score
    score -= hedgeCount * 12; // Penalize hedging
    score += citationCount * 8; // Boost citations
    score += specificityCount * 5; // Boost specificity

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Relevance: how much the proposed content relates to existing context.
   */
  _scoreRelevance(content, existingMemories) {
    if (existingMemories.length === 0) return 70; // No context = moderate baseline

    let maxSimilarity = 0;
    for (const existing of existingMemories) {
      const sim = computeTokenSimilarity(content, existing.content || '');
      if (sim > maxSimilarity) maxSimilarity = sim;
    }

    // Scale: 0 similarity = 40, 1.0 similarity = 100
    return Math.round(40 + maxSimilarity * 60);
  }

  /**
   * Consistency: checks for contradictions with existing memories.
   */
  _scoreConsistency(content, existingMemories) {
    const newNegs = (content.match(NEGATION_WORDS) || []).length;

    let contradictionPenalty = 0;
    for (const existing of existingMemories) {
      const existingNegs = ((existing.content || '').match(NEGATION_WORDS) || []).length;
      const similarity = computeTokenSimilarity(content, existing.content || '');

      // High similarity but different negation patterns = contradiction signal
      if (similarity > 0.5 && Math.abs(newNegs - existingNegs) > 1) {
        contradictionPenalty += 20;
      }
    }

    return Math.max(0, Math.min(100, 90 - contradictionPenalty));
  }
}

// ---------------------------------------------------------------------------
// Byzantine Consensus
// ---------------------------------------------------------------------------

/**
 * ByzantineConsensus — multi-voter evaluation for memory operations.
 */
export class ByzantineConsensus {
  /**
   * @param {object} [opts]
   * @param {number} [opts.commitThreshold=80] — avg score needed to commit
   * @param {number} [opts.maxIterations=1000] — Weiszfeld iterations
   * @param {number} [opts.convergenceThreshold=1e-5]
   */
  constructor({ commitThreshold = 80, maxIterations = 1000, convergenceThreshold = 1e-5 } = {}) {
    this.commitThreshold = commitThreshold;
    this.maxIterations = maxIterations;
    this.convergenceThreshold = convergenceThreshold;
    this.heuristicVoter = new ConsensusVoter();
  }

  /**
   * Evaluate a proposed memory Update operation.
   *
   * @param {object} proposedMemory — { content, memory_type }
   * @param {Array} existingMemories — related existing memories
   * @param {Array<{ agentId: string, scores: [number, number, number] }>} [externalVotes=[]] — optional votes from LLM agents
   * @returns {{ shouldCommit: boolean, consensusScores: { factuality: number, relevance: number, consistency: number }, outliers: Array, faultTolerance: number, reasoning: string }}
   */
  evaluateUpdate(proposedMemory, existingMemories, externalVotes = []) {
    // Collect all votes
    const votes = [];

    // Heuristic baseline vote (always present)
    const heuristic = this.heuristicVoter.vote(proposedMemory, existingMemories);
    votes.push({ agentId: 'heuristic', scores: heuristic.scores });

    // External votes (from LLM agents or other evaluators)
    for (const v of externalVotes) {
      votes.push(v);
    }

    // Need at least 3 votes for Byzantine tolerance
    // Add synthetic diversity voters if needed
    if (votes.length < 3) {
      // Synthetic voter 2: strict factuality focus
      const strictScores = [
        Math.max(0, heuristic.scores[0] - 10), // slightly more conservative
        heuristic.scores[1],
        heuristic.scores[2]
      ];
      votes.push({ agentId: 'strict-factuality', scores: strictScores });

      // Synthetic voter 3: lenient relevance focus
      const lenientScores = [
        heuristic.scores[0],
        Math.min(100, heuristic.scores[1] + 5),
        heuristic.scores[2]
      ];
      votes.push({ agentId: 'lenient-relevance', scores: lenientScores });
    }

    // Compute geometric median
    const vectors = votes.map(v => v.scores);
    const { median, iterations, converged } = weiszfeldSolver(vectors, this.maxIterations, this.convergenceThreshold);

    // Detect outliers (2-sigma)
    const outliers = this._detectOutliers(votes, median);
    const faultTolerance = Math.floor((votes.length - 1) / 2);

    // Check if too many outliers
    if (outliers.length > faultTolerance) {
      return {
        shouldCommit: false,
        consensusScores: { factuality: median[0], relevance: median[1], consistency: median[2] },
        outliers,
        faultTolerance,
        voterCount: votes.length,
        reasoning: `Byzantine failure: ${outliers.length} outliers exceed tolerance of ${faultTolerance}`,
        converged
      };
    }

    // Check commit threshold
    const avgScore = (median[0] + median[1] + median[2]) / 3;
    const shouldCommit = avgScore >= this.commitThreshold;

    return {
      shouldCommit,
      consensusScores: {
        factuality: Math.round(median[0] * 100) / 100,
        relevance: Math.round(median[1] * 100) / 100,
        consistency: Math.round(median[2] * 100) / 100,
        average: Math.round(avgScore * 100) / 100
      },
      outliers,
      faultTolerance,
      voterCount: votes.length,
      reasoning: shouldCommit
        ? `Consensus reached: avg ${avgScore.toFixed(1)} >= ${this.commitThreshold}`
        : `Below threshold: avg ${avgScore.toFixed(1)} < ${this.commitThreshold}`,
      converged,
      iterations
    };
  }

  /**
   * Cross-model verification: check agreement between voters.
   *
   * @param {Array<{ agentId: string, scores: number[] }>} votes
   * @returns {{ verified: boolean, agreementRatio: number, divergentAgents: string[] }}
   */
  crossModelVerify(votes) {
    if (votes.length < 2) return { verified: true, agreementRatio: 1.0, divergentAgents: [] };

    // Check if all voters agree on the commit decision
    const decisions = votes.map(v => {
      const avg = (v.scores[0] + v.scores[1] + v.scores[2]) / 3;
      return { agentId: v.agentId, avg, shouldCommit: avg >= this.commitThreshold };
    });

    const commitCount = decisions.filter(d => d.shouldCommit).length;
    const agreementRatio = Math.max(commitCount, decisions.length - commitCount) / decisions.length;

    const majorityCommit = commitCount > decisions.length / 2;
    const divergentAgents = decisions
      .filter(d => d.shouldCommit !== majorityCommit)
      .map(d => d.agentId);

    return {
      verified: agreementRatio >= 0.67, // 2/3 supermajority
      agreementRatio: Math.round(agreementRatio * 100) / 100,
      divergentAgents
    };
  }

  /**
   * Detect outliers using 2-sigma from geometric median.
   */
  _detectOutliers(votes, median) {
    const distances = votes.map(v => euclideanDistance(v.scores, median));
    const meanDist = distances.reduce((a, b) => a + b, 0) / distances.length;
    const variance = distances.reduce((a, b) => a + (b - meanDist) ** 2, 0) / distances.length;
    const stdDev = Math.sqrt(variance);
    const threshold = meanDist + 2 * stdDev;

    const outliers = [];
    votes.forEach((v, i) => {
      if (distances[i] > threshold) {
        outliers.push({ agentId: v.agentId, distance: Math.round(distances[i] * 100) / 100, scores: v.scores });
      }
    });

    return outliers;
  }
}
