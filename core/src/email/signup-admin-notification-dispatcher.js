import crypto from 'node:crypto';

const DELIVERY_TYPE = 'account_created';
const SENDING_LEASE_MS = 10 * 60 * 1000;
const EMAIL_ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function recipientHash(email) {
  return crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');
}

function recipientHint(email) {
  const [local = '', domain = ''] = String(email).trim().toLowerCase().split('@');
  return `${local.slice(0, 2)}***@${domain}`.slice(0, 160);
}

function displayNameFor(user) {
  return String(user?.displayName || user?.email?.split('@')[0] || 'A new user').trim().slice(0, 120);
}

export function signupAdminRecipients(value = process.env.HIVEMIND_SIGNUP_ADMIN_EMAILS) {
  const candidates = String(value || '').split(/[;,\n]/).map((email) => email.trim().toLowerCase());
  return [...new Set(candidates.filter((email) => EMAIL_ADDRESS.test(email)))].slice(0, 12);
}

/**
 * Delivers one account-created notification per configured administrator.
 * The ledger is deliberately marked submitted_unknown before provider I/O:
 * a transport timeout can mean the provider accepted the message, so retries
 * must be reconciled instead of blindly creating another admin email.
 */
export function createSignupAdminNotificationDispatcher({ prisma, sendEmail, recipients = signupAdminRecipients(), logger = console }) {
  const inFlight = new Map();

  async function reserve({ userId, recipient }) {
    const leaseUntil = new Date(Date.now() + SENDING_LEASE_MS);
    const inserted = await prisma.$queryRawUnsafe(
      `INSERT INTO hivemind.account_admin_notifications
         (user_id, recipient_hash, recipient_hint, notification_type, status, send_lease_until)
       VALUES ($1::uuid, $2, $3, $4, 'reserved', $5)
       ON CONFLICT (user_id, recipient_hash, notification_type) DO NOTHING
       RETURNING id, status, provider, delivery_status, provider_receipts`,
      userId, recipientHash(recipient), recipientHint(recipient), DELIVERY_TYPE, leaseUntil,
    );
    if (inserted?.[0]) return { action: 'send', delivery: inserted[0] };

    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, status, provider, delivery_status, provider_receipts, send_lease_until
         FROM hivemind.account_admin_notifications
        WHERE user_id=$1::uuid AND recipient_hash=$2 AND notification_type=$3
        LIMIT 1`,
      userId, recipientHash(recipient), DELIVERY_TYPE,
    );
    const delivery = existing?.[0];
    if (!delivery) throw new Error('admin_signup_notification_ledger_unavailable');
    if (delivery.status === 'accepted') return { action: 'accepted', delivery };
    return { action: 'reconcile', delivery };
  }

  async function markSubmitted(id) {
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE hivemind.account_admin_notifications
          SET status='submitted_unknown', submission_started_at=CURRENT_TIMESTAMP,
              provider_attempts=provider_attempts+1, send_lease_until=NULL, updated_at=CURRENT_TIMESTAMP,
              provider_receipts=provider_receipts || jsonb_build_array(jsonb_build_object('at', CURRENT_TIMESTAMP, 'outcome', 'submission_started'))
        WHERE id=$1::uuid AND status='reserved'
        RETURNING id`,
      id,
    );
    if (!rows?.[0]) throw new Error('admin_signup_notification_claim_lost');
  }

  async function settle(id, delivery) {
    const status = delivery?.ok ? 'accepted' : 'rejected';
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE hivemind.account_admin_notifications
          SET status=$2, provider=$3, delivery_status=$4,
              accepted_at=CASE WHEN $2='accepted' THEN CURRENT_TIMESTAMP ELSE accepted_at END,
              rejected_at=CASE WHEN $2='rejected' THEN CURRENT_TIMESTAMP ELSE rejected_at END,
              last_error=CASE WHEN $2='rejected' THEN $5 ELSE NULL END,
              updated_at=CURRENT_TIMESTAMP,
              provider_receipts=provider_receipts || jsonb_build_array(jsonb_build_object(
                'at', CURRENT_TIMESTAMP, 'outcome', $2, 'provider', $3,
                'delivery_status', $4, 'message_id', $6, 'error', $5))
        WHERE id=$1::uuid AND status='submitted_unknown'
        RETURNING id, status, provider, delivery_status`,
      id, status, delivery?.provider || null, delivery?.deliveryStatus || (delivery?.ok ? 'accepted' : null),
      String(delivery?.error || 'delivery_failed').slice(0, 240) || null, delivery?.messageId || null,
    );
    if (!rows?.[0]) throw new Error('admin_signup_notification_settlement_lost');
    return rows[0];
  }

  async function deliverTo(user, recipient, source) {
    const key = `${user.id}:${recipientHash(recipient)}`;
    if (inFlight.has(key)) return inFlight.get(key);
    const pending = (async () => {
      const reservation = await reserve({ userId: user.id, recipient });
      if (reservation.action === 'accepted') return { ok: true, deduped: true, recipient };
      if (reservation.action !== 'send') return { ok: false, retryable: false, reconcileRequired: true, recipient };
      await markSubmitted(reservation.delivery.id);
      const delivery = await sendEmail({
        templateId: 'admin_new_account_created',
        to: recipient,
        vars: {
          userName: displayNameFor(user),
          userEmail: user.email,
          authSource: source,
          createdAt: new Date().toISOString(),
        },
        // An unknown provider outcome must be reconciled by the ledger, never retried by fallback.
        providerAttempts: 1,
        providerFallback: false,
      });
      const settled = await settle(reservation.delivery.id, delivery);
      return { ...delivery, recipient, status: settled.status };
    })().catch((error) => {
      logger.error?.(JSON.stringify({ svc: 'email', level: 'error', event: 'admin_signup_notification_failed', userId: user.id, error: error.message }));
      return { ok: false, retryable: false, error: error.message, recipient };
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
    return pending;
  }

  async function deliver(user, { source = 'account_signup' } = {}) {
    if (!user?.id || !user?.email) return { ok: false, skipped: true, error: 'no_user_email' };
    if (recipients.length === 0) return { ok: true, skipped: true, reason: 'admin_recipients_unconfigured' };
    const deliveries = await Promise.all(recipients.map((recipient) => deliverTo(user, recipient, source)));
    return { ok: deliveries.every((delivery) => delivery.ok), deliveries };
  }

  return { deliver, recipients };
}
