import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeAccessApplication,
  submitAccessApplication,
  reviewAccessApplication,
} from '../../src/billing/access-application-service.js';

test('normalizes homepage Personal and Enterprise values without trusting arbitrary types', () => {
  assert.equal(normalizeAccessApplication({ name: ' Ada ', email: 'ADA@Example.com', use: 'Personal' }).accountType, 'personal');
  assert.equal(normalizeAccessApplication({ name: 'Lin', email: 'lin@example.com', account_type: 'enterprise' }).accountType, 'enterprise');
  assert.throws(() => normalizeAccessApplication({ name: 'Lin', email: 'lin@example.com', account_type: 'admin' }), /Account type/);
});

test('re-submission is idempotent by hashed email and account type', async () => {
  let call;
  const prisma = { accessApplication: { upsert: async (args) => { call = args; return args.create; } } };
  await submitAccessApplication(prisma, { name: 'Ada', email: 'ada@example.com', use: 'Personal' });
  assert.equal(call.where.emailHash_accountType.accountType, 'personal');
  assert.equal(call.where.emailHash_accountType.emailHash.length, 64);
  assert.equal(call.update.status, 'pending');
});

test('review permits only approval or discard and does not update missing rows', async () => {
  const prisma = { accessApplication: {
    updateMany: async () => ({ count: 0 }),
    findUnique: async () => null,
  } };
  await assert.rejects(() => reviewAccessApplication(prisma, { id: 'x', status: 'approved', operator: 'A' }), /unavailable/);
  await assert.rejects(() => reviewAccessApplication(prisma, { id: 'x', status: 'invited', operator: 'A' }), /invalid/);
});
