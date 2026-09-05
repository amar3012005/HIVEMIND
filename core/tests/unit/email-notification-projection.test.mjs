import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmailNotificationSink } from '../../src/workspace/email-notification-projection.js';

function fakePrisma({ memberships = [] } = {}) {
  const writes = [];
  return {
    writes,
    user: { findUnique: async () => memberships.length ? { id: 'user-1', organizations: memberships.map((orgId) => ({ orgId })) } : null },
    workspaceNotification: {
      upsert: async (args) => { writes.push(args); return { id: `notification-${writes.length}` }; },
    },
  };
}

test('accepted email creates one idempotent notification in exact lifecycle context', async () => {
  const prisma = fakePrisma();
  const sink = createEmailNotificationSink(prisma);
  const input = {
    to: 'owner@example.com',
    templateId: 'day1_first_move',
    rendered: { subject: 'Day 1 research ready' },
    result: { ok: true, provider: 'cloudflare', deliveryStatus: 'queued', messageId: '<receipt-1@example.test>' },
    notification: { type: 'lifecycle.email.sent', orgId: 'org-1', userId: 'user-1', href: 'https://next.example.test/room/1' },
  };
  const first = await sink(input);
  const second = await sink(input);
  assert.equal(first.created, 1);
  assert.equal(second.dedupeKey, first.dedupeKey);
  assert.equal(prisma.writes.length, 2);
  assert.equal(prisma.writes[0].where.orgId_userId_dedupeKey.dedupeKey, first.dedupeKey);
  assert.equal(prisma.writes[0].create.data.channel, 'email');
  assert.equal(prisma.writes[0].create.data.href, 'https://next.example.test/room/1');
});

test('generic email is delivery-only and never enters the lifecycle inbox', async () => {
  const prisma = fakePrisma({ memberships: ['org-1', 'org-2'] });
  const sink = createEmailNotificationSink(prisma);
  const result = await sink({
    to: 'owner@example.com',
    templateId: 'announcement',
    rendered: { subject: 'Platform update' },
    result: { ok: true, provider: 'cloudflare', messageId: '<receipt-2@example.test>' },
  });
  assert.deepEqual(result, { created: 0, reason: 'not_lifecycle_notification' });
  assert.equal(prisma.writes.length, 0);
});

test('unscoped lifecycle notification is rejected even for an external recipient', async () => {
  const prisma = fakePrisma();
  const sink = createEmailNotificationSink(prisma);
  const result = await sink({
    to: 'external@example.test', rendered: { subject: 'Invitation' },
    result: { ok: true, provider: 'cloudflare', messageId: '<receipt-3@example.test>' },
  });
  assert.deepEqual(result, { created: 0, reason: 'not_lifecycle_notification' });
  assert.equal(prisma.writes.length, 0);
});
