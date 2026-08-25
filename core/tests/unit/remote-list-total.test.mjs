import test from 'node:test';
import assert from 'node:assert/strict';

import { registerAgent, remoteList, unregisterAgent } from '../../src/vector/mneme/remote-backend.js';

test('remote list preserves the agent-filtered total and never invents one', async () => {
  const orgId = '00000000-0000-4000-8000-00000000f001';
  const originalFetch = globalThis.fetch;
  const payloads = [
    { memories: [{ id: 'm-1' }], cursor: null, total: 17 },
    { memories: [{ id: 'ignored-page' }], cursor: null },
    { memories: [
      { id: 'm-legacy', layer: 'memory' },
      { id: 'e-legacy', layer: 'evidence_segment' },
    ], cursor: null },
  ];
  registerAgent(orgId, 'http://memory-box.test', 'test-token');
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'http://memory-box.test/v1/list');
    assert.equal(options.headers['x-org-id'], orgId);
    return new Response(JSON.stringify(payloads.shift()), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const exact = await remoteList(orgId, { is_latest: true }, null, 1, 0);
    assert.equal(exact.total, 17);
    assert.deepEqual(exact.memories, [{ id: 'm-1' }]);

    const compatible = await remoteList(orgId, { is_latest: true }, null, 1, 0);
    assert.equal(compatible.total, 1, 'legacy pagination computes an exact memory-layer inventory');
    assert.deepEqual(compatible.memories, [{ id: 'm-legacy', layer: 'memory' }]);
  } finally {
    globalThis.fetch = originalFetch;
    unregisterAgent(orgId);
  }
});
