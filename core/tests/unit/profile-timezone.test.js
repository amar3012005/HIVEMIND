import test from 'node:test';
import assert from 'node:assert/strict';
import { profileTimezone } from '../../src/profile-timezone.js';

const prisma = (rows, account) => ({ $queryRawUnsafe: async () => rows, user: { findUnique: async () => account } });
test('the proactive schedule zone wins, newest valid first', async () => {
  assert.equal(await profileTimezone(prisma([{ timezone: 'Not/AZone' }, { timezone: 'Asia/Calcutta' }], { timezone: 'Europe/Berlin' }), 'u', 'o'), 'Asia/Calcutta');
});
test('the account zone is used unless it is the UTC default', async () => {
  assert.equal(await profileTimezone(prisma([], { timezone: 'Europe/Rome' }), 'u', 'o'), 'Europe/Rome');
  assert.equal(await profileTimezone(prisma([], { timezone: 'UTC' }), 'u', 'o'), null);
});
test('an unreadable schedule falls back, and nothing known is null', async () => {
  assert.equal(await profileTimezone({ $queryRawUnsafe: async () => { throw new Error('no table'); }, user: { findUnique: async () => ({ timezone: 'Europe/Berlin' }) } }, 'u', 'o'), 'Europe/Berlin');
  assert.equal(await profileTimezone(prisma([], null), 'u', 'o'), null);
});
