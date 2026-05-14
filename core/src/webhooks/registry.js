/**
 * WebhookRegistry — CRUD for outbound webhook subscriptions.
 *
 * Plain secret returned ONLY at creation (or explicit rotation). After
 * that we hold sha256 in DB + cache plain secret in WebhookDispatcher
 * for the lifetime of the process (re-cached on rotation).
 *
 * Caller-side access checks: routes must enforce `connector:manage` or
 * `org_admin` before invoking create / update / delete.
 */

import { generateSecret, hashSecret } from './dispatcher.js';

/** Curated allowlist of event types the platform can emit. Restrict to
 *  prevent typos and surface autocomplete in the UI. Extend as we ship
 *  more event taps. Empty `event_types` on a subscription = subscribe
 *  to ALL of these (matched at dispatch time, not registration). */
export const KNOWN_EVENT_TYPES = Object.freeze([
  // Membership
  'user.joined',
  'user.removed',
  'user.role_changed',
  // Billing
  'billing.subscribed',
  'billing.upgraded',
  'billing.cancelled',
  'billing.payment_failed',
  'billing.trial_ending',
  // Digital employees
  'employee.created',
  'employee.paused',
  'employee.resumed',
  'employee.deleted',
  'employee.action_blocked',
  // Teams / projects
  'team.created',
  'team.deleted',
  'project.created',
  'project.deleted',
  // Connectors
  'connector.installed',
  'connector.revoked',
  'connector.degraded',
  // Compliance
  'audit.policy_denied',
  'gdpr.export_completed',
  'gdpr.erasure_completed',
]);

function sanitizeEventTypes(input) {
  if (!Array.isArray(input)) return [];
  const set = new Set();
  for (const item of input) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (!KNOWN_EVENT_TYPES.includes(trimmed)) continue;
    set.add(trimmed);
  }
  return Array.from(set);
}

function publicFields(row) {
  return {
    id: row.id,
    org_id: row.orgId,
    url: row.url,
    description: row.description,
    event_types: row.eventTypes,
    enabled: row.enabled,
    created_by: row.createdBy,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    last_success_at: row.lastSuccessAt,
    last_failure_at: row.lastFailureAt,
    consecutive_failures: row.consecutiveFailures,
  };
}

export class WebhookRegistry {
  /**
   * @param {object} prisma — PrismaClient
   * @param {WebhookDispatcher} [dispatcher] — cache plain secret on create / rotate.
   */
  constructor(prisma, dispatcher = null) {
    this.prisma = prisma;
    this.dispatcher = dispatcher;
  }

  /**
   * Create a new subscription. Returns the row PLUS the plain `secret`
   * — only chance for the caller to capture it. After this call the
   * secret is only available in-memory on the dispatcher cache.
   */
  async create({ orgId, url, description = null, eventTypes = [], createdBy = null }) {
    if (!orgId) throw new Error('orgId required');
    if (!url || typeof url !== 'string') throw new Error('url required');
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('invalid_url');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('invalid_protocol');
    }

    const secret = generateSecret();
    const row = await this.prisma.webhookSubscription.create({
      data: {
        orgId,
        url,
        description,
        eventTypes: sanitizeEventTypes(eventTypes),
        secretHash: hashSecret(secret),
        enabled: true,
        createdBy: createdBy || null,
      },
    });
    if (this.dispatcher) this.dispatcher.cacheSecret(row.id, secret);
    return { ...publicFields(row), secret };
  }

  /** Returns null if the subscription doesn't belong to the org. */
  async get(orgId, id) {
    const row = await this.prisma.webhookSubscription.findUnique({ where: { id } });
    if (!row || row.orgId !== orgId) return null;
    return publicFields(row);
  }

  async list(orgId) {
    if (!orgId) return [];
    const rows = await this.prisma.webhookSubscription.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(publicFields);
  }

  async update(orgId, id, patch) {
    const existing = await this.prisma.webhookSubscription.findUnique({ where: { id } });
    if (!existing || existing.orgId !== orgId) return null;
    const data = {};
    if (typeof patch.url === 'string') {
      try {
        const parsed = new URL(patch.url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          throw new Error('invalid_protocol');
        }
        data.url = patch.url;
      } catch {
        throw new Error('invalid_url');
      }
    }
    if (typeof patch.description === 'string') data.description = patch.description;
    if (Array.isArray(patch.event_types)) data.eventTypes = sanitizeEventTypes(patch.event_types);
    if (typeof patch.enabled === 'boolean') data.enabled = patch.enabled;
    if (Object.keys(data).length === 0) return publicFields(existing);
    data.updatedAt = new Date();
    const row = await this.prisma.webhookSubscription.update({
      where: { id },
      data,
    });
    return publicFields(row);
  }

  /** Generate a new secret + persist hash. Returns the new plain secret. */
  async rotateSecret(orgId, id) {
    const existing = await this.prisma.webhookSubscription.findUnique({ where: { id } });
    if (!existing || existing.orgId !== orgId) return null;
    const secret = generateSecret();
    await this.prisma.webhookSubscription.update({
      where: { id },
      data: { secretHash: hashSecret(secret), updatedAt: new Date(), consecutiveFailures: 0 },
    });
    if (this.dispatcher) this.dispatcher.cacheSecret(id, secret);
    return { id, secret };
  }

  async delete(orgId, id) {
    const existing = await this.prisma.webhookSubscription.findUnique({ where: { id } });
    if (!existing || existing.orgId !== orgId) return false;
    await this.prisma.webhookSubscription.delete({ where: { id } });
    if (this.dispatcher) this.dispatcher.evictSecret(id);
    return true;
  }

  /** Recent delivery attempts for the org, joined to subscription URL. */
  async listDeliveries(orgId, { subscriptionId = null, limit = 100 } = {}) {
    const where = { orgId };
    if (subscriptionId) where.subscriptionId = subscriptionId;
    const rows = await this.prisma.webhookDelivery.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 500),
      include: { subscription: { select: { url: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      subscription_id: r.subscriptionId,
      subscription_url: r.subscription?.url || null,
      event_id: r.eventId,
      event_type: r.eventType,
      status: r.status,
      attempts: r.attempts,
      next_attempt_at: r.nextAttemptAt,
      last_status_code: r.lastStatusCode,
      last_error: r.lastError,
      delivered_at: r.deliveredAt,
      created_at: r.createdAt,
    }));
  }
}
