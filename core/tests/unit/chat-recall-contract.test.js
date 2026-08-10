import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAgentRecallMode, TOOL_SCHEMAS } from '../../src/agent/tool-registry.js';
import { buildEvidencePacket } from '../../src/memory/recall-router.js';
import {
  buildChatCitationPacket,
  validateChatAnswer,
} from '../../src/agent/react-agent-v2.js';

test('chat recall maps legacy modes to the bounded server contract', () => {
  assert.equal(normalizeAgentRecallMode('quick'), 'fact');
  assert.equal(normalizeAgentRecallMode('panorama'), 'explain');
  assert.equal(normalizeAgentRecallMode('insight'), 'explain');
  assert.equal(normalizeAgentRecallMode('full'), 'full');
  assert.equal(normalizeAgentRecallMode('unexpected'), 'fact');
});

test('chat save schema cannot create relationship memory objects', () => {
  const save = TOOL_SCHEMAS.find((tool) => tool.function.name === 'hivemind_save_memory');
  assert.ok(save);
  assert.deepEqual(save.function.parameters.properties.memory_type.enum, [
    'fact', 'preference', 'decision', 'goal', 'event', 'lesson',
  ]);
});

test('multilingual evidence remains structured without keyword classification', () => {
  const packet = buildEvidencePacket({
    memories: [{ id: 'm1', title: 'Entscheidung zur Datenhaltung', content: 'Die Daten bleiben in Frankfurt.' }],
    evidence: [{ segmentId: 's1', documentId: 'd1', content: '顧客データはフランクフルトに保存されます。' }],
    graph: [{ type: 'Extends', from_id: 'm1', to_id: 'm2' }],
    plan: { mode: 'explain' },
    trace: { evidence_trigger: 'document-anchor' },
  });
  assert.equal(packet.source_sections[0].content, '顧客データはフランクフルトに保存されます。');
  assert.equal(packet.graph_evidence[0].type, 'Extends');
});

test('chat namespaces server-owned citations across recall subqueries', () => {
  const packet = buildChatCitationPacket([
    { citations: [{ id: 'C1', memory_id: 'm1' }] },
    { citations: [{ id: 'C1', segment_id: 's2' }] },
  ]);
  assert.deepEqual(packet.citations.map((citation) => citation.id), ['P1-C1', 'P2-C1']);
});

test('chat rejects model-invented citations and keeps opt-in general knowledge visibly ungrounded', () => {
  const packets = [{ citations: [{ id: 'C1', memory_id: 'm1' }] }];
  const rejected = validateChatAnswer({
    claims: [{ text: 'Invented claim', grounded: true, citation_ids: ['P1-C404'] }],
  }, packets);
  assert.equal(rejected.claims.length, 0);
  assert.equal(rejected.rejected_claims[0].reason, 'missing_valid_citation');

  const allowed = validateChatAnswer({
    claims: [{ text: 'General answer', grounded: false, citation_ids: [] }],
  }, packets, { allowGeneralKnowledge: true });
  assert.equal(allowed.answer, 'General answer');
  assert.equal(allowed.grounded, false);
});
