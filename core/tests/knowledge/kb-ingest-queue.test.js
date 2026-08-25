import assert from 'node:assert/strict';
import test from 'node:test';

import { durableQueueJobId, isStoredEvidencePromotion } from '../../src/knowledge/kb-ingest-queue.js';

test('durable BullMQ IDs never contain the forbidden colon separator', () => {
  const id = durableQueueJobId('378c5f62-8848-48bc-be28-4f8af4d1e2b5', 2);
  assert.equal(id, '378c5f62-8848-48bc-be28-4f8af4d1e2b5-v2');
  assert.equal(id.includes(':'), false);
});

test('stored-evidence promotion is selected only with an explicit durable document id', () => {
  assert.equal(isStoredEvidencePromotion({ promotion_existing_evidence: true, promotion_document_id: 'doc-1' }), true);
  assert.equal(isStoredEvidencePromotion({ promotion_existing_evidence: true }), false);
  assert.equal(isStoredEvidencePromotion({ promotion_document_id: 'doc-1' }), false);
});
