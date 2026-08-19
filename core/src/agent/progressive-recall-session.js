import { createHash, randomUUID } from 'node:crypto';

const candidateKey = (candidate = {}) => candidate.kind === 'memory'
  ? `memory:${candidate.memory_id || candidate.id || ''}`
  : `evidence:${candidate.segment_id || candidate.id || ''}`;

export function evidenceWindowSizeForDepth(depth = 'standard', { nativeSingleCall = false } = {}) {
  if (nativeSingleCall && depth === 'detailed') return 15;
  return ({ standard: 5, detailed: 10, comprehensive: 15 })[depth] || 5;
}

export function evidenceRenderLimit({ progressiveRecall = null, eventWindowHits = 0, recallMode = 'quick' } = {}) {
  return progressiveRecall?.delivered_until
    || (eventWindowHits > 0
      ? eventWindowHits
      : (recallMode === 'insight' ? 10 : (recallMode === 'panorama' ? 12 : 6)));
}

export function evidenceRowId(row = {}) {
  return row.segment_id || row.segmentId || row.id || null;
}

export function createProgressiveRecallSession({
  rankedCandidates = [], memories = [], evidence = [], query = '', initialSize = 5, pageSize = 5, maxVisible = 15,
} = {}) {
  const memoryById = new Map((memories || []).filter((row) => row?.id).map((row) => [row.id, row]));
  const evidenceById = new Map((evidence || []).filter((row) => evidenceRowId(row))
    .map((row) => [evidenceRowId(row), row]));
  const ordered = [];
  const seen = new Set();

  const add = (candidate) => {
    const kind = candidate?.kind === 'evidence' ? 'evidence' : 'memory';
    const id = kind === 'memory'
      ? (candidate.memory_id || candidate.id)
      : (candidate.segment_id || candidate.id);
    const row = kind === 'memory' ? memoryById.get(id) : evidenceById.get(id);
    if (!id || !row) return;
    const normalized = { kind, ...(kind === 'memory' ? { memory_id: id } : { segment_id: id }) };
    const key = candidateKey(normalized);
    if (seen.has(key)) return;
    seen.add(key);
    ordered.push({ ...normalized, rank: ordered.length + 1 });
  };

  for (const candidate of rankedCandidates || []) add(candidate);
  // Explicit degradation path for older recall providers. Interleave lanes;
  // never compare their incomparable score scales.
  for (let index = 0; ordered.length < maxVisible && index < Math.max(memories.length, evidence.length); index += 1) {
    if (evidence[index]) add({ kind: 'evidence', segment_id: evidenceRowId(evidence[index]) });
    if (memories[index]) add({ kind: 'memory', memory_id: memories[index].id });
  }

  const candidates = ordered.slice(0, Math.max(initialSize, maxVisible));
  const queryHash = createHash('sha256').update(String(query || '')).digest('hex').slice(0, 24);
  return {
    schema_version: 1,
    recall_id: randomUUID(),
    query_hash: queryHash,
    candidates,
    initial_size: Math.max(1, initialSize),
    page_size: Math.max(1, pageSize),
    max_visible: Math.max(1, maxVisible),
    delivered_until: Math.min(Math.max(1, initialSize), candidates.length),
    expansion_count: 0,
    degraded_order: !(rankedCandidates || []).length,
  };
}

export function applyProgressiveRecallView(evidenceBundle = {}, session) {
  if (!session) return evidenceBundle;
  const visible = session.candidates.slice(0, session.delivered_until);
  const memoryRanks = new Map(visible.filter((row) => row.kind === 'memory').map((row) => [row.memory_id, row.rank]));
  const evidenceRanks = new Map(visible.filter((row) => row.kind === 'evidence').map((row) => [row.segment_id, row.rank]));
  const memories = (evidenceBundle.memories || []).filter((row) => memoryRanks.has(row.id))
    .map((row) => ({ ...row, _progressive_rank: memoryRanks.get(row.id) }));
  const evidence = (evidenceBundle.evidence || []).filter((row) => evidenceRanks.has(evidenceRowId(row)))
    .map((row) => ({ ...row, _progressive_rank: evidenceRanks.get(evidenceRowId(row)) }));
  const recallPackets = restrictRecallPackets(evidenceBundle.recall_packets || [], { memoryRanks, evidenceRanks });
  return { ...evidenceBundle, memories, evidence, recall_packets: recallPackets, progressive_recall: session };
}

export function restrictRecallPackets(packets = [], { memoryRanks = new Map(), evidenceRanks = new Map() } = {}) {
  return (packets || []).map((packet) => {
    const facts = (packet?.facts || []).filter((fact) => memoryRanks.has(fact?.id || fact?.memory_id || fact?.memoryId));
    const sourceSections = (packet?.sourceSections || []).filter((section) => evidenceRanks.has(section?.segment_id));
    const citations = (packet?.citations || []).filter((citation) =>
      (citation?.memory_id && memoryRanks.has(citation.memory_id))
      || (citation?.segment_id && evidenceRanks.has(citation.segment_id)));
    return { ...packet, facts, sourceSections, citations };
  }).filter((packet) => packet.facts.length || packet.sourceSections.length || packet.citations.length);
}

export function collapseNativeOnlyCompoundDecision(decision = {}, fallbackQuery = '') {
  if (decision?.operation !== 'compound' || !Array.isArray(decision.subtasks) || !decision.subtasks.length) return decision;
  // Capability is the authority boundary. Hosted planners occasionally label
  // an analysis/feedback step as a "write" even though its only executable
  // capability is read-only recall. Do not turn that hallucinated label into
  // a redundant compound execution. Genuine native writes and every external
  // connector remain on their governed paths because their groups are absent
  // from this read-only allowlist.
  const nativeReadGroups = new Set(['hivemind-recall', 'hivemind-projects']);
  const nativeRecallOnly = decision.subtasks.every((step) => {
    const groups = Array.isArray(step?.tool_groups) ? step.tool_groups : [];
    return groups.length > 0 && groups.every((group) => nativeReadGroups.has(group));
  });
  if (!nativeRecallOnly) return decision;
  const queries = [...new Set([
    decision.query_canonical_en,
    ...(decision.queries || []),
    ...decision.subtasks.flatMap((step) => [step?.query, step?.message, step?.instruction]),
    fallbackQuery,
  ].filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
  return {
    ...decision,
    operation: 'recall',
    tool_groups: ['hivemind-recall'],
    queries: queries.slice(0, 3),
    subtasks: undefined,
    _native_compound_collapsed: true,
  };
}
