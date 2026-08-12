const GENERIC_DELIVERED_EVENT = 'notification.welcome_signup_delivered';
const GENERIC_FAILED_EVENT = 'notification.welcome_signup_failed';

export function welcomeProfileForWorkspace(workspace = null, { returning = false } = {}) {
  const enterprise = String(workspace?.accountType || '').startsWith('enterprise_');
  const prefix = enterprise ? 'enterprise' : 'personal';
  const suffix = returning ? 'login' : 'workspace';
  return {
    templateId: `welcome_${prefix}_${suffix}`,
    deliveredEvent: `notification.welcome_${prefix}_${suffix}_delivered`,
    failedEvent: `notification.welcome_${prefix}_${suffix}_failed`,
  };
}

function firstNameFor(user) {
  return String(user?.displayName || user?.email?.split('@')[0] || 'there').trim().split(/\s+/)[0];
}

/**
 * Delivers the account welcome once per user. The append-only audit receipt
 * survives process restarts; the in-flight map collapses concurrent callback
 * and Overview recovery requests in the same process.
 */
export function createSignupWelcomeDispatcher({ prisma, sendEmail, logger = console }) {
  const inFlight = new Map();
  const deliveredThisProcess = new Set();

  async function hasReceipt(userId, organizationId, deliveredEvent, receiptKey) {
    if (deliveredThisProcess.has(receiptKey)) return true;
    const receipt = await prisma?.auditLog?.findFirst({
      where: { userId, organizationId: organizationId || null, eventType: deliveredEvent },
      select: { id: true },
    });
    if (receipt) deliveredThisProcess.add(receiptKey);
    return Boolean(receipt);
  }

  async function appendReceipt(user, workspace, eventType, source, templateId, delivery) {
    try {
      await prisma?.auditLog?.create({
        data: {
          userId: user.id,
          organizationId: workspace?.id || null,
          eventType,
          eventCategory: 'notification',
          action: 'send',
          actorType: 'system',
          metadata: {
            template_id: templateId,
            source,
            provider: delivery?.provider || null,
            delivery_status: delivery?.deliveryStatus || null,
            safe_error: delivery?.ok ? null : (delivery?.error || 'delivery_failed'),
          },
        },
      });
      return true;
    } catch (error) {
      logger.warn?.('[welcome-email] audit receipt failed:', error.message);
      return false;
    }
  }

  async function deliver(user, { source = 'workspace_activation', workspace = null } = {}) {
    if (!user?.id || !user?.email) return { ok: false, skipped: true, error: 'no_user_email' };
    const profile = workspace
      ? welcomeProfileForWorkspace(workspace)
      : { templateId: 'welcome_signup', deliveredEvent: GENERIC_DELIVERED_EVENT, failedEvent: GENERIC_FAILED_EVENT };
    const receiptKey = `${user.id}:${workspace?.id || 'account'}:${profile.templateId}`;
    if (await hasReceipt(user.id, workspace?.id || null, profile.deliveredEvent, receiptKey)) {
      return { ok: true, deduped: true, template: profile.templateId };
    }
    if (inFlight.has(receiptKey)) return inFlight.get(receiptKey);

    const pending = (async () => {
      const delivery = await sendEmail({
        templateId: profile.templateId,
        to: user.email,
        vars: {
          name: firstNameFor(user),
          email: user.email,
          orgName: workspace?.name || '',
          accountType: workspace?.accountType || 'personal',
          hostingMode: workspace?.hostingMode || 'managed',
          onboardingEndsAt: workspace?.onboardingEndsAt || '',
        },
      });
      const eventType = delivery?.ok ? profile.deliveredEvent : profile.failedEvent;
      const receiptPersisted = await appendReceipt(user, workspace, eventType, source, profile.templateId, delivery);
      if (delivery?.ok) deliveredThisProcess.add(receiptKey);
      return { ...delivery, template: profile.templateId, receiptPersisted };
    })().catch(async (error) => {
      const failure = { ok: false, error: error.message || 'delivery_failed' };
      await appendReceipt(user, workspace, profile.failedEvent, source, profile.templateId, failure);
      return { ...failure, template: profile.templateId };
    }).finally(() => inFlight.delete(receiptKey));

    inFlight.set(receiptKey, pending);
    return pending;
  }

  return { deliver, hasReceipt };
}

export const SIGNUP_WELCOME_DELIVERED_EVENT = GENERIC_DELIVERED_EVENT;
