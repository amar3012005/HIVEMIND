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

  contentHash(content = '') {
    return crypto.createHash('sha256').update(content).digest('hex');
  }
}
