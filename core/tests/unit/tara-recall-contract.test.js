import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaraRecallFn, TaraStreamHandler } from '../../src/tara/stream-handler.js';

test('TARA consumes the injected bounded recall service and keeps a narrow fact set', async () => {
  const calls = [];
  const recallFn = createTaraRecallFn({
    recall: async (query, options, context) => {
      calls.push({ query, options, context });
      return {
        memories: Array.from({ length: 10 }, (_, index) => ({
          id: `m${index}`,
          content: `fact ${index}`,
          memory_type: 'fact',
        })),
      };
    },
  });
  const handler = new TaraStreamHandler({
    memoryStore: {},
    recallFn,
  });

  const rows = await handler._fastKBRecall('What is our pricing model?', {
    userId: 'user-1',
    orgId: 'org-1',
    accessContext: { projectIds: ['project-1'], teamIds: [] },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].query, 'What is our pricing model?');
  assert.equal(calls[0].options.mode, 'fact');
  assert.equal(calls[0].options.include_live, false);
  assert.deepEqual(calls[0].context.accessContext.projectIds, ['project-1']);
  assert.equal(rows.length, 8);
});
