const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const INTENTS = new Set(['relevant', 'latest_mention', 'latest_event', 'as_of', 'timeline', 'diff']);

export function sanitizeMetadata(value, path = '$') {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.replace(CONTROL_CHARACTERS, '');
  if (Array.isArray(value)) return value.map((item, index) => sanitizeMetadata(item, `${path}[${index}]`));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [key.replace(CONTROL_CHARACTERS, ''), sanitizeMetadata(item, `${path}.${key}`)]));
  }
  throw new TypeError(`unsupported metadata value at ${path}`);
}

export function validateIngestionResult({ ingestMode, document, evidence = [], memories = [] }) {
  if (!['evidence', 'both'].includes(ingestMode)) throw new Error('ingest_mode must be evidence or both');
  if (!document?.id || !document?.organizationId || !document?.uploaderUserId) throw new Error('document provenance is incomplete');
  if (evidence.some((segment) => segment.documentId !== document.id)) throw new Error('evidence belongs to another document');
  if (ingestMode === 'evidence' && memories.length) throw new Error('evidence-only ingestion must not promote memories');
  if (ingestMode === 'both' && memories.length > 15) throw new Error('memory promotion exceeds the Engine Box 15-memory cap');
  if (memories.some((memory) => memory.organizationId !== document.organizationId || !memory.citation?.documentId)) throw new Error('memory provenance is incomplete');
  return { documents: 1, evidence: evidence.length, memories: memories.length, mode: ingestMode };
}

export function validateRetrievalSpec(input) {
  const spec = structuredClone(input || {});
  if (typeof spec.query !== 'string' || !spec.query.trim()) throw new Error('RetrievalSpec.query is required');
  if (!spec.scope?.organization_id) throw new Error('RetrievalSpec.scope.organization_id is required');
  spec.intent ||= 'relevant';
  if (!INTENTS.has(spec.intent)) throw new Error(`unsupported retrieval intent: ${spec.intent}`);
  spec.limit = Math.min(Math.max(Number(spec.limit || 15), 1), 50);
  spec.subject ||= {};
  for (const field of ['entities', 'document_ids', 'source_filenames']) {
    if (spec.subject[field] !== undefined && !Array.isArray(spec.subject[field])) throw new Error(`RetrievalSpec.subject.${field} must be an array`);
  }
  return spec;
}

export function orderingFor(spec) {
  switch (validateRetrievalSpec(spec).intent) {
    case 'latest_mention': return [['known_at', 'desc'], ['relevance', 'desc'], ['id', 'asc']];
    case 'latest_event': return [['event_time', 'desc'], ['known_at', 'desc'], ['id', 'asc']];
    case 'as_of': case 'timeline': case 'diff': return [['known_at', 'asc'], ['id', 'asc']];
    default: return [['relevance', 'desc'], ['known_at', 'desc'], ['id', 'asc']];
  }
}

export function mergeRetrievalLanes({ memories = [], evidence = [], spec }) {
  const validated = validateRetrievalSpec(spec);
  const seen = new Set();
  const normalize = (item, lane) => ({ ...item, lane, id: String(item.id), known_at: item.known_at || item.knownAt || '', relevance: Number(item.relevance ?? item.score ?? 0) });
  const retained = [];
  for (const [lane, items] of [['memory', memories], ['evidence', evidence]]) {
    for (const raw of items) {
      const item = normalize(raw, lane);
      const key = `${lane}:${item.id}`;
      if (!seen.has(key)) { seen.add(key); retained.push(item); }
    }
  }
  const ordering = orderingFor(validated);
  retained.sort((left, right) => {
    for (const [field, direction] of ordering) {
      const a = left[field] ?? ''; const b = right[field] ?? '';
      const compared = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));
      if (compared) return direction === 'desc' ? -compared : compared;
    }
    return 0;
  });
  const selected = retained.slice(0, validated.limit);
  return { selected, counts: { memories: memories.length, evidence: evidence.length, selected_memories: selected.filter((item) => item.lane === 'memory').length, selected_evidence: selected.filter((item) => item.lane === 'evidence').length } };
}
