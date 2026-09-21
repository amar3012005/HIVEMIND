import assert from 'node:assert/strict';
import test from 'node:test';
import { handleInternalWorkRunEventRoute } from '../../src/routes/workruns.js';

test('internal WorkRun ingress authenticates and forwards explicit completion', async () => {
  const received = [];
  const result = await handleInternalWorkRunEventRoute({
    req: { headers: { 'x-api-key': 'allowed' } }, res: {}, prisma: {},
    parseBody: async () => ({ event: { type: 'REPLY_END' }, complete: true, result: { receipt: 'r-1' } }),
    jsonResponse: (_res, body, statusCode = 200) => ({ body, statusCode }),
    hasInternalApiKey: (key) => key === 'allowed', workRunId: 'run-1',
    applyRuntimeEvent: async (_prisma, id, event) => { received.push({ id, event }); return { applied: true }; },
    completeWorkRun: async (_prisma, id, payload) => ({ ok: true, id, payload }),
  });
  assert.deepEqual(received, [{ id: 'run-1', event: { type: 'REPLY_END' } }]);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.completion.ok, true);
});

test('internal WorkRun ingress rejects unauthenticated calls', async () => {
  const result = await handleInternalWorkRunEventRoute({
    req: { headers: {} }, res: {}, prisma: {}, parseBody: async () => ({ event: {} }),
    jsonResponse: (_res, body, statusCode = 200) => ({ body, statusCode }),
    hasInternalApiKey: () => false,
  });
  assert.equal(result.statusCode, 401);
  assert.equal(result.body.error, 'Unauthorized');
});
