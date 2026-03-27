import crypto from 'node:crypto';
import { computeTokenSimilarity } from './conflict-detector.js';

/** Common English stopwords to exclude from novelty calculations. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
  'because', 'but', 'and', 'or', 'if', 'while', 'about', 'up', 'down',
  'that', 'this', 'these', 'those', 'it', 'its', 'i', 'me', 'my', 'we',
  'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her', 'they', 'them',
  'their', 'what', 'which', 'who', 'whom', 'also', 'shown'
]);

/**
 * Tokenize text into lowercase alphanumeric tokens, excluding stopwords.
 */
function tokenize(text = '') {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 0 && !STOPWORDS.has(t));
}

/**
 * Split text into atomic units using sentence boundaries, semicolons, blank
 * lines, and bullet-style line breaks. This gives the delta extractor a more
 * granular view of long updates.
 */
export function extractSentences(text = '') {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const raw = normalized
    .split(/\n{2,}/)
    .flatMap(chunk => chunk.split(/\n+/))
    .flatMap(chunk => chunk.split(/(?<=[.!?;])\s+/))
    .map((part) => part
      .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '')
      .trim())
    .filter((part) => part.length > 0);

  return raw.length > 0 ? raw : [normalized];
}

/**
 * Compute per-sentence novelty: fraction of tokens NOT present in the known set.
 * Returns 1.0 (fully novel) when the sentence has no tokens or knownTokens is empty.
 */
export function computeSentenceNovelty(sentence, knownTokens) {
  const tokens = tokenize(sentence);
  if (tokens.length === 0) return 1.0;

  let novelCount = 0;
  for (const token of tokens) {
    if (!knownTokens.has(token)) {
      novelCount++;
    }
  }
  return novelCount / tokens.length;
}

/**
 * PredictCalibrateFilter — prediction-error extraction for memory ingestion.
 *
 * Architecture (per NotebookLM research):
 *   1. SHA-256 fingerprint for exact-duplicate detection.
 *   2. Select TOP-K most similar memories (not all) to compute known coverage.
 *      This prevents large KB vocabulary from inflating false redundancies.
 *   3. Use semantic similarity thresholds (Ruflo framework calibration):
 *      - similarity >= 0.90 → high similarity → route to LLM conflict resolver (UPDATE not duplicate)
 *      - similarity 0.60–0.90 → partial match → extract delta
 *      - similarity < 0.60 → weak match → store full content
 *   4. Token-level delta extraction for partial matches.
 *   5. Delta content gets stored in both Prisma AND Qdrant.
 */
