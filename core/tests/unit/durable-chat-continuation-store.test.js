import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createChatContinuation,
  claimDurableChatContinuation,
  settleDurableChatContinuation,
  releaseDurableChatContinuation,
} from '../../src/agent/chat-continuation-store.js';

function fakePrisma() {
  const rows = new Map();
  const matches = (row, where) => {
    if (where.id && row.id !== where.id) return false;
    if (where.tokenHash && row.tokenHash !== where.tokenHash) return false;
    if (where.orgId && row.orgId !== where.orgId) return false;
    if (where.userId && row.userId !== where.userId) return false;
    if (where.status && row.status !== where.status) return false;
    if (where.consumedAt === null && row.consumedAt !== null) return false;
    if (where.leaseToken && row.leaseToken !== where.leaseToken) return false;
    if (where.expiresAt?.gt && !(row.expiresAt > where.expiresAt.gt)) return false;
    if (where.OR && !where.OR.some((part) => {
      if (part.status && row.status !== part.status) return false;
      if (part.leaseExpiresAt?.lt && !(row.leaseExpiresAt < part.leaseExpiresAt.lt)) return false;
      return true;
    })) return false;
    return true;
  };
  const model = {
    async create({ data }) {
      const row = {
        id: `continuation-${rows.size + 1}`, status: 'pending', leaseToken: null,
        leaseExpiresAt: null, consumedAt: null, createdAt: new Date(), updatedAt: new Date(), ...data,
      };
      rows.set(row.id, row); return row;
    },
    async updateMany({ where, data }) {
      const selected = [...rows.values()].filter((row) => matches(row, where));
      selected.forEach((row) => Object.assign(row, data));
      return { count: selected.length };
    },
    async findUnique({ where }) {
      return [...rows.values()].find((row) => matches(row, where)) || null;
    },
  };
  const prisma = { durableChatContinuation: model };
  prisma.$transaction = (callback) => callback(prisma);
  return { prisma, rows };
}

const identity = {
  userId: '3b56a01a-7caf-4348-964a-566f52d8c437',
  orgId: '47e2ba84-1b9f-4e1b-804b-7bd77d4eea0f',
};

test('durable continuation stores only a token hash and is tenant-bound', async () => {
  const db = fakePrisma();
  const created = await createChatContinuation({
    ...identity, message: 'private request', resumeState: { subtasks: [] },
  }, { prisma: db.prisma, durable: true, parentTurnId: '74fb72fc-08da-41cc-8c56-598eae67bfee' });
  const row = [...db.rows.values()][0];
  assert.equal(row.tokenHash.length, 64);
  assert.equal(JSON.stringify(row).includes(created.token), false);
  assert.equal(await claimDurableChatContinuation(created.token, {
    prisma: db.prisma, orgId: identity.orgId, userId: 'e35811aa-4bcd-44bb-b829-a437895a42eb',
  }), null);
});

test('claim is fenced, failure releases it, and success consumes it exactly once', async () => {
  const db = fakePrisma();
  const created = await createChatContinuation({
    ...identity, message: 'continue', resumeState: { subtasks: [] },
  }, { prisma: db.prisma, durable: true });
  const first = await claimDurableChatContinuation(created.token, { prisma: db.prisma, ...identity });
  assert.ok(first?.leaseToken);
  assert.equal(await claimDurableChatContinuation(created.token, { prisma: db.prisma, ...identity }), null);
  assert.equal(await releaseDurableChatContinuation({ prisma: db.prisma, ...first }), true);
  const second = await claimDurableChatContinuation(created.token, { prisma: db.prisma, ...identity });
  assert.ok(second?.leaseToken);
  assert.equal(await settleDurableChatContinuation({ prisma: db.prisma, ...second }), true);
  assert.equal(await claimDurableChatContinuation(created.token, { prisma: db.prisma, ...identity }), null);
});
