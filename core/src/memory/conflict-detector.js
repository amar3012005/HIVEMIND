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

export class ConflictDetector {
  // Lowered from 0.92 to 0.45 — the old threshold was so high that
  // only near-exact duplicates qualified as candidates, causing 0 graph edges.
  // Knowledge updates ("20 days → 25 days") typically have 0.5-0.7 Jaccard similarity.
  constructor({ threshold = 0.45 } = {}) {
    this.threshold = threshold;
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
  detectContradictions(newMemory, existingMemories = []) {
    const NEGATION_PATTERNS = [
      { pattern: /\b(not|no longer|stopped|quit|never|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|can't|won't|haven't|hasn't)\b/i, type: 'negation', weight: 0.7 },
      { pattern: /\b(changed|switched|moved|replaced|updated|corrected|revised)\b.*\b(from|to)\b/i, type: 'change', weight: 0.8 },
      { pattern: /\b(used to|formerly|previously|before)\b/i, type: 'temporal_shift', weight: 0.75 },
      { pattern: /\b(actually|in fact|correction|wrong|incorrect|mistake)\b/i, type: 'explicit_correction', weight: 0.9 },
    ];

    const newContent = newMemory.content || '';
    const contradictions = [];

    for (const existing of existingMemories) {
      const existingContent = existing.content || '';
      const similarity = computeTokenSimilarity(newContent, existingContent);

      // Only consider the "same topic, different content" band
      if (similarity < 0.40 || similarity > 0.85) continue;

      let bestMatch = null;

      for (const { pattern, type, weight } of NEGATION_PATTERNS) {
        const newHas = pattern.test(newContent);
        const existingHas = pattern.test(existingContent);

        // Contradiction signal: one or both contain negation/change language
        if (newHas || existingHas) {
          // Higher confidence when both sides show contradictory language
          const confidence = (newHas && existingHas) ? Math.min(weight + 0.1, 0.95) : weight;
          if (!bestMatch || confidence > bestMatch.confidence) {
            bestMatch = { type, confidence };
          }
        }
      }

      // Additional check: numeric/date value divergence on same topic
      if (!bestMatch) {
        const newNumbers = (newContent.match(/\b\d+(\.\d+)?\b/g) || []).map(Number);
        const existingNumbers = (existingContent.match(/\b\d+(\.\d+)?\b/g) || []).map(Number);
        if (newNumbers.length > 0 && existingNumbers.length > 0) {
          // If there are numbers in both and they differ, flag as potential temporal contradiction
          const sharedTopic = similarity >= 0.50;
          const differentValues = newNumbers.some(n => existingNumbers.length > 0 && !existingNumbers.includes(n));
          if (sharedTopic && differentValues) {
            bestMatch = { type: 'value_divergence', confidence: 0.6 };
          }
        }
      }

      if (bestMatch) {
        contradictions.push({
          memory: existing,
          contradictionType: bestMatch.type,
          confidence: bestMatch.confidence,
        });
      }
    }

    return contradictions;
  }

  contentHash(content = '') {
    return crypto.createHash('sha256').update(content).digest('hex');
  }
}
