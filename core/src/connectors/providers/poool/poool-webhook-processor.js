/**
 * Poool Webhook Processor
 *
 * Receives real-time events from Poool webhooks:
 * - payment.late
 * - payment.created
 * - ticket.created
 * - property.updated
 * - tenant.updated
 *
 * Routes events to appropriate handlers and emits to HIVEMIND memory.
 */

import { ChurnSignalEnricher } from './churn-signal-enricher.js';

export class PooolWebhookProcessor {
  constructor(ctx) {
    this.prisma = ctx.prisma;
    this.logger = ctx.logger;
    this.enricher = new ChurnSignalEnricher(ctx);
  }

  /**
   * Process a Poool webhook event.
   * Expected payload shape:
   * {
   *   eventType: string,
   *   data: Object,
   *   timestamp: ISO8601,
   *   signature: string (HMAC-SHA256 if secret is configured)
   * }
   */
  async process(payload, secret = null) {
    if (!payload?.eventType) {
      throw new Error('poool-webhook: missing eventType');
    }

    // Verify signature if secret provided
    if (secret && !this._verifySignature(payload, secret)) {
      throw new Error('poool-webhook: invalid signature');
    }

    const { eventType, data } = payload;

    switch (eventType) {
      case 'payment.late':
        return this._handlePaymentLate(data);
      case 'payment.created':
        return this._handlePaymentCreated(data);
      case 'ticket.created':
        return this._handleTicketCreated(data);
      case 'property.updated':
        return this._handlePropertyUpdated(data);
      case 'tenant.updated':
        return this._handleTenantUpdated(data);
      default:
        this.logger?.warn(`poool-webhook: unknown event type "${eventType}"`);
        return { processed: false, reason: 'unknown event type' };
    }
  }

  /**
   * Handle payment.late event.
   * Triggers immediate churn signal with high severity.
   */
  async _handlePaymentLate(data) {
    const {
      leaseId,
      propertyId,
      tenantId,
      paymentId,
      amount,
      daysLate,
      dueDate,
      orgId,
      userId,
    } = data;

    const churnSignal = {
      id: `poool_churn_event:payment_late:${paymentId}:${Date.now()}`,
      type: 'churn_signal',
      source: 'poool',
      eventType: 'payment.late',
      severity: 'high',
      leaseId,
      propertyId,
      tenantId,
      orgId,
      userId,
      riskScore: 60, // High risk: late payment is strong signal
      factors: [
        `Late payment: ${amount} due on ${dueDate}, now ${daysLate} days overdue`,
      ],
      signals: {
        latePayment: true,
        complaints: false,
        silence: false,
      },
      metadata: {
        paymentId,
        amount,
        daysLate,
        dueDate,
      },
      timestamp: new Date().toISOString(),
      recommendedAction:
        'URGENT: Contact tenant immediately regarding overdue payment.',
    };

    // Emit to HIVEMIND memory
    await this._emitMemory(churnSignal, orgId, userId);

    return {
      processed: true,
      record: churnSignal,
      emitted: true,
    };
  }

  /**
   * Handle payment.created event.
   * Track successful payments (may offset churn risk).
   */
  async _handlePaymentCreated(data) {
    const { leaseId, paymentId, amount, dueDate, orgId, userId } = data;

    const record = {
      id: `poool_event:payment:${paymentId}`,
      type: 'event',
      source: 'poool',
      eventType: 'payment.created',
      leaseId,
      orgId,
      userId,
      metadata: {
        paymentId,
        amount,
        dueDate,
      },
      timestamp: new Date().toISOString(),
    };

    // Emit to HIVEMIND memory as informational event
    await this._emitMemory(record, orgId, userId);

    return {
      processed: true,
      record,
      emitted: true,
    };
  }

