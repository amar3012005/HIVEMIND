/**
 * WebhookDispatcher — enterprise outbound event notifications.
 *
 * Flow:
 *   1. emit(orgId, eventType, payload) — fans out to every enabled
 *      WebhookSubscription for the org whose event_types include this
 *      type (or is empty = subscribe to all).
 *   2. For each subscription, INSERT a webhook_deliveries row in
 *      `pending` state and kick a non-blocking deliver().
 *   3. deliver() POSTs JSON payload to subscription.url with HMAC-SHA256
 *      signature header. 2xx = mark delivered. Non-2xx + network errors
 *      bump attempts and schedule next_attempt_at via exponential
 *      backoff. After 6 failed attempts → dead_lettered.
 *   4. retryWorker() (in worker.js) periodically picks up pending rows
 *      whose next_attempt_at <= NOW() and re-runs deliver().
 *
 * Signature header:
 *   X-HiveMind-Signature: t=<unix_ts>,v1=<hmac_sha256_hex>
 *   Receivers verify: HMAC_SHA256(secret, `${t}.${raw_body}`)
 *
 * Standard headers per delivery:
 *   X-HiveMind-Event:        <event_type>
 *   X-HiveMind-Event-Id:     <delivery.event_id>     (idempotency)
 *   X-HiveMind-Delivery:     <delivery.id>           (per-attempt)
 *   X-HiveMind-Attempts:     <delivery.attempts>     (1..6)
 *   X-HiveMind-Subscription: <subscription.id>
 *   User-Agent:              HiveMind-Webhooks/1
 */

import crypto from 'crypto';

const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 6;
// Minutes for each attempt index (0-based). Attempt 1 has no prior delay.
const BACKOFF_MINUTES = [1, 5, 15, 60, 360, 1440];

function nowPlusMinutes(min) {
  return new Date(Date.now() + min * 60_000);
}

/** Compute the HMAC-SHA256 signature header for a payload. */
export function signPayload(secret, body, ts = Math.floor(Date.now() / 1000)) {
  const h = crypto.createHmac('sha256', secret);
  h.update(`${ts}.${body}`);
  return `t=${ts},v1=${h.digest('hex')}`;
}

/** Hash a plain secret for storage. We never store the plain secret. */
export function hashSecret(plain) {
  return crypto.createHash('sha256').update(String(plain)).digest('hex');
}

/** Generate a fresh webhook signing secret (returned once at creation). */
export function generateSecret() {
  return 'whsec_' + crypto.randomBytes(32).toString('base64url');
}

export class WebhookDispatcher {
  /**
   * @param {object} opts
   * @param {object} opts.prisma — PrismaClient
   * @param {object} [opts.audit] — optional AuditLogger for diagnostics
   * @param {(s:string)=>string} [opts.secretResolver] — given a secretHash,
   *   return the plain secret. Default: load from in-memory cache populated
   *   at subscription creation time. (Long-term: encrypt-at-rest + KMS.)
   */
  constructor({ prisma, audit = null, secretResolver = null } = {}) {
    if (!prisma) throw new Error('WebhookDispatcher requires prisma');
    this.prisma = prisma;
    this.audit = audit;
    this._secretCache = new Map(); // subscription_id → plain secret
    this._secretResolver = secretResolver;
  }

  cacheSecret(subscriptionId, plainSecret) {
    this._secretCache.set(subscriptionId, plainSecret);
  }

  evictSecret(subscriptionId) {
    this._secretCache.delete(subscriptionId);
  }

  async _resolveSecret(subscriptionId) {
    if (this._secretCache.has(subscriptionId)) {
      return this._secretCache.get(subscriptionId);
    }
    if (this._secretResolver) {
      const s = await this._secretResolver(subscriptionId);
      if (s) this._secretCache.set(subscriptionId, s);
      return s;
    }
    return null;
  }

  /**
   * Public entry. Fan out an event to every matching subscription.
   * Fire-and-forget: returns immediately, delivery happens async.
   *
   * @param {string} orgId
   * @param {string} eventType — e.g. "billing.subscribed"
   * @param {object} payload — JSON-serialisable event body
   */
  emit(orgId, eventType, payload) {
    if (!orgId || !eventType) return;
    this._dispatch(orgId, eventType, payload || {}).catch((err) => {
      console.warn('[webhooks.emit] dispatch failed:', err.message);
    });
  }

