import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';

const { lockOutboxRecord } = await import('../../src/memory/outbox.js');

test('outbox advisory lock uses executeRaw so PostgreSQL void is never deserialized', async () => {
  const calls = [];
  const tx = {
    $queryRaw() {
      throw new Error('queryRaw must not be used for a void-returning advisory lock');
    },
    async $executeRawUnsafe(sql, recordId) {
      calls.push({ sql, recordId });
      return 1;
    },
  };

  const recordId = '4bd21e73-f968-4738-8a87-cff3135d5e71';
  await lockOutboxRecord(tx, recordId);

  assert.deepEqual(calls, [{
    sql: 'SELECT pg_advisory_xact_lock(hashtext($1::text))',
    recordId,
  }]);
});
