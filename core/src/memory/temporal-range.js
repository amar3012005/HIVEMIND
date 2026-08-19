function parseDateRangeBoundary(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function isMemoryInDateRange(memory = {}, dateRange = null) {
  if (!dateRange) return true;

  const start = parseDateRangeBoundary(dateRange.start);
  const end = parseDateRangeBoundary(dateRange.end);
  // Event time is represented in several canonical forms. Ingestion always
  // stamps ts:YYYY-MM-DD, while entity extraction may add time:YYYY-MM-DD and
  // event_dates. Treat all of them as first-class range anchors instead of
  // looking only at document/record creation time. The range itself comes from
  // the semantic planner, so this stays language-independent.
  const taggedDates = (Array.isArray(memory.tags) ? memory.tags : [])
    .map((tag) => /^(?:ts|time):(\d{4}-\d{2}-\d{2})(?:T[^\s]+)?$/i.exec(String(tag || ''))?.[1] || null)
    .filter(Boolean);
  const candidateDates = [
    memory.document_date,
    memory.documentDate,
    memory.created_at,
    memory.createdAt,
    memory.valid_from,
    memory.validFrom,
    memory.valid_to,
    memory.validTo,
    memory.metadata?.record_time,
    memory.metadata?.event_time,
    memory.metadata?.valid_from,
    memory.metadata?.valid_to,
    ...(Array.isArray(memory.event_dates) ? memory.event_dates : []),
    ...(Array.isArray(memory.eventDates) ? memory.eventDates : []),
    ...taggedDates,
  ].map(parseDateRangeBoundary).filter(Boolean);

  if (candidateDates.length === 0) return false;
  return candidateDates.some((date) => {
    if (start && date < start) return false;
    if (end && date > end) return false;
    return true;
  });
}

// Date-window scans may legitimately match hundreds of tenant memories. The
// final hybrid ranker retains only a small bounded set, so feeding the whole
// range into MMR and cross-encoding creates O(n^2) work without improving
// delivery. Prioritize the atomic kind selected by the semantic planner, then
// retain a bounded diversity tail. This uses structured intent, not keywords.
export function selectEventRangeCandidates(memories, boostType, limit = 60) {
  const rows = Array.isArray(memories) ? memories : [];
  const cap = Math.max(15, Math.min(120, Number(limit) || 60));
  const bt = String(boostType || '').toLowerCase();
  if (!bt) return rows.slice(0, cap);
  const matching = [];
  const remaining = [];
  for (const memory of rows) {
    const mt = String(memory?.memory_type || memory?.memoryType || '').toLowerCase();
    (mt === bt ? matching : remaining).push(memory);
  }
  return [...matching, ...remaining].slice(0, cap);
}
