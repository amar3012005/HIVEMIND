import { createHash, randomUUID } from 'node:crypto';

const candidateKey = (candidate = {}) => candidate.kind === 'memory'
  ? `memory:${candidate.memory_id || candidate.id || ''}`
  : `evidence:${candidate.segment_id || candidate.id || ''}`;

export function createProgressiveRecallSession({
  rankedCandidates = [], memories = [], evidence = [], query = '', initialSize = 5, pageSize = 5, maxVisible = 15,
} = {}) {
  const memoryById = new Map((memories || []).filter((row) => row?.id).map((row) => [row.id, row]));
  const evidenceById = new Map((evidence || []).filter((row) => row?.segment_id || row?.id)
    .map((row) => [row.segment_id || row.id, row]));
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
    if (evidence[index]) add({ kind: 'evidence', segment_id: evidence[index].segment_id || evidence[index].id });
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

export function revealProgressiveRecall(session, deliveredUntil = session?.delivered_until || 5) {
  if (!session) return null;
  const bounded = Math.min(session.candidates.length, session.max_visible, Math.max(1, deliveredUntil));
  return { ...session, delivered_until: bounded };
}

export function expandProgressiveRecall(session) {
  if (!session || session.delivered_until >= session.candidates.length || session.expansion_count >= 2) return session;
  return {
    ...session,
    delivered_until: Math.min(session.candidates.length, session.max_visible, session.delivered_until + session.page_size),
    expansion_count: session.expansion_count + 1,
  };
}

export function applyProgressiveRecallView(evidenceBundle = {}, session) {
  if (!session) return evidenceBundle;
  const visible = session.candidates.slice(0, session.delivered_until);
  const memoryRanks = new Map(visible.filter((row) => row.kind === 'memory').map((row) => [row.memory_id, row.rank]));
  const evidenceRanks = new Map(visible.filter((row) => row.kind === 'evidence').map((row) => [row.segment_id, row.rank]));
  const memories = (evidenceBundle.memories || []).filter((row) => memoryRanks.has(row.id))
    .map((row) => ({ ...row, _progressive_rank: memoryRanks.get(row.id) }));
  const evidence = (evidenceBundle.evidence || []).filter((row) => evidenceRanks.has(row.segment_id || row.id))
    .map((row) => ({ ...row, _progressive_rank: evidenceRanks.get(row.segment_id || row.id) }));
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

export function shouldExpandProgressiveRecall(answer, session) {
  if (!session || session.delivered_until >= session.candidates.length || session.expansion_count >= 2) return false;
  return answer?.context_status === 'relevant_but_incomplete';
}
