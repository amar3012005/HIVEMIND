import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureMemoryCitationPackets, citationIdForEvidence, citationIdForMemory } from '../../src/agent/chat-evidence-contract.js';

test('every delivered memory receives its own citation instead of borrowing an unrelated document citation', () => {
  const packets = ensureMemoryCitationPackets([{
    citations: [{ id: 'C1', segment_id: 'segment-a', document_id: 'document-a' }],
  }], [{ id: 'memory-b', document_id: 'document-b', content: 'Brand is G ROCHER.' }]);
  const namespaced = packets.flatMap((packet, packetIndex) =>
    (packet.citations || []).map((citation) => ({ ...citation, id: `P${packetIndex + 1}-${citation.id}` })),
  );

  assert.equal(citationIdForMemory(namespaced, { id: 'memory-b' }), 'P2-C1');
  assert.notEqual(citationIdForMemory(namespaced, { id: 'memory-b' }), 'P1-C1');
});

test('resolves document evidence citations by stable segment id', () => {
  assert.equal(citationIdForEvidence([{ id: 'P1-E1', segment_id: 'segment-1' }], { segment_id: 'segment-1' }), 'P1-E1');
  assert.equal(citationIdForEvidence([{ id: 'P1-E1', segment_id: 'segment-1' }], { segment_id: 'segment-2' }), null);
});

test('unknown memory never falls back to the first available citation', () => {
  assert.equal(citationIdForMemory([{ id: 'P1-C1', memory_id: 'other' }], { id: 'missing' }), null);
});
