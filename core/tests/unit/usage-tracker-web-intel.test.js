import test from 'node:test';
import assert from 'node:assert/strict';
import { UsageTracker } from '../../src/billing/usage-tracker.js';

test('web intelligence usage atomically updates the monthly rollup', async () => {
  const statements = [];
  const prisma = {
    $executeRawUnsafe: async (sql, ...params) => {
      statements.push({ sql, params });
      return 1;
    },
  };
  const tracker = new UsageTracker(prisma);
  await tracker.recordWebIntel('00000000-0000-4000-8000-000000000002');
  assert.match(statements[0].sql, /ON CONFLICT \("orgId", "month"\)/);
  assert.match(statements[0].sql, /"webIntelDay" = \$3::date/);
  assert.equal(statements[0].params.length, 3);
  assert.match(statements[1].sql, /org_usage_cumulative/);
});
