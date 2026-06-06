/**
 * Poool Real Estate Management Adapter
 *
 * Supports:
 * - Webhook consumption (churn events, property updates, tenant changes)
 * - REST polling (properties, tenants, leases, payments, tickets)
 * - Cross-system ID mapping (SAP asset, DATEV ledger, CRM)
 * - Churn signal enrichment (late payments + support tickets + silence)
 *
 * Implements BaseConnectorAdapter pattern with webhook-first strategy.
 */

export class PooolAdapter {
  constructor(ctx) {
    this.providerKey = 'poool';
    this.prisma = ctx.prisma;
    this.logger = ctx.logger;
    this._tokenResolver = ctx.tokenResolver;
    this.supportsWebhooks = true;

    // Poool API base (default; can be overridden via config)
    this.baseUrl = process.env.POOOL_API_BASE_URL || 'https://api.poool.io';
  }

  /**
   * Resolve bearer token for Poool API.
   * Delegates to tokenResolver (Nango or custom auth service).
   */
  async getBearer({ userId, orgId }) {
    if (typeof this._tokenResolver !== 'function') {
      throw new Error('poool: tokenResolver not injected');
    }
    return this._tokenResolver({ userId, orgId, providerKey: this.providerKey });
  }

  /**
   * Poll properties from Poool.
   * Returns normalized property records with cross_system_ids placeholder.
   *
   * @param {{ userId: string, orgId: string, cursor: string|null, limit?: number }} params
   * @returns {Promise<{ records: Object[], nextCursor: string|null }>}
   */
  async fetchProperties({ userId, orgId, cursor = null, limit = 100 }) {
    const bearer = await this.getBearer({ userId, orgId });

    const url = new URL(`${this.baseUrl}/v1/properties`);
    if (cursor) url.searchParams.set('cursor', cursor);
    url.searchParams.set('limit', limit);

    try {
      const resp = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${bearer}` },
      });

      if (!resp.ok) {
        throw new Error(`Poool API: ${resp.status} ${resp.statusText}`);
      }

      const data = await resp.json();
      const records = (data.data || []).map((prop) => ({
        id: `poool_property:${prop.id}`,
        externalId: prop.id,
        title: prop.name || `Property ${prop.id}`,
        body: JSON.stringify(prop),
        ts: new Date(prop.updatedAt || prop.createdAt).toISOString(),
        type: 'property',
        refs: {
          pooolId: prop.id,
          address: prop.address,
          tenantCount: prop.tenants?.length || 0,
          cross_system_ids: {
            // Placeholder: filled by enrichment
            sapAsset: null,
            datevLedger: null,
          },
        },
      }));

      return {
        records,
        nextCursor: data.pagination?.nextCursor || null,
      };
    } catch (err) {
      this.logger?.error('Poool fetchProperties failed', { error: err.message });
      throw err;
    }
  }

  /**
   * Poll tenants from Poool.
   * Returns normalized tenant records with cross_system cross_references.
   */
  async fetchTenants({ userId, orgId, cursor = null, limit = 100 }) {
    const bearer = await this.getBearer({ userId, orgId });

    const url = new URL(`${this.baseUrl}/v1/tenants`);
    if (cursor) url.searchParams.set('cursor', cursor);
    url.searchParams.set('limit', limit);

    try {
      const resp = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${bearer}` },
      });

      if (!resp.ok) {
        throw new Error(`Poool API: ${resp.status} ${resp.statusText}`);
      }

      const data = await resp.json();
      const records = (data.data || []).map((tenant) => ({
        id: `poool_tenant:${tenant.id}`,
        externalId: tenant.id,
        title: tenant.name || `Tenant ${tenant.id}`,
        body: JSON.stringify(tenant),
        ts: new Date(tenant.updatedAt || tenant.createdAt).toISOString(),
        type: 'tenant',
        refs: {
          pooolId: tenant.id,
          email: tenant.email,
          phone: tenant.phone,
          cross_system_ids: {
            datevId: null, // Filled by enrichment
          },
        },
      }));

      return {
        records,
        nextCursor: data.pagination?.nextCursor || null,
      };
    } catch (err) {
      this.logger?.error('Poool fetchTenants failed', { error: err.message });
      throw err;
    }
  }

  /**
   * Poll leases from Poool.
   */
  async fetchLeases({ userId, orgId, cursor = null, limit = 100 }) {
    const bearer = await this.getBearer({ userId, orgId });

    const url = new URL(`${this.baseUrl}/v1/leases`);
    if (cursor) url.searchParams.set('cursor', cursor);
    url.searchParams.set('limit', limit);

    try {
      const resp = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${bearer}` },
      });

      if (!resp.ok) {
        throw new Error(`Poool API: ${resp.status} ${resp.statusText}`);
      }

      const data = await resp.json();
      const records = (data.data || []).map((lease) => ({
        id: `poool_lease:${lease.id}`,
        externalId: lease.id,
        title: `Lease ${lease.propertyId}:${lease.tenantId}`,
        body: JSON.stringify(lease),
        ts: new Date(lease.updatedAt || lease.createdAt).toISOString(),
        type: 'lease',
        refs: {
          pooolId: lease.id,
          propertyId: lease.propertyId,
          tenantId: lease.tenantId,
          startDate: lease.startDate,
          endDate: lease.endDate,
          rentAmount: lease.rentAmount,
        },
      }));

      return {
        records,
        nextCursor: data.pagination?.nextCursor || null,
      };
    } catch (err) {
      this.logger?.error('Poool fetchLeases failed', { error: err.message });
      throw err;
    }
  }

  /**
   * Poll payments from Poool (intersection with SAP FI).
   */
  async fetchPayments({ userId, orgId, cursor = null, limit = 100 }) {
    const bearer = await this.getBearer({ userId, orgId });

    const url = new URL(`${this.baseUrl}/v1/payments`);
    if (cursor) url.searchParams.set('cursor', cursor);
    url.searchParams.set('limit', limit);

    try {
      const resp = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${bearer}` },
      });

      if (!resp.ok) {
        throw new Error(`Poool API: ${resp.status} ${resp.statusText}`);
      }

      const data = await resp.json();
      const records = (data.data || []).map((payment) => ({
        id: `poool_payment:${payment.id}`,
        externalId: payment.id,
        title: `Payment ${payment.leaseId} - ${payment.amount}`,
        body: JSON.stringify(payment),
        ts: new Date(payment.dueDate || payment.createdAt).toISOString(),
        type: 'payment',
        refs: {
          pooolId: payment.id,
          leaseId: payment.leaseId,
          tenantId: payment.tenantId,
          amount: payment.amount,
          dueDate: payment.dueDate,
          paidDate: payment.paidDate,
          status: payment.status,
          isLate: payment.paidDate && new Date(payment.paidDate) > new Date(payment.dueDate),
        },
      }));

      return {
        records,
        nextCursor: data.pagination?.nextCursor || null,
      };
    } catch (err) {
      this.logger?.error('Poool fetchPayments failed', { error: err.message });
      throw err;
    }
  }

  /**
   * Poll support tickets from Poool (intersection with CRM).
   */
  async fetchTickets({ userId, orgId, cursor = null, limit = 100 }) {
    const bearer = await this.getBearer({ userId, orgId });

    const url = new URL(`${this.baseUrl}/v1/tickets`);
    if (cursor) url.searchParams.set('cursor', cursor);
    url.searchParams.set('limit', limit);

    try {
      const resp = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${bearer}` },
      });

      if (!resp.ok) {
        throw new Error(`Poool API: ${resp.status} ${resp.statusText}`);
      }

      const data = await resp.json();
      const records = (data.data || []).map((ticket) => ({
        id: `poool_ticket:${ticket.id}`,
        externalId: ticket.id,
        title: ticket.subject || `Ticket ${ticket.id}`,
        body: ticket.description || '',
        ts: new Date(ticket.updatedAt || ticket.createdAt).toISOString(),
        type: 'ticket',
        refs: {
          pooolId: ticket.id,
          propertyId: ticket.propertyId,
          tenantId: ticket.tenantId,
          category: ticket.category,
          status: ticket.status,
          priority: ticket.priority,
          sentiment: ticket.sentiment, // 'positive', 'neutral', 'negative'
        },
      }));

      return {
        records,
        nextCursor: data.pagination?.nextCursor || null,
      };
    } catch (err) {
      this.logger?.error('Poool fetchTickets failed', { error: err.message });
      throw err;
    }
  }

  /**
   * Generic fetchBulk for SyncEngine compatibility.
   * Routes to resource-specific methods based on scope.
   */
  async fetchBulk({ userId, orgId, cursor = null, scope = {}, limit = 100 }) {
    const resourceType = scope.resourceType || 'properties';

    switch (resourceType) {
      case 'properties':
        return this.fetchProperties({ userId, orgId, cursor, limit });
      case 'tenants':
        return this.fetchTenants({ userId, orgId, cursor, limit });
      case 'leases':
        return this.fetchLeases({ userId, orgId, cursor, limit });
      case 'payments':
        return this.fetchPayments({ userId, orgId, cursor, limit });
      case 'tickets':
        return this.fetchTickets({ userId, orgId, cursor, limit });
      default:
        throw new Error(`Poool: unknown resource type "${resourceType}"`);
    }
  }

  /**
   * Process webhook event from Poool.
   * Expected payload shape:
   * { eventType: 'payment.late' | 'property.updated' | ..., data: {...} }
   */
  async processWebhook(payload) {
    if (!payload || !payload.eventType) {
      throw new Error('Poool webhook: missing eventType');
    }

    // Route to specific handler
    switch (payload.eventType) {
      case 'payment.late':
        return this._handlePaymentLate(payload.data);
      case 'payment.created':
        return this._handlePaymentCreated(payload.data);
      case 'ticket.created':
        return this._handleTicketCreated(payload.data);
      case 'property.updated':
        return this._handlePropertyUpdated(payload.data);
      case 'tenant.updated':
        return this._handleTenantUpdated(payload.data);
      default:
        this.logger?.warn(`Poool webhook: unknown event type "${payload.eventType}"`);
        return { processed: false, reason: 'unknown event type' };
    }
  }

  _handlePaymentLate(data) {
    return {
      processed: true,
      record: {
        id: `poool_churn_event:payment_late:${data.leaseId}:${Date.now()}`,
        type: 'churn_signal',
        severity: 'high',
        reason: 'late_payment',
        propertyId: data.propertyId,
        tenantId: data.tenantId,
        leaseId: data.leaseId,
        paymentId: data.paymentId,
        amount: data.amount,
        daysLate: data.daysLate,
        ts: new Date().toISOString(),
      },
    };
  }

  _handlePaymentCreated(data) {
    return {
      processed: true,
      record: {
        id: `poool_event:payment:${data.id}`,
        type: 'event',
        eventType: 'payment.created',
        leaseId: data.leaseId,
        amount: data.amount,
        ts: new Date().toISOString(),
      },
    };
  }

  _handleTicketCreated(data) {
    return {
      processed: true,
      record: {
        id: `poool_event:ticket:${data.id}`,
        type: 'event',
        eventType: 'ticket.created',
        propertyId: data.propertyId,
        tenantId: data.tenantId,
        sentiment: data.sentiment,
        ts: new Date().toISOString(),
      },
    };
  }

  _handlePropertyUpdated(data) {
    return {
      processed: true,
      record: {
        id: `poool_event:property:${data.id}`,
        type: 'event',
        eventType: 'property.updated',
        propertyId: data.id,
        ts: new Date().toISOString(),
      },
    };
  }

  _handleTenantUpdated(data) {
    return {
      processed: true,
      record: {
        id: `poool_event:tenant:${data.id}`,
        type: 'event',
        eventType: 'tenant.updated',
        tenantId: data.id,
        ts: new Date().toISOString(),
      },
    };
  }
}
