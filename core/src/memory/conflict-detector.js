import crypto from 'node:crypto';

function tokenize(text = '') {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function normalizeToken(token) {
  return /^\d+$/.test(token) ? '<num>' : token;
}

export function computeTokenSimilarity(left = '', right = '') {
  const leftTokens = tokenize(left).map(normalizeToken);
  const rightTokens = tokenize(right).map(normalizeToken);

  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return 0;
  }

  const leftCounts = new Map();
  const rightCounts = new Map();

  for (const token of leftTokens) {
    leftCounts.set(token, (leftCounts.get(token) || 0) + 1);
  }
  for (const token of rightTokens) {
    rightCounts.set(token, (rightCounts.get(token) || 0) + 1);
  }

  const vocabulary = new Set([...leftCounts.keys(), ...rightCounts.keys()]);
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (const token of vocabulary) {
    const leftValue = leftCounts.get(token) || 0;
    const rightValue = rightCounts.get(token) || 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

/**
 * Cosine similarity over dense embedding vectors.
 * Returns 0 if vectors are missing/mismatched dimensions.
 */
export function computeEmbeddingSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return 0;
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftMag = 0;
  let rightMag = 0;
  for (let i = 0; i < left.length; i++) {
    const l = left[i];
    const r = right[i];
    if (!Number.isFinite(l) || !Number.isFinite(r)) return 0;
    dot += l * r;
    leftMag += l * l;
    rightMag += r * r;
  }
  if (leftMag === 0 || rightMag === 0) return 0;
  return dot / (Math.sqrt(leftMag) * Math.sqrt(rightMag));
}

export class ConflictDetector {
  // Lowered from 0.92 to 0.45 — the old threshold was so high that
  // only near-exact duplicates qualified as candidates, causing 0 graph edges.
  // Knowledge updates ("20 days → 25 days") typically have 0.5-0.7 Jaccard similarity.
  constructor({ threshold = 0.45, embeddingThreshold = 0.78 } = {}) {
    this.threshold = threshold;
    // Cosine on dense embeddings is on different scale than bag-of-words.
    // 0.78 = "same topic, same intent" for most embedding models (mistral-embed, OpenAI ada).
    this.embeddingThreshold = embeddingThreshold;
  }

  /**
   * Semantic candidate detection using dense embeddings.
   *
   * Replaces bag-of-words cosine (lexical) with embedding cosine (semantic).
   * Embeddings should be supplied as { [memoryId]: number[] } map.
   *
   * Falls back to token similarity per-pair if either embedding is missing.
   * This means callers can incrementally roll out embeddings without breaking
   * existing behaviour.
   *
   * @param {{id?: string, content: string, embedding?: number[]}} newMemory
   * @param {Array<{id?: string, content: string, embedding?: number[]}>} existingMemories
   * @param {Map<string, number[]>|Object} [embeddingMap] optional id -> vector lookup
   * @returns {Array<{memory, similarity, method: 'embedding'|'token', borderline?: boolean}>}
   */
  detectCandidatesWithEmbeddings(newMemory, existingMemories = [], embeddingMap = null) {
    const newVec = newMemory.embedding || this._lookupEmbedding(embeddingMap, newMemory.id);
    const candidates = [];

    for (const existing of existingMemories) {
      const existingVec = existing.embedding || this._lookupEmbedding(embeddingMap, existing.id);
      let similarity;
      let method;

      if (Array.isArray(newVec) && Array.isArray(existingVec) && newVec.length === existingVec.length && newVec.length > 0) {
        similarity = computeEmbeddingSimilarity(newVec, existingVec);
        method = 'embedding';
        if (similarity >= this.embeddingThreshold) {
          candidates.push({ memory: existing, similarity, method });
        }
      } else {
        // Fallback path — same logic as detectCandidates
        similarity = computeTokenSimilarity(newMemory.content || '', existing.content || '');
        method = 'token';
        if (similarity >= this.threshold) {
          candidates.push({ memory: existing, similarity, method });
        }
      }
    }

    return candidates.sort((left, right) => right.similarity - left.similarity);
  }

  _lookupEmbedding(map, id) {
    if (!map || id == null) return null;
    if (typeof map.get === 'function') return map.get(id) || null;
    return map[id] || null;
  }

  detectCandidates(newMemory, existingMemories = []) {
    const candidates = [];
    const newContent = newMemory.content || '';
    const newTokens = new Set(tokenize(newContent).map(normalizeToken));

    for (const existing of existingMemories) {
      const existingContent = existing.content || '';
      const similarity = computeTokenSimilarity(newContent, existingContent);

      if (similarity >= this.threshold) {
        candidates.push({ memory: existing, similarity });
      } else if (similarity >= 0.30 && similarity < this.threshold) {
        // Secondary check: if similarity is borderline (0.30-0.45),
        // check for shared topic keywords (nouns, names)
        const existingTokens = new Set(tokenize(existingContent).map(normalizeToken));
        const topicWords = [...newTokens].filter(t =>
          t.length > 4 && existingTokens.has(t) &&
          !/^(about|would|could|should|their|there|which|these|those)$/i.test(t)
        );
        if (topicWords.length >= 2) {
          // Borderline match with shared topics — include as candidate
          candidates.push({ memory: existing, similarity, borderline: true });
        }
      }
    }

    return candidates.sort((left, right) => right.similarity - left.similarity);
  }

  /**
   * Detect contradictions between a new memory and candidate existing memories.
   * Targets the similarity band 0.40-0.85 (same topic, different content).
   * Returns an array of { memory, contradictionType, confidence } objects.
   */
  detectContradictions(newMemory, existingMemories = [], opts = {}) {
    // Strict mode raises the similarity floor + requires negation language on
    // BOTH sides + bumps the value-divergence confidence floor. Used by KB
    // promotion so catalog rows don't spam edges.
    //
    // Defaults rewritten 2026-05: previous defaults (sim≥0.40, single-side
    // negation, raw-number divergence) generated 100+ false-positive edges
    // per save because the new ts:* timestamp suffix and shared topic words
    // collide with every prior memory. New defaults:
    //   • minSimilarity 0.65 (was 0.40) — must be genuinely same-topic
    //   • both-side negation required by default
    //   • entity-overlap required (≥1 shared entity: tag) — same topic by
    //     LLM definition, not by word overlap
    //   • numeric divergence ignores ts:* timestamp digits
    //   • final cap on returned list to keep downstream edge writes bounded
    const strict = opts.strictMode === true;
    const minSimilarity = typeof opts.minSimilarity === 'number'
      ? opts.minSimilarity
      : (strict ? 0.75 : 0.65);
    const maxSimilarity = typeof opts.maxSimilarity === 'number' ? opts.maxSimilarity : 0.92;
    const minConfidence = strict ? 0.80 : 0.65;
    const requireBothSideSignal = opts.requireBothSideSignal !== false;
    const requireEntityOverlap = opts.requireEntityOverlap !== false;
    const maxResults = Number.isInteger(opts.maxResults) ? opts.maxResults : 5;

    const NEGATION_PATTERNS = [
      { pattern: /\b(not|no longer|stopped|quit|never|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|can't|won't|haven't|hasn't)\b/i, type: 'negation', weight: 0.7 },
      { pattern: /\b(changed|switched|moved|replaced|updated|corrected|revised)\b.*\b(from|to)\b/i, type: 'change', weight: 0.8 },
      { pattern: /\b(used to|formerly|previously|before)\b/i, type: 'temporal_shift', weight: 0.75 },
      { pattern: /\b(actually|in fact|correction|wrong|incorrect|mistake)\b/i, type: 'explicit_correction', weight: 0.9 },
    ];

    // Strip our auto-stamped timestamp suffix and any ts:*/time:* tokens
    // from BOTH sides before any numeric-divergence check — those are not
    // value claims, they're audit metadata.
    const stripTimestamps = (s) => String(s || '')
      .replace(/\(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\)\s*$/, '')
      .replace(/\bts:\d{4}-\d{2}-\d{2}(T\d{2}\d{2}Z)?\b/gi, '')
      .replace(/\btime:[\w:-]+\b/gi, '');

    const newContent = newMemory.content || '';
    const newClean = stripTimestamps(newContent);
    const newEntityTags = new Set((newMemory.tags || []).filter(t => typeof t === 'string' && t.startsWith('entity:')));

    const contradictions = [];

    for (const existing of existingMemories) {
      const existingContent = existing.content || '';
      const existingClean = stripTimestamps(existingContent);

      // Entity-overlap gate: ≥1 shared entity:* tag. The LLM in
      // entity-co-mention has already extracted entities for both sides;
      // we use those as the ground-truth same-topic signal instead of
      // token overlap which spuriously matches via timestamps/connectors.
      if (requireEntityOverlap && newEntityTags.size > 0) {
        const existingEntities = new Set((existing.tags || []).filter(t => typeof t === 'string' && t.startsWith('entity:')));
        let overlap = false;
        for (const t of newEntityTags) {
          if (existingEntities.has(t)) { overlap = true; break; }
        }
        if (!overlap) continue;
      }

      const similarity = computeTokenSimilarity(newClean, existingClean);

      // Same-topic-different-content band (configurable via opts)
      if (similarity < minSimilarity || similarity > maxSimilarity) continue;

      let bestMatch = null;

      for (const { pattern, type, weight } of NEGATION_PATTERNS) {
        const newHas = pattern.test(newClean);
        const existingHas = pattern.test(existingClean);

        const signalOk = requireBothSideSignal ? (newHas && existingHas) : (newHas || existingHas);
        if (signalOk) {
          // Higher confidence when both sides show contradictory language
          const confidence = (newHas && existingHas) ? Math.min(weight + 0.1, 0.95) : weight;
          if (!bestMatch || confidence > bestMatch.confidence) {
            bestMatch = { type, confidence };
          }
        }
      }

      // Additional check: numeric/date value divergence on same topic.
      // Operates on STRIPPED content so ts:*/timestamp suffix never
      // triggers this. Also requires entity overlap (handled above) so
      // two unrelated memories that happen to share a number don't match.
      if (!bestMatch) {
        const newNumbers = (newClean.match(/\b\d+(\.\d+)?\b/g) || []).map(Number);
        const existingNumbers = (existingClean.match(/\b\d+(\.\d+)?\b/g) || []).map(Number);
        if (newNumbers.length > 0 && existingNumbers.length > 0) {
          const sharedTopic = similarity >= minSimilarity;
          const differentValues = newNumbers.some(n => existingNumbers.length > 0 && !existingNumbers.includes(n));
          if (sharedTopic && differentValues) {
            // Bumped from 0.6 to 0.65 — value-divergence alone (no negation
            // language) is a weaker signal than explicit correction.
            bestMatch = { type: 'value_divergence', confidence: 0.65 };
          }
        }
      }

      if (bestMatch && bestMatch.confidence >= minConfidence) {
        contradictions.push({
          memory: existing,
          contradictionType: bestMatch.type,
          confidence: bestMatch.confidence,
        });
      }
    }

    // Cap output to top-N highest-confidence so downstream edge creation
    // never explodes. Five contradictions is plenty — the operator graph
    // doesn't benefit from more, and stale latestMemories pollute when too
    // many is_latest=false flips happen at once.
    contradictions.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    return contradictions.slice(0, maxResults);
  }

  contentHash(content = '') {
    return crypto.createHash('sha256').update(content).digest('hex');
  }
}
