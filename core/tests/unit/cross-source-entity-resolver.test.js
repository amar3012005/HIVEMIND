import test from 'node:test';
import assert from 'node:assert/strict';
import { CrossSourceEntityResolver, stableExternalIds } from '../../src/knowledge/cross-source-entity-resolver.js';

test('legacy entity resolution ignores names, aliases, and email domains', async () => {
  const updates = [];
  const prisma = {
    entity: {
      findMany: async ({ where }) => where.entityType === 'person' ? [
        { id: 'a', canonicalName: '王伟', aliases: ['Wei Wang', 'same@example.com'], mentionCount: 2, externalIds: { email: 'same@example.com' } },
        { id: 'b', canonicalName: '王伟', aliases: ['Wei Wang', 'same@example.com'], mentionCount: 1, externalIds: { email: 'same@example.com' } },
      ] : [],
      update: (args) => ({ kind: 'entity', args }),
    },
    entityMention: { updateMany: (args) => ({ kind: 'mention', args }) },
    $transaction: async (ops) => { updates.push(...ops); },
  };

  const merged = await new CrossSourceEntityResolver({ prisma }).resolveOrg('org-a');
  assert.equal(merged, 0);
  assert.equal(updates.length, 0);
});

test('legacy entity resolution merges exact provider-native identifiers', async () => {
  const transactions = [];
  const prisma = {
    entity: {
      findMany: async ({ where }) => where.entityType === 'person' ? [
        { id: 'a', canonicalName: 'Ada', aliases: [], mentionCount: 2, externalIds: { slack_id: 'U123' } },
        { id: 'b', canonicalName: 'A. Lovelace', aliases: [], mentionCount: 1, externalIds: { slack_id: 'U123' } },
      ] : [],
      update: (args) => ({ kind: 'entity', args }),
    },
    entityMention: { updateMany: (args) => ({ kind: 'mention', args }) },
    $transaction: async (ops) => { transactions.push(ops); },
  };

  const merged = await new CrossSourceEntityResolver({ prisma }).resolveOrg('org-a');
  assert.equal(merged, 1);
  assert.equal(transactions.length, 1);
});

test('stable external IDs preserve Unicode values without regex normalization', () => {
  assert.deepEqual([...stableExternalIds({ externalIds: { crm_id: '顧客-７', email: 'x@y.test' } })], ['crm_id:顧客-７']);
});
