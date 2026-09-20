import test from 'node:test';
import assert from 'node:assert/strict';
import { nextWorkspaceAnnouncement, normalizeAnnouncementInput } from '../../src/workspace/announcements.js';

test('announcement input keeps only safe CTA destinations and typed display data', () => {
  const result = normalizeAnnouncementInput({
    key: 'release.day-1', title: 'Day 1 is ready', placement: 'toast',
    content: {
      eyebrow: 'hivemind — lifecycle',
      facts: [{ label: 'What changed', value: 'Research is ready.' }],
      agent_ids: ['lena', 'omar', 'lena'],
      cta: { label: 'Open report', href: '/hivemind/app/employees' },
    },
  });
  assert.deepEqual(result.content.agent_ids, ['lena', 'omar']);
  assert.equal(result.content.facts[0].label, 'What changed');
  assert.equal(result.content.cta.href, '/hivemind/app/employees');
  assert.throws(() => normalizeAnnouncementInput({ key: 'bad.link', title: 'Unsafe', content: { cta: { href: 'https://attacker.example' } } }), /destination is not allowed/);
});

test('announcement delivery persists an inbox record and never repeats after CTA action', async () => {
  const row = {
    id: 'announcement-1', key: 'release.day-1', version: 1, status: 'published', placement: 'toast', priority: 10,
    title: 'Day 1 is ready', body: 'Open the research report.', content: { cta: { label: 'Open', href: '/hivemind/app/employees' } }, audience: { kind: 'all' }, requiresNotification: true,
    startsAt: null, endsAt: null, createdAt: new Date(), publishedAt: new Date(),
  };
  let delivery = null;
  let notificationWrites = 0;
  const prisma = {
    userOrganization: { findFirst: async () => ({ org: { plan: 'enterprise', accountType: 'enterprise_managed' } }) },
    hyperRoom: { findFirst: async () => ({ agentConnectors: { _company: { day0_report_email: { status: 'sent' } } } }) },
    workspaceAnnouncement: { findMany: async () => [row] },
    workspaceNotification: { upsert: async () => { notificationWrites += 1; return { id: 'notice-1' }; } },
    workspaceAnnouncementDelivery: {
      findUnique: async () => delivery,
      upsert: async ({ create, update }) => { delivery = { id: 'delivery-1', ...(delivery || create), ...(delivery ? update : {}) }; return delivery; },
    },
  };
  const first = await nextWorkspaceAnnouncement({ prisma, orgId: 'org-1', userId: 'user-1' });
  assert.equal(first.id, 'announcement-1');
  assert.equal(notificationWrites, 1);
  delivery.actionedAt = new Date();
  const second = await nextWorkspaceAnnouncement({ prisma, orgId: 'org-1', userId: 'user-1' });
  assert.equal(second, null);
  assert.equal(notificationWrites, 1);
});
