import crypto from 'node:crypto';

function clean(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function recipientHash(email) {
  return crypto.createHash('sha256').update(String(email || '').trim().toLowerCase()).digest('hex');
}

function recipientHint(email) {
  const [local = '', domain = ''] = String(email || '').trim().toLowerCase().split('@');
  return `${local.slice(0, 2)}***@${domain}`.slice(0, 160);
}

/**
 * Records a transport outcome once per provider message. Raw addresses are
 * never copied into this ledger: the platform already owns them in the user,
 * invitation, or access-application records used by authorized admin views.
 */
export function createSystemEmailDeliveryReceiptSink(prisma) {
  return async ({ to, rendered = {}, templateId, result = {}, notification = {} } = {}) => {
    if (!prisma || !to) return { recorded: false, reason: 'unavailable' };
    const provider = clean(result.provider, 64) || null;
    const messageId = clean(result.messageId, 512) || null;
    const status = result.ok ? (clean(result.deliveryStatus, 64) || 'accepted') : 'rejected';
    const receipt = {
      at: new Date().toISOString(),
      outcome: result.ok ? 'accepted' : 'rejected',
      provider,
      delivery_status: status,
      message_id: messageId,
      error: clean(result.error || result.reason, 240) || null,
    };
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO hivemind.system_email_deliveries
         (recipient_hash, recipient_hint, org_id, user_id, activation_id, template_id, subject,
          provider, provider_message_id, delivery_status, provider_receipts, accepted_at, rejected_at)
       VALUES ($1, $2, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9, $10, jsonb_build_array($11::jsonb),
               CASE WHEN $12 THEN CURRENT_TIMESTAMP ELSE NULL END,
               CASE WHEN $12 THEN NULL ELSE CURRENT_TIMESTAMP END)
       ON CONFLICT (provider, provider_message_id) WHERE provider_message_id IS NOT NULL
       DO UPDATE SET delivery_status=EXCLUDED.delivery_status,
                     provider_receipts=hivemind.system_email_deliveries.provider_receipts || EXCLUDED.provider_receipts,
                     accepted_at=COALESCE(hivemind.system_email_deliveries.accepted_at, EXCLUDED.accepted_at),
                     rejected_at=COALESCE(hivemind.system_email_deliveries.rejected_at, EXCLUDED.rejected_at),
                     updated_at=CURRENT_TIMESTAMP
       RETURNING id`,
      recipientHash(to), recipientHint(to), clean(notification.orgId, 128) || null,
      clean(notification.userId, 128) || null, clean(notification.activationId || notification.resourceId, 128) || null,
      clean(templateId, 120) || 'rendered_message', clean(rendered.subject, 300) || 'System email', provider,
      messageId, status, JSON.stringify(receipt), Boolean(result.ok),
    );
    return { recorded: Boolean(rows?.[0]?.id), id: rows?.[0]?.id || null };
  };
}

function eventStatus(type, payload = {}) {
  if (type === 'cf.email.sending.message.delivered') return 'delivered';
  if (type === 'cf.email.sending.message.deferred') return 'deferred';
  if (type === 'cf.email.sending.message.bounced') return 'bounced';
  if (type === 'cf.email.sending.message.complained') return 'complained';
  if (type === 'cf.email.sending.message.rejected') return 'rejected';
  if (type === 'cf.email.sending.message.failed') return 'failed';
  return clean(payload?.delivery?.status, 64) || null;
}

/** Idempotently applies one Cloudflare Email Sending event by message ID. */
export async function recordCloudflareEmailDeliveryEvent(prisma, event = {}) {
  const type = clean(event.type, 128);
  const messageId = clean(event?.payload?.messageId, 512);
  const eventId = clean(event?.payload?.eventId || event?.metadata?.eventId, 128);
  const status = eventStatus(type, event.payload);
  if (!prisma || !messageId || !status || !type.startsWith('cf.email.sending.message.')) {
    return { applied: false, reason: 'invalid_event' };
  }
  const receipt = {
    event_id: eventId || null,
    type,
    at: event?.metadata?.eventTimestamp || new Date().toISOString(),
    delivery: event.payload?.delivery || null,
    rejection: event.payload?.rejection || null,
    failure: event.payload?.failure || null,
    bounce: event.payload?.bounce || null,
  };
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE hivemind.system_email_deliveries
        SET delivery_status=$2,
            provider_receipts=CASE
              WHEN $3 <> '' AND provider_receipts @> jsonb_build_array(jsonb_build_object('event_id', $3)) THEN provider_receipts
              ELSE provider_receipts || jsonb_build_array($4::jsonb)
            END,
            rejected_at=CASE WHEN $2 IN ('bounced','rejected','failed','complained') THEN COALESCE(rejected_at, CURRENT_TIMESTAMP) ELSE rejected_at END,
            updated_at=CURRENT_TIMESTAMP
      WHERE provider='cloudflare' AND provider_message_id=$1
      RETURNING id`,
    messageId, status, eventId || '', JSON.stringify(receipt),
  );
  return { applied: Boolean(rows?.length), id: rows?.[0]?.id || null, status };
}