export class PredictCalibrateFilter {
  /**
   * @param {object} options
   * @param {number} options.strongMatchThreshold — similarity above this ⇒ route to LLM conflict resolver (default 0.90)
   * @param {number} options.partialMatchThreshold — similarity above this ⇒ extract delta (default 0.60)
   * @param {number} options.sentenceNoveltyThreshold — min per-sentence novelty to keep (default 0.35)
   * @param {number} options.topK — max similar memories to compare against (default 5)
   * @param {number} options.minSimilarityForComparison — min similarity to be considered a candidate (default 0.15)
   * @param {number} options.fingerprintCacheSize — max recent hashes kept for dedup (default 10_000)
   */
  constructor({
    strongMatchThreshold = 0.90,
    partialMatchThreshold = 0.60,
    sentenceNoveltyThreshold = 0.35,
    topK = 5,
    minSimilarityForComparison = 0.15,
    fingerprintCacheSize = 10_000
  } = {}) {
    this.strongMatchThreshold = strongMatchThreshold;
    this.partialMatchThreshold = partialMatchThreshold;
    this.sentenceNoveltyThreshold = sentenceNoveltyThreshold;
    this.topK = topK;
    this.minSimilarityForComparison = minSimilarityForComparison;
    this.fingerprintCacheSize = fingerprintCacheSize;

    /** @type {Set<string>} bloom-filter-like cache of recent content hashes */
    this._recentFingerprints = new Set();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Compute a SHA-256 fingerprint for exact-duplicate detection.
   * Content is normalised (lowercased, whitespace collapsed) before hashing.
   *
   * @param {string} content
   * @returns {{ fingerprint: string, isDuplicate: boolean }}
   */
  computeContentFingerprint(content) {
    const normalised = (content || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    const fingerprint = crypto.createHash('sha256').update(normalised).digest('hex');
    const isDuplicate = this._recentFingerprints.has(fingerprint);

    if (!isDuplicate) {
      if (this._recentFingerprints.size >= this.fingerprintCacheSize) {
        this._recentFingerprints.clear();
      }
      this._recentFingerprints.add(fingerprint);
    }

    return { fingerprint, isDuplicate };
  }

  /**
   * Select the TOP-K most semantically similar existing memories.
   * This is the core improvement: we compare only against localized, relevant
   * context — not the entire knowledge graph — to avoid false redundancies.
   *
   * @param {{ content: string }} newMemory
   * @param {Array<{ id: string, content: string }>} existingMemories
   * @returns {Array<{ id: string, content: string, similarity: number }>}
   */
  selectTopKCandidates(newMemory, existingMemories = []) {
    return existingMemories
      .map(existing => ({
        ...existing,
        similarity: computeTokenSimilarity(newMemory.content, existing.content)
      }))
      .filter(m => m.similarity >= this.minSimilarityForComparison)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, this.topK);
  }

  /**
   * Predict what information the knowledge graph already covers that overlaps
   * with the incoming memory. Uses only TOP-K most similar memories.
   *
   * @param {{ content: string }} newMemory
   * @param {Array<{ id: string, content: string, similarity: number }>} topKMemories
   * @returns {{ knownTokens: Set<string>, knownCoverage: number, maxSimilarity: number, matchedMemories: Array }}
   */
  predictKnownContent(newMemory, topKMemories = []) {
    const newTokenSet = new Set(tokenize(newMemory.content));
    const knownTokens = new Set();
    const matchedMemories = [];
    let maxSimilarity = 0;

    for (const existing of topKMemories) {
      if (existing.similarity > maxSimilarity) {
        maxSimilarity = existing.similarity;
      }

      const existingTokens = tokenize(existing.content);
      let overlapCount = 0;
      for (const token of existingTokens) {
        if (newTokenSet.has(token)) {
          knownTokens.add(token);
          overlapCount++;
        }
      }

      if (overlapCount > 0) {
        matchedMemories.push({
          id: existing.id,
          similarity: existing.similarity,
          overlapTokens: overlapCount
        });
      }
    }

    const knownCoverage = newTokenSet.size > 0
      ? knownTokens.size / newTokenSet.size
      : 0;

    return { knownTokens, knownCoverage, maxSimilarity, matchedMemories };
  }

  /**
   * Compute the information delta using semantic similarity thresholds.
   *
   * Thresholds (calibrated from Ruflo framework per NotebookLM research):
   *   - maxSimilarity >= 0.90: High similarity → route to LLM conflict resolver (may be UPDATE not duplicate)
   *   - maxSimilarity 0.60-0.90: Partial match → extract novel sentences only
   *   - maxSimilarity < 0.60: Weak match → store full content (novel)
   *
   * @param {{ content: string }} newMemory
   * @param {{ knownTokens: Set<string>, knownCoverage: number, maxSimilarity: number, matchedMemories: Array }} prediction
   * @param {Array<{ id: string, content: string, similarity: number }>} [topKMemories] — used to collect matched IDs for conflict resolution
   * @returns {{ shouldStore: boolean, needsConflictResolution?: boolean, matchedMemoryIds?: Array<string>, deltaContent?: string, noveltyScore: number, maxSimilarity: number, reason?: string, deltaExtracted: boolean }}
   */
  extractDelta(newMemory, prediction, topKMemories = []) {
    const { maxSimilarity, knownCoverage, knownTokens } = prediction;
    const noveltyScore = 1 - knownCoverage;

    // High similarity — don't skip; route to LLM conflict resolver.
    // The memory might be a knowledge UPDATE, not a duplicate.
    if (maxSimilarity >= this.strongMatchThreshold) {
      return {
        shouldStore: true,
        needsConflictResolution: true,
        matchedMemoryIds: topKMemories.map(m => m.id),
        noveltyScore,
        maxSimilarity,
        deltaContent: null,
        deltaExtracted: false,
        reason: 'high_similarity_needs_resolution'
      };
    }

    // Weak match — content is mostly novel, store full
    if (maxSimilarity < this.partialMatchThreshold) {
      return {
        shouldStore: true,
        deltaContent: newMemory.content,
        noveltyScore,
        maxSimilarity,
        deltaExtracted: false
      };
    }

    // Partial match — extract only the novel sentences
    const sentences = extractSentences(newMemory.content);
    const novelSentences = sentences.filter(
      sentence => computeSentenceNovelty(sentence, knownTokens) >= this.sentenceNoveltyThreshold
    );

    if (novelSentences.length === 0) {
      // All sentences are well-covered — but we're in partial range,
      // so store at least the full content as an Extends candidate
      // rather than silently dropping potentially useful context.
      return {
        shouldStore: true,
        deltaContent: newMemory.content,
        noveltyScore,
        maxSimilarity,
        deltaExtracted: false,
        reason: 'partial_no_delta'
      };
    }

    const deltaContent = novelSentences.join(' ');
    return {
      shouldStore: true,
      deltaContent,
      noveltyScore,
      maxSimilarity,
      deltaExtracted: deltaContent !== newMemory.content
    };
  }

  /**
   * Full pipeline: fingerprint check → TOP-K selection → predict → extract delta.
   *
   * @param {{ content: string }} newMemory
   * @param {Array<{ id: string, content: string }>} existingMemories — all latest memories for the user
   * @returns {{ shouldStore: boolean, needsConflictResolution?: boolean, matchedMemoryIds?: Array<string>, deltaContent?: string, noveltyScore: number, maxSimilarity: number, reason?: string, fingerprint: string, deltaExtracted: boolean }}
   */
  filter(newMemory, existingMemories) {
    // Step 1: exact-duplicate detection via SHA-256 fingerprint
    const { fingerprint, isDuplicate } = this.computeContentFingerprint(newMemory.content);
    if (isDuplicate) {
      return {
        shouldStore: false,
        reason: 'exact_duplicate',
        noveltyScore: 0,
        maxSimilarity: 1.0,
        fingerprint,
        deltaExtracted: false
      };
    }

    // Step 2: select TOP-K most similar memories (not all)
    const topK = this.selectTopKCandidates(newMemory, existingMemories);

    // If no similar memories found, content is fully novel
    if (topK.length === 0) {
      return {
        shouldStore: true,
        deltaContent: newMemory.content,
        noveltyScore: 1.0,
        maxSimilarity: 0,
        fingerprint,
        deltaExtracted: false
      };
    }

    // Step 3: predict known coverage from TOP-K only
    const prediction = this.predictKnownContent(newMemory, topK);

    // Step 4: extract delta using semantic similarity thresholds
    // Pass topK so high-similarity results can report matched IDs for conflict resolution
    const delta = this.extractDelta(newMemory, prediction, topK);
    return { ...delta, fingerprint };
  }
}
