import test from 'node:test';
import assert from 'node:assert/strict';

import { dedupeAuthorizedEvidenceCandidates } from '../../src/memory/recall-evidence-dedup.js';

test('identical authorized evidence consumes one rerank slot and retains provenance', () => {
  const candidates = [
    {
      _kind: 'evidence', _content: 'Power rating: 12 kW.\nDimensions: 500 mm.',
      _row: { segment_id: 'segment-a', document_id: 'doc-a', project_id: 'project-a', score: 0.8 },
    },
    {
      _kind: 'evidence', _content: 'Power rating: 12 kW. Dimensions: 500 mm.',
      _row: { segment_id: 'segment-b', document_id: 'doc-b', project_id: 'project-b', score: 0.9, linked_memory_id: 'memory-b' },
    },
    {
      _kind: 'memory', _content: 'A distinct atomic fact.',
      _row: { id: 'memory-c' },
    },
  ];

  const result = dedupeAuthorizedEvidenceCandidates(candidates);
  assert.equal(result.length, 2);
  assert.equal(result[0]._row.segment_id, 'segment-b', 'lineage-bearing evidence copy wins');
  assert.deepEqual(result[0]._row.authorized_provenance.map((row) => row.segment_id), ['segment-a', 'segment-b']);
  assert.equal(result[1]._kind, 'memory');
});

test('distinct or contradictory evidence remains independently rankable', () => {
  const result = dedupeAuthorizedEvidenceCandidates([
    { _kind: 'evidence', _content: 'Power rating: 12 kW.', _row: { segment_id: 'a' } },
    { _kind: 'evidence', _content: 'Power rating: 14 kW.', _row: { segment_id: 'b' } },
  ]);
  assert.equal(result.length, 2);
});
