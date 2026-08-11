import { buildRecallPacket } from '../memory/recall-packet.js';

export function ensureMemoryCitationPackets(recallPackets = [], memories = [], { mode = 'fact' } = {}) {
  const citedMemoryIds = new Set(
    recallPackets.flatMap((packet) => packet?.citations || [])
      .map((citation) => citation?.memory_id)
      .filter(Boolean),
  );
  const uncited = memories.filter((memory) => memory?.id && !citedMemoryIds.has(memory.id));
  if (!uncited.length) return recallPackets;
  return [...recallPackets, buildRecallPacket({ facts: uncited, plan: { mode } })];
}

export function citationIdForMemory(citations = [], memory = {}) {
  return citations.find((citation) => citation?.memory_id === memory?.id)?.id || null;
}

export function citationIdForEvidence(citations = [], evidence = {}) {
  const segmentId = evidence?.segment_id || evidence?.segmentId || evidence?.id;
  return citations.find((citation) => citation?.segment_id === segmentId)?.id || null;
}
