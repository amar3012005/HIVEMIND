import crypto from 'node:crypto';
import { createWorkspaceNotification } from './notifications.js';

function clean(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function receiptKey(result = {}) {
  const receipt = clean(result.messageId, 512) || crypto.randomUUID();
  return crypto.createHash('sha256').update(`${result.provider || 'email'}:${receipt}`).digest('hex');
}

/**
 * Project only explicitly-scoped lifecycle email into the workspace lifecycle
 * inbox. Generic system email is delivery-only: it must never become a
 * workspace notification merely because its recipient is a platform member.
 */
export function createEmailNotificationSink(prisma) {
  return async ({ to, rendered, templateId, result, notification = {} } = {}) => {
    if (!prisma || !result?.ok) return { created: 0, reason: 'not_accepted' };
    const type = clean(notification.type, 80);
    const orgId = clean(notification.orgId, 128);
    const userId = clean(notification.userId, 128);
    if (!type.startsWith('lifecycle.') || !orgId || !userId) {
      return { created: 0, reason: 'not_lifecycle_notification' };
    }
    const targets = [{ orgId, userId }];

    const key = receiptKey(result);
    const title = clean(notification.title || rendered?.subject || 'Email sent', 180);
    const body = clean(notification.body || 'A copy of this notification was sent to your email inbox.', 1000);
    const created = await Promise.all(targets.map((target) => createWorkspaceNotification(prisma, {
      ...target,
      type,
      title,
      body,
      resourceType: clean(notification.resourceType, 80) || 'system_email',
      resourceId: clean(notification.resourceId, 128) || key,
      dedupeKey: `email-sent:${key}`,
      data: {
        channel: 'email',
        provider: result.provider || null,
        delivery_status: result.deliveryStatus || 'accepted',
        template_id: clean(templateId, 120),
        subject: clean(rendered?.subject, 300),
        href: clean(notification.href, 1000) || null,
        ...(notification.data && typeof notification.data === 'object' ? notification.data : {}),
      },
    })));
    return { created: created.filter(Boolean).length, dedupeKey: `email-sent:${key}` };
  };
}
