function memoryImportance(item) {
  const memory = item?.memory || item || {};
  const value = Number(memory.importance_score ?? memory.importanceScore);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
}

export function sortWithImportanceTiebreaker(items = [], relevanceBandRatio = 0.03) {
  if (!Array.isArray(items) || items.length < 2) return items;
  const ordered = [...items].sort((left, right) => (Number(right?.score) || 0) - (Number(left?.score) || 0));
  const maxScore = Math.max(Number(ordered[0]?.score) || 0, 0);
  const width = Math.max(maxScore * relevanceBandRatio, 0.000001);
  const result = [];
  for (let start = 0; start < ordered.length;) {
    const leaderScore = Number(ordered[start]?.score) || 0;
    let end = start + 1;
    while (end < ordered.length && leaderScore - (Number(ordered[end]?.score) || 0) <= width) end += 1;
    result.push(...ordered.slice(start, end).sort((left, right) =>
      memoryImportance(right) - memoryImportance(left)
      || (Number(right?.score) || 0) - (Number(left?.score) || 0)));
    start = end;
  }
  return result;
}

export function applyExactSourceSummaryPenalty(item, exactSource, factor = 0.72) {
  if (!exactSource) return item;
  const memory = item?.memory || item || {};
  const tags = Array.isArray(memory.tags) ? memory.tags : [];
  const weakSummary = memory.memory_type === 'summary'
    || memory.memoryType === 'summary'
    || tags.includes('canonical-summary');
  return weakSummary ? { ...item, score: (Number(item?.score) || 0) * factor } : item;
}
