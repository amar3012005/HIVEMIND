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
  constructor({ threshold = 0.92 } = {}) {
    this.threshold = threshold;
  }

  detectCandidates(newMemory, existingMemories = []) {
    return existingMemories
      .map(existing => ({
        memory: existing,
        similarity: computeTokenSimilarity(newMemory.content, existing.content)
      }))
      .filter(candidate => candidate.similarity >= this.threshold)
      .sort((left, right) => right.similarity - left.similarity);
  }

  contentHash(content = '') {
    return crypto.createHash('sha256').update(content).digest('hex');
  }
}
