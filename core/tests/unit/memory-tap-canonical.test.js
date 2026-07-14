import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryTapMiddleware } from '../../src/agent/middleware/memory-tap.js';

test('read-only connector results use canonical ingestion with stable provenance', async () => {
  const calls = [];
  const middleware = createMemoryTapMiddleware({ logger: { warn() {} } });
  const kwargs = {
    tool_call: { tool: { name: 'notion_read_page', readOnly: true } },
    args: { page_id: 'page-1' },
    ctx: {
      userId: 'user-1', orgId: 'org-1',
      ingestCanonicalPayload: async (...args) => calls.push(args),
    },
  };
  const response = {
    status: 'ok',
    meta: { raw: { content: [{ text: JSON.stringify({ title: 'Policy', body: 'The retention period is seven years.' }) }] } },
  };

  await middleware(kwargs, async () => response);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].source_metadata.source_platform, 'notion');
  assert.match(calls[0][0].source_metadata.source_id, /^notion:notion_read_page:[a-f0-9]{24}$/);
  assert.deepEqual(calls[0][1], { sourceType: 'connector', provider: 'notion' });
});
