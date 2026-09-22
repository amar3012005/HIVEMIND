import test from 'node:test';
import assert from 'node:assert/strict';
import { createSignupAdminNotificationDispatcher, signupAdminRecipients } from '../../src/email/signup-admin-notification-dispatcher.js';

function ledgerMock() {
  const rows = new Map();
  return {
    async $queryRawUnsafe(sql, ...args) {
      const key = `${args[0]}:${args[1]}`;
      if (sql.includes('INSERT INTO hivemind.account_admin_notifications')) {
        if (rows.has(key)) return [];
        const row = { id: `notice-${rows.size + 1}`, status: 'reserved', provider_receipts: [] };
        rows.set(key, row);
        return [row];
      }
      if (sql.includes('SELECT id, status, provider')) return rows.has(key) ? [rows.get(key)] : [];
      if (sql.includes("SET status='submitted_unknown'")) {
        const row = [...rows.values()].find((candidate) => candidate.id === args[0]);
        row.status = 'submitted_unknown';
        return [{ id: row.id }];
      }
      if (sql.includes('SET status=$2, provider=$3')) {
        const [id, status, provider, deliveryStatus] = args;
        const row = [...rows.values()].find((candidate) => candidate.id === id);
        row.status = status; row.provider = provider; row.delivery_status = deliveryStatus;
        return [row];
      }
      return [];
    },
    rows,
  };
}

test('recipient configuration is bounded, valid, and deduplicated', () => {
  assert.deepEqual(signupAdminRecipients('ADMIN@singulance.com, bad, admin@singulance.com; ops@singulance.com'), ['admin@singulance.com', 'ops@singulance.com']);
});

test('a new account sends each configured administrator one notification only', async () => {
  const prisma = ledgerMock();
  const calls = [];
  const dispatcher = createSignupAdminNotificationDispatcher({
    prisma,
    recipients: ['admin@singulance.com'],
    sendEmail: async (args) => { calls.push(args); return { ok: true, provider: 'cloudflare', deliveryStatus: 'accepted', messageId: 'provider-1' }; },
  });
  const user = { id: '11111111-1111-4111-8111-111111111111', email: 'new.user@example.com', displayName: 'New User' };
  assert.equal((await dispatcher.deliver(user, { source: 'google_signup' })).ok, true);
  assert.equal((await dispatcher.deliver(user, { source: 'google_signup' })).ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].templateId, 'admin_new_account_created');
  assert.equal(calls[0].vars.userEmail, 'new.user@example.com');
});

test('an unconfigured notification list leaves account creation untouched', async () => {
  const dispatcher = createSignupAdminNotificationDispatcher({ prisma: ledgerMock(), recipients: [], sendEmail: async () => { throw new Error('must not send'); } });
  const result = await dispatcher.deliver({ id: '11111111-1111-4111-8111-111111111111', email: 'new.user@example.com' });
  assert.deepEqual(result, { ok: true, skipped: true, reason: 'admin_recipients_unconfigured' });
});
