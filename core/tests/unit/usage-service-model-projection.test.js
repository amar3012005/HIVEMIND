import test from 'node:test';
import assert from 'node:assert/strict';

import { UsageService } from '../../src/billing/usage-service.js';
import { UsageTracker } from '../../src/billing/usage-tracker.js';

test('settled token events project per-model prompt and completion usage', async () => {
  const projected = [];
  const prisma = {
    async $transaction(callback) {
      return callback({ async $executeRawUnsafe() {} });
    },
  };
  const usageTracker = {
    async recordKeyUsage(...args) { projected.push(args); },
    _invalidateCache() {},
  };
  const service = new UsageService({ prisma, planEnforcer: null, usageTracker });

  await service._applyProjection('1380251c-f707-4aee-98a4-dd93b63b4a00', 'llm_tokens', 130, {
    api_key_id: null,
    source: 'hyperagents-room',
    metadata: {
      model: 'openai/gpt-oss-20b',
      feature: 'hyperagents-room',
      prompt_tokens: 100,
      completion_tokens: 30,
      request_count: 4,
    },
  });

  assert.deepEqual(projected, [[
    '1380251c-f707-4aee-98a4-dd93b63b4a00',
    130,
    null,
    'openai/gpt-oss-20b',
    'hyperagents-room',
    { promptTokens: 100, completionTokens: 30, requestCount: 4 },
  ]]);
});

test('per-model rollup preserves the number of provider requests', async () => {
  const writes = [];
  const tracker = new UsageTracker({
    async $executeRawUnsafe(_sql, ...params) { writes.push(params); },
  });

  await tracker.recordKeyUsage(
    '1380251c-f707-4aee-98a4-dd93b63b4a00',
    130,
    null,
    'openai/gpt-oss-20b',
    'hyperagents-room',
    { promptTokens: 100, completionTokens: 30, requestCount: 4 },
  );

  assert.equal(writes.length, 1);
  assert.equal(writes[0].at(-1), 4);
});
