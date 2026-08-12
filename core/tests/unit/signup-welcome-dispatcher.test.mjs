import assert from 'node:assert/strict';
import test from 'node:test';
import { createSignupWelcomeDispatcher } from '../../src/email/signup-welcome-dispatcher.js';

function harness({ delivered = false, sendResult = { ok: true, provider: 'cloudflare', deliveryStatus: 'delivered' } } = {}) {
  const receipts = delivered ? [{ id: 'existing', userId: 'user-1', organizationId: null, eventType: 'notification.welcome_signup_delivered' }] : [];
  const events = [];
  let sends = 0;
  const prisma = { auditLog: {
    findFirst: async ({ where }) => receipts.find((receipt) => (
      receipt.userId === where.userId
      && receipt.organizationId === (where.organizationId || null)
      && receipt.eventType === where.eventType
    )) || null,
    create: async ({ data }) => {
      events.push(data);
      if (data.eventType.endsWith('_delivered')) receipts.push({ id: 'new', userId: data.userId, organizationId: data.organizationId || null, eventType: data.eventType });
      return data;
    },
  } };
  const sendEmail = async () => { sends += 1; await new Promise(resolve => setTimeout(resolve, 5)); return sendResult; };
  const dispatcher = createSignupWelcomeDispatcher({ prisma, sendEmail, logger: { warn() {} } });
  return { dispatcher, events, sends: () => sends };
}

test('concurrent creation and Overview recovery produce one welcome', async () => {
  const h = harness();
  const user = { id: 'user-1', email: 'maya@example.com', displayName: 'Maya Chen' };
  const [created, recovered] = await Promise.all([
    h.dispatcher.deliver(user, { source: 'user_creation' }),
    h.dispatcher.deliver(user, { source: 'overview_recovery' }),
  ]);
  assert.equal(created.ok, true);
  assert.equal(recovered.ok, true);
  assert.equal(h.sends(), 1);
  assert.equal(h.events.filter(event => event.eventType.endsWith('_delivered')).length, 1);
});

test('durable delivered receipt prevents a later process from resending', async () => {
  const h = harness({ delivered: true });
  const result = await h.dispatcher.deliver({ id: 'user-1', email: 'maya@example.com' });
  assert.equal(result.deduped, true);
  assert.equal(h.sends(), 0);
});

test('failed delivery is recorded and remains retryable', async () => {
  const h = harness({ sendResult: { ok: false, error: 'provider_unavailable' } });
  const result = await h.dispatcher.deliver({ id: 'user-1', email: 'maya@example.com' });
  assert.equal(result.ok, false);
  assert.equal(h.sends(), 1);
  assert.equal(h.events[0].eventType.endsWith('_failed'), true);
});

test('workspace activation selects a personal or enterprise welcome and deduplicates per workspace', async () => {
  const h = harness();
  const user = { id: 'user-1', email: 'maya@example.com', displayName: 'Maya Chen' };
  const personal = await h.dispatcher.deliver(user, {
    workspace: { id: 'org-personal', name: 'Maya', accountType: 'personal', hostingMode: 'managed' },
  });
  const enterprise = await h.dispatcher.deliver(user, {
    workspace: { id: 'org-enterprise', name: 'Northstar', accountType: 'enterprise_managed', hostingMode: 'managed' },
  });
  const duplicate = await h.dispatcher.deliver(user, {
    workspace: { id: 'org-enterprise', name: 'Northstar', accountType: 'enterprise_managed', hostingMode: 'managed' },
  });
  assert.equal(personal.template, 'welcome_personal_workspace');
  assert.equal(enterprise.template, 'welcome_enterprise_workspace');
  assert.equal(duplicate.deduped, true);
  assert.equal(h.sends(), 2);
  assert.equal(h.events[0].organizationId, 'org-personal');
  assert.equal(h.events[1].organizationId, 'org-enterprise');
});