  async _dispatch(orgId, eventType, payload) {
    const subs = await this.prisma.webhookSubscription.findMany({
      where: {
        orgId,
        enabled: true,
        OR: [
          { eventTypes: { isEmpty: true } }, // subscribe-all
          { eventTypes: { has: eventType } },
        ],
      },
    });
    if (subs.length === 0) return;

    const eventId = `evt_${crypto.randomBytes(12).toString('base64url')}`;
    const fullPayload = {
      id: eventId,
      type: eventType,
      org_id: orgId,
      created_at: new Date().toISOString(),
      data: payload,
    };

    for (const sub of subs) {
      let delivery;
      try {
        delivery = await this.prisma.webhookDelivery.create({
          data: {
            subscriptionId: sub.id,
            orgId,
            eventId,
            eventType,
            payload: fullPayload,
            status: 'pending',
            attempts: 0,
            nextAttemptAt: new Date(),
          },
        });
      } catch (err) {
        console.warn('[webhooks._dispatch] could not persist delivery:', err.message);
        continue;
      }
      // Fire-and-forget. Worker picks up if first attempt fails.
      this._attempt(sub, delivery).catch((err) => {
        console.warn('[webhooks._dispatch] attempt failed:', err.message);
      });
    }
  }

  /**
   * Worker entry. Find pending deliveries and re-attempt them.
   * @param {number} batchSize
   * @returns {Promise<{processed:number, delivered:number, failed:number}>}
   */
  async processPending(batchSize = 50) {
    const due = await this.prisma.webhookDelivery.findMany({
      where: { status: 'pending', nextAttemptAt: { lte: new Date() } },
      orderBy: { nextAttemptAt: 'asc' },
      take: batchSize,
      include: { subscription: true },
    });
    const stats = { processed: due.length, delivered: 0, failed: 0 };
    for (const delivery of due) {
      if (!delivery.subscription || !delivery.subscription.enabled) {
        // Subscription disabled while delivery was pending → mark dead.
        await this.prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: { status: 'dead_lettered', lastError: 'subscription_disabled' },
        });
        stats.failed++;
        continue;
      }
      const ok = await this._attempt(delivery.subscription, delivery);
      if (ok) stats.delivered++; else stats.failed++;
    }
    return stats;
  }

  async _attempt(subscription, delivery) {
    const attemptNum = delivery.attempts + 1;
    const secret = await this._resolveSecret(subscription.id);
    if (!secret) {
      console.warn(
        '[webhooks._attempt] no plain secret available for subscription',
        subscription.id,
        '— marking dead_lettered (rotate secret to recover)',
      );
      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'dead_lettered',
          attempts: attemptNum,
          lastError: 'secret_unavailable',
        },
      });
      return false;
    }

    const body = JSON.stringify(delivery.payload);
    const ts = Math.floor(Date.now() / 1000);
    const signature = signPayload(secret, body, ts);

    let statusCode = 0;
    let errorMessage = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
      const res = await fetch(subscription.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'HiveMind-Webhooks/1',
          'X-HiveMind-Signature': signature,
          'X-HiveMind-Event': delivery.eventType,
          'X-HiveMind-Event-Id': delivery.eventId,
          'X-HiveMind-Delivery': delivery.id,
          'X-HiveMind-Attempts': String(attemptNum),
          'X-HiveMind-Subscription': subscription.id,
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      statusCode = res.status;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        errorMessage = `http_${res.status}:${text.slice(0, 240)}`;
      }
    } catch (err) {
      errorMessage = String(err.message || err).slice(0, 500);
    }

    const success = statusCode >= 200 && statusCode < 300;

    if (success) {
      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'delivered',
          attempts: attemptNum,
          lastStatusCode: statusCode,
          lastError: null,
          deliveredAt: new Date(),
        },
      });
      await this.prisma.webhookSubscription.update({
        where: { id: subscription.id },
        data: { lastSuccessAt: new Date(), consecutiveFailures: 0 },
      }).catch(() => {});
      return true;
    }

    // Failure — schedule retry or dead-letter.
    const isLast = attemptNum >= MAX_ATTEMPTS;
    const nextDelayMin = BACKOFF_MINUTES[Math.min(attemptNum, BACKOFF_MINUTES.length - 1)];
    const nextAt = isLast ? null : nowPlusMinutes(nextDelayMin);
    await this.prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: isLast ? 'dead_lettered' : 'pending',
        attempts: attemptNum,
        lastStatusCode: statusCode || null,
        lastError: errorMessage,
        nextAttemptAt: nextAt || delivery.nextAttemptAt,
      },
    });
    await this.prisma.webhookSubscription.update({
      where: { id: subscription.id },
      data: {
        lastFailureAt: new Date(),
        consecutiveFailures: { increment: 1 },
      },
    }).catch(() => {});

    if (this.audit) {
      this.audit.log({
        orgId: subscription.orgId,
        eventType: 'webhook.delivery_failed',
        resourceType: 'webhook_subscription',
        resourceId: subscription.id,
        newValue: {
          delivery_id: delivery.id,
          event_type: delivery.eventType,
          attempts: attemptNum,
          status_code: statusCode,
          dead_lettered: isLast,
        },
      }).catch(() => {});
    }

    return false;
  }
}
