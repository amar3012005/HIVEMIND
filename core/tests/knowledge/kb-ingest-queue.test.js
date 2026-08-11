import assert from 'node:assert/strict';
import test from 'node:test';

import { durableQueueJobId } from '../../src/knowledge/kb-ingest-queue.js';

test('durable BullMQ IDs never contain the forbidden colon separator', () => {
  const id = durableQueueJobId('378c5f62-8848-48bc-be28-4f8af4d1e2b5', 2);
  assert.equal(id, '378c5f62-8848-48bc-be28-4f8af4d1e2b5-v2');
  assert.equal(id.includes(':'), false);
});
