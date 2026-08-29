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
 * Project a provider-accepted email into the existing workspace notification
 * inbox. Exact lifecycle context wins; generic sends resolve active workspace
 * memberships from the recipient's registered platform account.
 */
export function createEmailNotificationSink(prisma) {
  return async ({ to, rendered, templateId, result, notification = {} } = {}) => {
    if (!prisma || !result?.ok) return { created: 0, reason: 'not_accepted' };
    let targets = [];
    if (notification.orgId && notification.userId) {
      targets = [{ orgId: notification.orgId, userId: notification.userId }];
    } else {
      const user = await prisma.user.findUnique({
        where: { email: String(to || '').trim().toLowerCase() },
        select: { id: true, organizations: { where: { isActive: true }, select: { orgId: true } } },
      });
      targets = (user?.organizations || []).map(({ orgId }) => ({ orgId, userId: user.id }));
    }
    if (!targets.length) return { created: 0, reason: 'recipient_has_no_platform_inbox' };

    const key = receiptKey(result);
    const title = clean(notification.title || rendered?.subject || 'Email sent', 180);
    const body = clean(notification.body || 'A copy of this notification was sent to your email inbox.', 1000);
    const created = await Promise.all(targets.map((target) => createWorkspaceNotification(prisma, {
      ...target,
      type: clean(notification.type, 80) || 'email.sent',
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
