import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureMemoryCitationPackets, citationIdForMemory } from '../../src/agent/chat-evidence-contract.js';

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

test('unknown memory never falls back to the first available citation', () => {
  assert.equal(citationIdForMemory([{ id: 'P1-C1', memory_id: 'other' }], { id: 'missing' }), null);
});