  /**
   * Handle ticket.created event.
   * Tracks tenant complaints as churn factor.
   */
  async _handleTicketCreated(data) {
    const {
      ticketId,
      propertyId,
      tenantId,
      subject,
      description,
      category,
      sentiment,
      orgId,
      userId,
    } = data;

    // Escalate if negative sentiment
    const shouldEscalate = sentiment === 'negative';

    const record = {
      id: `poool_event:ticket:${ticketId}`,
      type: 'event',
      source: 'poool',
      eventType: 'ticket.created',
      severity: shouldEscalate ? 'high' : 'medium',
      propertyId,
      tenantId,
      orgId,
      userId,
      metadata: {
        ticketId,
        subject,
        category,
        sentiment,
      },
      timestamp: new Date().toISOString(),
    };

    // If negative sentiment, also emit as churn risk signal
    if (shouldEscalate) {
      const churnSignal = {
        ...record,
        id: `poool_churn_event:complaint:${ticketId}:${Date.now()}`,
        type: 'churn_signal',
        severity: 'medium',
        riskScore: 40,
        factors: [`Tenant complaint: ${subject} (${sentiment} sentiment)`],
        signals: {
          latePayment: false,
          complaints: true,
          silence: false,
        },
        recommendedAction: `Follow up on tenant complaint: ${subject}`,
      };

      await this._emitMemory(churnSignal, orgId, userId);
    }

    await this._emitMemory(record, orgId, userId);

    return {
      processed: true,
      record,
      emitted: true,
      churnSignalEmitted: shouldEscalate,
    };
  }

  /**
   * Handle property.updated event.
   * Informational; may trigger re-enrichment of all associated leases.
   */
  async _handlePropertyUpdated(data) {
    const { propertyId, orgId, userId, status, name } = data;

    const record = {
      id: `poool_event:property:${propertyId}`,
      type: 'event',
      source: 'poool',
      eventType: 'property.updated',
      propertyId,
      orgId,
      userId,
      metadata: {
        status,
        name,
      },
      timestamp: new Date().toISOString(),
    };

    await this._emitMemory(record, orgId, userId);

    return {
      processed: true,
      record,
      emitted: true,
    };
  }

  /**
   * Handle tenant.updated event.
   * Informational; may signal contact info changes.
   */
  async _handleTenantUpdated(data) {
    const { tenantId, orgId, userId, name, email, phone } = data;

    const record = {
      id: `poool_event:tenant:${tenantId}`,
      type: 'event',
      source: 'poool',
      eventType: 'tenant.updated',
      tenantId,
      orgId,
      userId,
      metadata: {
        name,
        email,
        phone,
      },
      timestamp: new Date().toISOString(),
    };

    await this._emitMemory(record, orgId, userId);

    return {
      processed: true,
      record,
      emitted: true,
    };
  }

  /**
   * Emit record to HIVEMIND memory for persistent ingestion.
   * @private
   */
  async _emitMemory(record, orgId, userId) {
    try {
      // Query the HIVEMIND API or local memory store
      // This is a placeholder for actual memory ingestion
      this.logger?.debug('poool-webhook: emitting to memory', {
        id: record.id,
        type: record.type,
        orgId,
      });

      // In production, this would call the HIVEMIND ingest API:
      // await fetch(`${HIVEMIND_BASE_URL}/memory/ingest`, {
      //   method: 'POST',
      //   headers: { 'Content-Type': 'application/json' },
      //   body: JSON.stringify({
      //     title: record.type,
      //     content: JSON.stringify(record, null, 2),
      //     tags: [`poool`, `org:${orgId}`, `user:${userId}`, record.eventType],
      //     source_type: 'webhook',
      //   }),
      // });
    } catch (err) {
      this.logger?.error('poool-webhook: failed to emit memory', {
        error: err.message,
        recordId: record.id,
      });
      throw err;
    }
  }

  /**
   * Verify HMAC-SHA256 signature.
   * @private
   */
  _verifySignature(payload, secret) {
    const { signature, ...data } = payload;

    // Implementation: compute HMAC-SHA256 of payload body
    // Compare against provided signature
    // (Stub implementation; replace with actual crypto)
    this.logger?.debug('poool-webhook: signature verification (stub)');
    return true;
  }
}
