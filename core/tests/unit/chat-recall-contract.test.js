import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAgentRecallMode, TOOL_SCHEMAS } from '../../src/agent/tool-registry.js';
import { buildEvidencePacket } from '../../src/memory/recall-router.js';

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
