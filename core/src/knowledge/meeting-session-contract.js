/**
 * Pure lifecycle contract for progressive meeting capture. Route handlers feed
 * it durable database counts; keeping this here makes "ready" impossible to
 * infer from an optimistic browser state.
 */
export function deriveMeetingSessionIntegrity({ status, expectedSegments, segmentCount, maxSegmentIndex, segmentIndexes }) {
  const indexes = Array.isArray(segmentIndexes)
    ? [...new Set(segmentIndexes.map(Number).filter((value) => Number.isInteger(value) && value >= 0))].sort((a, b) => a - b)
    : [];
  const maxIndex = Number.isInteger(Number(maxSegmentIndex)) ? Number(maxSegmentIndex) : -1;
  const missingIndexes = maxIndex < 0
    ? []
    : Array.from({ length: maxIndex + 1 }, (_, index) => index).filter((index) => !indexes.includes(index));
  const expected = expectedSegments == null ? null : Math.max(0, Number(expectedSegments));
  const count = Math.max(0, Number(segmentCount) || 0);
  return {
    indexes,
    missingIndexes,
    complete: status === 'ready' && missingIndexes.length === 0 && (expected === null || count === expected),
  };
}
