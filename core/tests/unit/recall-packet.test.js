import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecallPacket, validateGroundedClaims, NO_GROUNDED_EVIDENCE } from '../../src/memory/recall-packet.js';

test('claim validation removes duplicate semantic sentences and merges citations', () => {
  const result = validateGroundedClaims({ claims: [
    { text: 'Pantene is a division of Procter & Gamble.', grounded: true, citation_ids: ['C1'] },
    { text: '  PANTENE is a division of Procter & Gamble! ', grounded: true, citation_ids: ['C2'] },
  ] }, { citations: [{ id: 'C1' }, { id: 'C2' }] });
  assert.equal(result.claims.length, 1);
  assert.deepEqual(result.claims[0].citation_ids, ['C1', 'C2']);
  assert.equal(result.answer, 'Pantene is a division of Procter & Gamble.');
});

test('RecallPacket assigns server-owned stable citation ids', () => {
  const packet = buildRecallPacket({
    facts: [{ id: 'm1' }],
    sourceSections: [
      { segment_id: 's1', document_id: 'd1', document_title: 'Board notes', content: 'approved budget' },
      { segment_id: 's1', document_id: 'd1', document_title: 'Board notes', content: 'duplicate' },
    ],
    plan: { mode: 'explain' },
  });
  assert.equal(packet.citations.length, 2);
  assert.deepEqual(packet.citations[0], {
    id: 'C1', segment_id: 's1', document_id: 'd1', title: 'Board notes', page: null, source_label: 'Board notes',
  });
  assert.deepEqual(packet.citations[1], {
    id: 'C2', memory_id: 'm1', segment_id: null, document_id: null, title: null, page: null, source_label: 'Workspace memory',
  });
  assert.equal(packet.coverage.source_sections, 2);
});

test('grounded claims require packet citation ids and enterprise defaults to no general knowledge', () => {
  const packet = buildRecallPacket({
    sourceSections: [{ segment_id: 's1', document_title: 'Board notes', content: 'approved budget' }],
  });
  const rejected = validateGroundedClaims({
    answer: 'The budget was approved.',
    claims: [{ text: 'The budget was approved.', grounded: true, citation_ids: ['C404'] }],
  }, packet);
  assert.equal(rejected.answer, NO_GROUNDED_EVIDENCE);
  assert.equal(rejected.rejected_claims[0].reason, 'missing_valid_citation');

  const accepted = validateGroundedClaims({
    claims: [{ text: 'The budget was approved.', grounded: true, citation_ids: ['C1'] }],
  }, packet);
  assert.equal(accepted.claims.length, 1);
  assert.deepEqual(accepted.claims[0].citation_ids, ['C1']);
});

test('general knowledge is only retained with explicit opt-in', () => {
  const packet = buildRecallPacket();
  const answer = validateGroundedClaims({
    claims: [{ text: 'Paris is in France.', grounded: false, citation_ids: [] }],
  }, packet, { allowGeneralKnowledge: true });
  assert.equal(answer.claims[0].grounded, false);
});

test('validated answer cannot retain prose outside accepted claims', () => {
  const packet = buildRecallPacket({ facts: [{ id: 'm1', title: 'Approved budget' }] });
  const answer = validateGroundedClaims({
    answer: 'The budget was approved. Unsupported extra sentence.',
    claims: [{ text: 'The budget was approved.', grounded: true, citation_ids: ['C1'] }],
  }, packet);
  assert.equal(answer.answer, 'The budget was approved.');
  assert.equal(packet.citations[0].memory_id, 'm1');
});
