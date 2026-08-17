/**
 * Semantic evidence projection for ranked memories.
 *
 * Recall decides which memories matter. This module decides which passages
 * from those complete memories fit into the bounded answer context. Passage
 * selection is embedding-based, so it does not depend on a language-specific
 * keyword list or per-domain rules.
 */

const CHUNK_CHARS = 900;
const CHUNK_OVERLAP = 140;

function cosine(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length === 0) return -1;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return leftNorm > 0 && rightNorm > 0 ? dot / Math.sqrt(leftNorm * rightNorm) : -1;
}

function splitLongBlock(block, maxChunkChars = CHUNK_CHARS) {
  if (block.length <= maxChunkChars) return [block];
  const chunks = [];
  const overlap = Math.min(CHUNK_OVERLAP, Math.floor(maxChunkChars / 4));
  let start = 0;
  while (start < block.length) {
    let end = Math.min(block.length, start + maxChunkChars);
    if (end < block.length) {
      const boundary = Math.max(
        block.lastIndexOf('\n', end),
        block.lastIndexOf('. ', end),
        block.lastIndexOf('。', end),
        block.lastIndexOf('! ', end),
        block.lastIndexOf('? ', end),
      );
      if (boundary > start + Math.floor(maxChunkChars * 0.55)) end = boundary + 1;
    }
    chunks.push(block.slice(start, end).trim());
    if (end >= block.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks.filter(Boolean);
}

export function segmentMemoryContent(content, { maxChunkChars = CHUNK_CHARS } = {}) {
  const normalized = String(content || '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  const blocks = normalized.split(/\n\s*\n+/u).map((block) => block.trim()).filter(Boolean);
  return blocks.flatMap((block) => splitLongBlock(block, Math.max(120, maxChunkChars)));
}

export function projectRankedMemoryFallback(memories = [], { totalBudget = 12000, lowerRankBudget = 320 } = {}) {
  const budget = Math.max(1000, Number(totalBudget) || 12000);
  let remaining = budget;
  return memories.map((memory, index) => {
    const content = String(memory?.content || '');
    // On projector degradation, rank 1 remains complete when it fits. For the
    // tail, spend the REMAINING GLOBAL budget fairly rather than imposing the
    // old fixed 300-char prefix on every row. That fixed prefix left thousands
    // of budgeted characters unused while clipping short complete records and
    // hiding late qualifiers/identifiers. The fair share is recomputed after
    // every row, so short rows return unused capacity to later ranks.
    const rowsLeft = Math.max(1, memories.length - index);
    const fairShare = Math.floor(remaining / rowsLeft);
    const allowance = index === 0
      ? remaining
      : Math.min(remaining, Math.max(120, Number(lowerRankBudget) || 320, fairShare));
    const excerpt = content.slice(0, allowance);
    remaining = Math.max(0, remaining - excerpt.length);
    return {
      memory,
      excerpt,
      tags: Array.isArray(memory?.tags) ? memory.tags.slice(0, 6) : [],
      projection: 'rank-preserving-fallback',
    };
  });
}

function fitPassages(passages, budget) {
  const kept = [];
  let used = 0;
  for (const passage of passages) {
    const separator = kept.length ? 2 : 0;
    if (used + separator + passage.text.length <= budget) {
      kept.push(passage);
      used += separator + passage.text.length;
      continue;
    }
    const remaining = budget - used - separator;
    if (remaining >= 80 && kept.length === 0) {
      kept.push({ ...passage, text: passage.text.slice(0, remaining).trimEnd() });
    }
    break;
  }
  return kept;
}

export async function projectRankedMemoryEvidence({
  query,
  memories = [],
  perMemoryBudget = 700,
  embed,
} = {}) {
  if (typeof embed !== 'function') throw new TypeError('projectRankedMemoryEvidence requires an embed function');
  const normalizedBudget = Math.max(120, Number(perMemoryBudget) || 700);
  const prepared = memories.map((memory, memoryIndex) => ({
    memory,
    memoryIndex,
    passages: segmentMemoryContent(memory?.content, {
      // Leave room for an adjacent passage. Qualifiers, negations, units, and
      // continuations frequently sit immediately before/after the best match.
      maxChunkChars: Math.min(CHUNK_CHARS, Math.max(120, Math.floor(normalizedBudget * 0.45))),
    }),
    tags: Array.isArray(memory?.tags) ? memory.tags.filter((tag) => typeof tag === 'string' && tag.trim()) : [],
  }));
  const candidates = prepared.flatMap((item) => [
    ...item.passages.map((text, passageIndex) => ({
      kind: 'passage', memoryIndex: item.memoryIndex, passageIndex, text,
    })),
    ...item.tags.map((text, tagIndex) => ({
      kind: 'tag', memoryIndex: item.memoryIndex, tagIndex, text,
    })),
  ]);
  if (!candidates.length) {
    return prepared.map(({ memory }) => ({ memory, excerpt: '', tags: [], projection: 'semantic' }));
  }

  const vectors = await embed([String(query || ''), ...candidates.map((candidate) => candidate.text)]);
  if (!Array.isArray(vectors) || vectors.length !== candidates.length + 1) {
    throw new Error('semantic evidence projector received an invalid embedding batch');
  }
  const queryVector = vectors[0];
  const ranked = candidates.map((candidate, index) => ({
    ...candidate,
    score: cosine(queryVector, vectors[index + 1]),
  }));

  return prepared.map(({ memory, memoryIndex }) => {
    const passages = ranked
      .filter((candidate) => candidate.memoryIndex === memoryIndex && candidate.kind === 'passage')
      .sort((left, right) => right.score - left.score || left.passageIndex - right.passageIndex);
    const byIndex = new Map(passages.map((passage) => [passage.passageIndex, passage]));
    const passagePriority = [];
    const seenPassages = new Set();
    const appendPassage = (index) => {
      if (seenPassages.has(index) || !byIndex.has(index)) return;
      seenPassages.add(index);
      passagePriority.push(byIndex.get(index));
    };
    // Preserve multiple passages that are essentially tied for semantic
    // relevance before spending budget on adjacency. This lets synthesis see
    // competing identifiers or values and resolve them from the record itself.
    const bestScore = passages[0]?.score ?? -1;
    const semanticPeers = passages.filter((passage) => passage.score >= bestScore - 0.08).slice(0, 4);
    for (const passage of semanticPeers) appendPassage(passage.passageIndex);
    for (const passage of semanticPeers) {
      appendPassage(passage.passageIndex - 1);
      appendPassage(passage.passageIndex + 1);
    }
    for (const passage of passages) appendPassage(passage.passageIndex);
    const selected = fitPassages(passagePriority, normalizedBudget);
    const selectedIndexes = new Set(selected.map((passage) => passage.passageIndex));
    const excerpt = selected
      .sort((left, right) => left.passageIndex - right.passageIndex)
      .map((passage) => passage.text)
      .join('\n\n');
    const tags = ranked
      .filter((candidate) => candidate.memoryIndex === memoryIndex && candidate.kind === 'tag')
      .sort((left, right) => right.score - left.score || left.tagIndex - right.tagIndex)
      .slice(0, 6)
      .map((candidate) => candidate.text);
    return {
      memory,
      excerpt,
      tags,
      selected_passage_indexes: [...selectedIndexes].sort((left, right) => left - right),
      projection: 'semantic',
    };
  });
}

export async function projectAdaptiveRankedMemoryEvidence({
  query,
  memories = [],
  totalBudget = 12000,
  lowerRankBudget = 700,
  embed,
} = {}) {
  const budget = Math.max(1000, Number(totalBudget) || 12000);
  const top = memories[0] || null;
  const topContent = String(top?.content || '');
  if (!top || topContent.length > budget) {
    const projected = await projectRankedMemoryEvidence({
      query,
      memories,
      perMemoryBudget: Math.max(120, Math.min(lowerRankBudget, Math.floor(budget / Math.max(1, memories.length)))),
      embed,
    });
    let remaining = budget;
    return projected.map((item) => {
      const excerpt = String(item?.excerpt || '').slice(0, Math.max(0, remaining));
      remaining = Math.max(0, remaining - excerpt.length);
      return excerpt === item.excerpt ? item : { ...item, excerpt };
    }).filter((item) => item.excerpt.length > 0);
  }
  const remaining = Math.max(0, budget - topContent.length);
  const projectedTail = remaining > 0 && memories.length > 1
    ? await projectRankedMemoryEvidence({
      query,
      memories: memories.slice(1),
      // Allocate the leftover globally rather than giving every tail row the
      // whole remainder. This keeps the full rank-one guarantee without
      // silently exceeding the operation's final-evidence budget.
      perMemoryBudget: Math.max(120, Math.min(
        lowerRankBudget,
        Math.floor(remaining / (memories.length - 1)),
      )),
      embed,
    })
    : [];
  // The passage projector intentionally has a 120-character minimum to keep
  // a semantic fragment meaningful. When the rank-one row leaves less than
  // that per tail row, enforce the *global* contract here instead of allowing
  // the minimum to inflate the final prompt.
  let tailRemaining = remaining;
  const tail = projectedTail.map((item) => {
    const excerpt = String(item?.excerpt || '').slice(0, Math.max(0, tailRemaining));
    tailRemaining = Math.max(0, tailRemaining - excerpt.length);
    return excerpt === item.excerpt ? item : { ...item, excerpt };
  }).filter((item) => item.excerpt.length > 0);
  return [{
    memory: top,
    excerpt: topContent,
    tags: Array.isArray(top.tags) ? top.tags.slice(0, 6) : [],
    selected_passage_indexes: null,
    projection: 'complete-rank-one',
  }, ...tail];
}
