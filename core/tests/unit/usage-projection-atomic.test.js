import test from 'node:test';
import assert from 'node:assert/strict';
import { UsageService } from '../../src/billing/usage-service.js';

test('usage projection is one atomic database statement, not an interactive transaction', async () => {
  const calls = [];
  const prisma = {
    $queryRawUnsafe: async (...args) => { calls.push(args); return [{ projected: 1 }]; },
    $transaction: async () => { throw new Error('interactive transaction must not be used'); },
  };
  const service = new UsageService({ prisma });
  await service._applyProjection('00000000-0000-0000-0000-000000000001', 'search_queries', 1, {});
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /WITH monthly_projection/);
  assert.match(calls[0][0], /daily_projection/);
});
