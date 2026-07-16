/**
 * WebhookProcessor
 *
 * Background worker that polls webhook_events rows in 'received' status,
 * claims them with SELECT FOR UPDATE SKIP LOCKED semantics, processes each
 * through the appropriate provider adapter, and routes results to SmartIngestRouter.
 */

const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 5;
const MIN_INTERVAL_MS = 5000;
const MAX_INTERVAL_MS = 60000;

export class WebhookProcessor {
  /**
   * @param {Object} deps
   * @param {import('@prisma/client').PrismaClient} deps.prisma
   * @param {import('./adapter-registry.js').AdapterRegistry} deps.adapterRegistry
   * @param {Function} deps.tokenResolver - async (userId, orgId, provider) => token
   * @param {Object} deps.smartIngestRouter
   * @param {Object} deps.logger
   * @param {number} [deps.intervalMs]
   */
  constructor({ prisma, adapterRegistry, tokenResolver, smartIngestRouter, documentFirstIngestion, getDocumentFirstIngestion, logger, intervalMs = MIN_INTERVAL_MS }) {
    this.prisma = prisma;
    this.adapterRegistry = adapterRegistry;
    this.tokenResolver = tokenResolver;
    this.smartIngestRouter = smartIngestRouter;
    // Accept either an eager instance or a getter for late binding
    this._dfiGetter = typeof getDocumentFirstIngestion === 'function'
      ? getDocumentFirstIngestion
      : () => documentFirstIngestion;
    this.logger = logger;
    this._baseIntervalMs = intervalMs;
    this._currentIntervalMs = intervalMs;
    this._timer = null;
    this._consecutiveEmptyTicks = 0;
  }

  /** Begin polling loop. Idempotent. */
  start() {
    if (this._timer !== null) return;
    const tick = async () => {
      await this.tickOnce();
      this._timer = setTimeout(tick, this._currentIntervalMs);
    };
    this._timer = setTimeout(tick, 0);
  }

  /** Stop polling loop. */
  stop() {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /**
   * Process one batch of pending webhook events.
   * @returns {Promise<number>} Count of events processed in this tick.
   */
  async tickOnce() {
    let processed = 0;
    try {
      const rows = await this.prisma.$queryRaw`
        UPDATE inbound_webhook_events
        SET status = 'processing', attempts = attempts + 1
        WHERE id IN (
          SELECT id FROM inbound_webhook_events
          WHERE status IN ('received', 'failed')
            AND subscription_id IS NOT NULL
            AND attempts < ${MAX_ATTEMPTS}
          ORDER BY received_at ASC
          LIMIT ${BATCH_SIZE}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      `;

      for (const row of rows) {
        await this._processRow(row);
        processed++;
      }
    } catch (err) {
      this.logger.error({ err }, 'webhook-processor: tick failed');
    }

    // Adaptive backoff when idle
    if (processed === 0) {
      this._consecutiveEmptyTicks++;
      if (this._consecutiveEmptyTicks >= 2) {
        this._currentIntervalMs = Math.min(this._currentIntervalMs * 2, MAX_INTERVAL_MS);
      }
    } else {
      this._consecutiveEmptyTicks = 0;
      this._currentIntervalMs = this._baseIntervalMs;
    }

    return processed;
  }

  /** @param {Object} row - raw webhook_events row */
  async _processRow(row) {
    try {
      const subscriptionId = row.subscriptionId ?? row.subscription_id ?? null;
      const eventId = row.id;

      if (!subscriptionId) {
        throw new Error(`event missing subscription_id: ${row.id}`);
      }

      const sub = await this.prisma.inboundWebhookSubscription.findUnique({ where: { id: subscriptionId } });
      if (!sub) throw new Error(`subscription not found: ${subscriptionId}`);

      const adapter = this.adapterRegistry.instantiate(sub.providerKey, {
        providerKey: sub.providerKey,
        tokenResolver: this.tokenResolver,
        prisma: this.prisma,
        logger: this.logger,
      });
      const { resourceId, type } = await adapter.parseEvent(row.payload);
      const resource = await adapter.fetchResource({
        userId: sub.userId,
        orgId: sub.orgId,
        resourceId,
        type,
      });

      if (resource) {
        // Evidence-first path (P1 #13): wrap resource as connector record so it
        // lands in source_artifacts + knowledge_documents + knowledge_segments
        // and produces memory_evidence_links. Falls back to legacy router if
        // documentFirstIngestion not wired (back-compat).
        const dfi = this._dfiGetter?.();
        if (dfi && resource?.content) {
          // Canonical front door: every connector record normalizes into the
          // same IngestEnvelope. source.provider highlights WHICH connector
          // (platform → connector:<provider>); occurredAt carries the real
          // event timestamp. Routes to the same _promoteMemories pipeline.
          await dfi.ingestSource({
            userId: sub.userId,
            orgId: sub.orgId,
            content: resource.content,
            source: {
              type: 'connector',
              provider: sub.providerKey,
              sourceId: resource.id || resource.resourceId || `${sub.providerKey}-${Date.now()}`,
              url: resource.sourceUrl || resource.url || null,
              title: resource.title || resource.subject || null,
            },
            occurredAt: resource.timestamp ? new Date(resource.timestamp) : null,
            metadata: { ...(resource.metadata || {}), webhookEventId: eventId, eventType: type },
          });
        } else if (this.smartIngestRouter) {
          await this.smartIngestRouter.route({ userId: sub.userId, orgId: sub.orgId, resource, type });
        }
      }

      await this.prisma.inboundWebhookEvent.update({
        where: { id: eventId },
        data: { status: 'processed', processedAt: new Date() },
      });

      await this.prisma.inboundWebhookSubscription.update({
        where: { id: sub.id },
        data: { lastEventAt: new Date(), consecutiveFailures: 0 },
      });
    } catch (err) {
      this.logger.warn({ err, eventId: row.id }, 'webhook-processor: event failed');
      const isDead = row.attempts >= MAX_ATTEMPTS;
      await this.prisma.inboundWebhookEvent.update({
        where: { id: row.id },
        data: {
          status: isDead ? 'dead_lettered' : 'failed',
          error: err.message,
        },
      });

      try {
        await this.prisma.inboundWebhookSubscription.update({
          where: { id: row.subscriptionId },
          data: { consecutiveFailures: { increment: 1 } },
        });
      } catch (_) {
        // subscription may not exist; already logged above
      }
    }
  }
}
