import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeRetrievalLanes, orderingFor, sanitizeMetadata, validateIngestionResult, validateRetrievalSpec } from '../lib/contracts.mjs';

test('metadata sanitation removes Postgres-incompatible control characters without losing provenance', () => {
  assert.deepEqual(sanitizeMetadata({ document_id: 'doc\u0000-1', nested: ['x\u0001y'] }), { document_id: 'doc-1', nested: ['xy'] });
});

test('ingestion modes retain exact count semantics and provenance', () => {
  const document = { id: 'document-1', organizationId: 'org-1', uploaderUserId: 'user-1' };
  assert.deepEqual(validateIngestionResult({ ingestMode: 'evidence', document, evidence: [{ documentId: 'document-1' }] }), { documents: 1, evidence: 1, memories: 0, mode: 'evidence' });
  assert.throws(() => validateIngestionResult({ ingestMode: 'evidence', document, memories: [{}] }), /must not promote/);
  assert.throws(() => validateIngestionResult({ ingestMode: 'both', document, memories: Array.from({ length: 16 }, () => ({ organizationId: 'org-1', citation: { documentId: 'document-1' } })) }), /15-memory cap/);
});

test('filtered parallel retrieval preserves lane identity and uses deterministic temporal ordering', () => {
  const spec = validateRetrievalSpec({ query: 'Kruti', scope: { organization_id: 'org-1' }, intent: 'latest_mention', limit: 3, subject: { entities: ['Kruti'] } });
  assert.deepEqual(orderingFor(spec), [['known_at', 'desc'], ['relevance', 'desc'], ['id', 'asc']]);
  const result = mergeRetrievalLanes({ spec, memories: [{ id: 'm-1', known_at: '2026-08-20T00:00:00Z', relevance: 0.9 }], evidence: [{ id: 'e-1', known_at: '2026-08-21T00:00:00Z', relevance: 0.1 }] });
  assert.equal(result.selected[0].id, 'e-1');
  assert.deepEqual(result.counts, { memories: 1, evidence: 1, selected_memories: 1, selected_evidence: 1 });
});
