import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchPlatformRegistryOutbox, enqueuePlatformRegistryEvent } from '../../src/control-plane/platform-registry-outbox.js';

test('outbox rejects unknown entity types', async () => {
  const prisma = { platformRegistryOutbox: { create: async () => { throw new Error('must not write'); } } };
  assert.equal(await enqueuePlatformRegistryEvent(prisma, { entityType: 'memory', entityId: 'x', payload: {} }), null);
});

test('disabled client leaves durable rows untouched', async () => {
  const result = await dispatchPlatformRegistryOutbox({}, { client: { enabled: false } });
  assert.deepEqual(result, { skipped: true, delivered: 0, failed: 0 });
});
