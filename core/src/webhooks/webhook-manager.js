/**
 * WebhookManager - Event webhook system for HIVEMIND
 *
 * Supported events:
 *   memory.created, memory.updated, memory.deleted
 *   csi.run_complete, ingest.job_complete, profile.updated
 *
 * Webhooks are stored in-memory (Map) + persisted to MetaParameter
 * using the key `webhook_config:{orgId}`.
 *
 * Each webhook object: { id, userId, orgId, url, events, secret, active, createdAt }
 * Plan gate: Scale / Enterprise only (enforced by callers in server.js).
 */

import { createHmac, randomUUID } from 'node:crypto';

const MAX_WEBHOOKS_PER_ORG = 10;
const DISPATCH_TIMEOUT_MS = 5000;
const MAX_RETRIES = 2;

const SUPPORTED_EVENTS = new Set([
  'memory.created',
  'memory.updated',
  'memory.deleted',
  'csi.run_complete',
  'ingest.job_complete',
  'profile.updated',
]);

export class WebhookManager {
  constructor(prisma) {
    this.prisma = prisma;
    /** @type {Map<string, object[]>} orgId -> webhook[] */
    this._store = new Map();
  }

  // ── Persistence helpers ──────────────────────────────────────────────────────

  _metaKey(orgId) {
    return `webhook_config:${orgId}`;
  }

  async _persist(orgId, webhooks) {
    try {
      await this.prisma.metaParameter.upsert({
        where: { key: this._metaKey(orgId) },
        update: {
          value: webhooks,
          updated_by: 'webhook-manager',
        },
        create: {
          key: this._metaKey(orgId),
          value: webhooks,
          updated_by: 'webhook-manager',
        },
      });
    } catch (err) {
      console.warn('[webhooks] Failed to persist webhook config:', err.message);
    }
  }

  /**
   * Load webhooks for an org from MetaParameter into in-memory store.
   * Called lazily on first access per org.
   */
  async loadFromDb(orgId) {
    if (this._store.has(orgId)) return;
    try {
      const row = await this.prisma.metaParameter.findUnique({
        where: { key: this._metaKey(orgId) },
      });
      const webhooks = Array.isArray(row?.value) ? row.value : [];
      this._store.set(orgId, webhooks);
    } catch (err) {
      console.warn('[webhooks] Failed to load webhook config:', err.message);
      this._store.set(orgId, []);
    }
  }

  async _getOrgWebhooks(orgId) {
    if (!this._store.has(orgId)) {
      await this.loadFromDb(orgId);
    }
    return this._store.get(orgId) ?? [];
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Create a new webhook subscription.
   * @param {object} opts
   * @param {string} opts.orgId
   * @param {string} opts.userId
   * @param {string} opts.url        - HTTPS URL to POST events to
   * @param {string[]} opts.events   - subset of SUPPORTED_EVENTS, or ['*'] for all
   * @param {string} [opts.secret]   - optional caller-supplied secret; generated if omitted
   * @returns {Promise<object>}      - created webhook (includes secret, shown once)
   */
  async create({ orgId, userId, url, events, secret }) {
    // Validate URL
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('Invalid webhook URL');
    }
    if (parsed.protocol !== 'https:') {
      throw new Error('Webhook URL must use HTTPS');
    }

    // Validate events
    const eventsArray = Array.isArray(events) ? events : [events];
    if (!eventsArray.length) throw new Error('At least one event type is required');
    for (const ev of eventsArray) {
      if (ev !== '*' && !SUPPORTED_EVENTS.has(ev)) {
        throw new Error(`Unsupported event type: ${ev}. Supported: ${[...SUPPORTED_EVENTS].join(', ')}, *`);
      }
    }

    const existing = await this._getOrgWebhooks(orgId);

    // Enforce per-org cap
    const active = existing.filter(w => w.active);
    if (active.length >= MAX_WEBHOOKS_PER_ORG) {
      throw new Error(`Maximum of ${MAX_WEBHOOKS_PER_ORG} active webhooks per organisation`);
    }

    const webhook = {
      id: randomUUID(),
      userId,
      orgId,
      url,
      events: eventsArray,
      secret: secret || randomUUID().replace(/-/g, ''),
      active: true,
      createdAt: new Date().toISOString(),
    };

    const updated = [...existing, webhook];
    this._store.set(orgId, updated);
    await this._persist(orgId, updated);

    return webhook;
  }

  /**
   * List active webhooks for an org.
   * Secrets are redacted in the list response.
   */
  async list(orgId) {
    const webhooks = await this._getOrgWebhooks(orgId);
    return webhooks
      .filter(w => w.active)
      .map(({ secret: _s, ...rest }) => ({ ...rest, secret: '***' }));
  }

  /**
   * Delete (deactivate) a webhook by id.
   */
  async delete(webhookId, orgId) {
    const existing = await this._getOrgWebhooks(orgId);
    const idx = existing.findIndex(w => w.id === webhookId);
    if (idx === -1) throw new Error('Webhook not found');

    const updated = existing.map((w, i) =>
      i === idx ? { ...w, active: false } : w
    );
    this._store.set(orgId, updated);
    await this._persist(orgId, updated);
    return { success: true };
  }

  /**
   * Dispatch an event to all matching active webhooks for an org.
   * Fire-and-forget: always returns immediately.
   *
   * @param {string} event   - e.g. 'memory.created'
   * @param {object} data    - event payload
   * @param {object} context - { userId, orgId }
   */
  async dispatch(event, data, { userId, orgId }) {
    let webhooks;
    try {
      webhooks = await this._getOrgWebhooks(orgId);
    } catch {
      return;
    }

    const matching = webhooks.filter(
      w => w.active && (w.events.includes('*') || w.events.includes(event))
    );

    if (!matching.length) return;

    const body = JSON.stringify({
      event,
      data,
      meta: {
        userId,
        orgId,
        sentAt: new Date().toISOString(),
      },
    });

    for (const webhook of matching) {
      this._sendWithRetry(webhook, body).catch(() => {});
    }
  }

  // ── Internal helpers ─────────────────────────────────────────────────────────

  _sign(payload, secret) {
    return createHmac('sha256', secret).update(payload).digest('hex');
  }

  async _sendWithRetry(webhook, body, attempt = 0) {
    const sig = this._sign(body, webhook.secret);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);

    try {
      const res = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-HIVEMIND-Signature': `sha256=${sig}`,
          'X-HIVEMIND-Event': body ? JSON.parse(body).event : 'unknown',
          'User-Agent': 'HIVEMIND-Webhooks/1.0',
        },
        body,
        signal: controller.signal,
      });

      if (!res.ok && attempt < MAX_RETRIES) {
        console.warn(`[webhooks] Delivery failed (status ${res.status}) for ${webhook.url}, retry ${attempt + 1}`);
        return this._sendWithRetry(webhook, body, attempt + 1);
      }

      if (!res.ok) {
        console.warn(`[webhooks] Delivery permanently failed for ${webhook.url} after ${attempt + 1} attempts (status ${res.status})`);
      }
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        console.warn(`[webhooks] Delivery error for ${webhook.url}, retry ${attempt + 1}:`, err.message);
        return this._sendWithRetry(webhook, body, attempt + 1);
      }
      console.warn(`[webhooks] Delivery permanently failed for ${webhook.url}:`, err.message);
    } finally {
      clearTimeout(timer);
    }
  }
}
