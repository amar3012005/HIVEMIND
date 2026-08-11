const DELIVERED_EVENT = 'notification.welcome_signup_delivered';
const FAILED_EVENT = 'notification.welcome_signup_failed';

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

  async function hasReceipt(userId) {
    if (deliveredThisProcess.has(userId)) return true;
    const receipt = await prisma?.auditLog?.findFirst({
      where: { userId, eventType: DELIVERED_EVENT },
      select: { id: true },
    });
    if (receipt) deliveredThisProcess.add(userId);
    return Boolean(receipt);
  }

  async function appendReceipt(user, eventType, source, delivery) {
    try {
      await prisma?.auditLog?.create({
        data: {
          userId: user.id,
          eventType,
          eventCategory: 'notification',
          action: 'send',
          actorType: 'system',
          metadata: {
            template_id: 'welcome_signup',
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

  async function deliver(user, { source = 'user_creation' } = {}) {
    if (!user?.id || !user?.email) return { ok: false, skipped: true, error: 'no_user_email' };
    if (await hasReceipt(user.id)) return { ok: true, deduped: true, template: 'welcome_signup' };
    if (inFlight.has(user.id)) return inFlight.get(user.id);

    const pending = (async () => {
      const delivery = await sendEmail({
        templateId: 'welcome_signup',
        to: user.email,
        vars: { name: firstNameFor(user), email: user.email },
      });
      const eventType = delivery?.ok ? DELIVERED_EVENT : FAILED_EVENT;
      const receiptPersisted = await appendReceipt(user, eventType, source, delivery);
      if (delivery?.ok) deliveredThisProcess.add(user.id);
      return { ...delivery, template: 'welcome_signup', receiptPersisted };
    })().catch(async (error) => {
      const failure = { ok: false, error: error.message || 'delivery_failed' };
      await appendReceipt(user, FAILED_EVENT, source, failure);
      return { ...failure, template: 'welcome_signup' };
    }).finally(() => inFlight.delete(user.id));

    inFlight.set(user.id, pending);
    return pending;
  }

  return { deliver, hasReceipt };
}

export const SIGNUP_WELCOME_DELIVERED_EVENT = DELIVERED_EVENT;

