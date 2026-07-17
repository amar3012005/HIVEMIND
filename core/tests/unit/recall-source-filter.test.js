import test from 'node:test';
import assert from 'node:assert/strict';
import { filterMemoriesByDocumentIds } from '../../src/memory/recall-source-filter.js';

test('keeps only memories belonging to resolved source documents', () => {
  const rows = [
    { id: 'tagged', tags: ['doc-id:source-a'] },
    { id: 'metadata', source_metadata: { document_id: 'source-a' } },
    { id: 'wrapped', memory: { id: 'wrapped', sourceMetadata: { documentId: 'source-a' } } },
    { id: 'other', tags: ['doc-id:source-b'] },
    { id: 'unlinked' },
  ];

  assert.deepEqual(filterMemoriesByDocumentIds(rows, ['source-a']), rows.slice(0, 3));
});

test('fails closed when an explicit source resolves to no document IDs', () => {
  assert.deepEqual(filterMemoriesByDocumentIds([{ id: 'unscoped' }], []), []);
});
