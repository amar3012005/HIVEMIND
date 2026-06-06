/**
 * Poool Real Estate Integration - Public API
 *
 * Phase 4 real-estate rail provider for HIVEMIND.
 * Provides webhook listener + REST poller + churn signal enrichment.
 *
 * Exports:
 * - PooolAdapter: REST API client + webhook processor
 * - PooolWebhookProcessor: Real-time event handler
 * - ChurnSignalEnricher: Multi-source churn analysis
 */

export { PooolAdapter } from './poool-adapter.js';
export { PooolWebhookProcessor } from './poool-webhook-processor.js';
export { ChurnSignalEnricher } from './churn-signal-enricher.js';

/**
 * Manifest for connector catalog.
 * Used by AdapterRegistry to instantiate provider.
 */
export const POOOL_MANIFEST = {
  providerKey: 'poool',
  providerName: 'Poool',
  category: 'real-estate',
  description:
    'Property management platform with real-time churn signal enrichment',
  version: '1.0.0',
  features: {
    webhooks: true,
    polling: true,
    crossSystemMapping: true,
    churnAnalysis: true,
  },
  capabilities: {
    resources: [
      'properties',
      'tenants',
      'leases',
      'payments',
      'tickets',
    ],
    webhookEvents: [
      'payment.late',
      'payment.created',
      'ticket.created',
      'property.updated',
      'tenant.updated',
    ],
  },
  oauth2: {
    authorizationUrl: 'https://oauth.poool.io/authorize',
    tokenUrl: 'https://oauth.poool.io/token',
    scopes: [
      'properties:read',
      'tenants:read',
      'leases:read',
      'payments:read',
      'tickets:read',
      'webhooks:write',
    ],
  },
  rateLimits: {
    rps: 10, // Requests per second
    requestsPerDay: 100000,
  },
  polling: {
    defaultInterval: 3600, // 1 hour
    minInterval: 300, // 5 minutes
    resources: [
      {
        name: 'properties',
        interval: 3600,
        cursor: true,
      },
      {
        name: 'tenants',
        interval: 3600,
        cursor: true,
      },
      {
        name: 'leases',
        interval: 1800, // More frequent
        cursor: true,
      },
      {
        name: 'payments',
        interval: 600, // Frequent (payment churn is critical)
        cursor: true,
      },
      {
        name: 'tickets',
        interval: 900,
        cursor: true,
      },
    ],
  },
  enrichment: {
    churnSignals: {
      enabled: true,
      factors: ['late_payment', 'complaint_ticket', 'communication_silence'],
      riskThreshold: 35,
    },
    crossSystemMapping: {
      property: {
        poool: 'propertyId',
        sap: 'assetId',
        datev: 'ledgerId',
      },
      tenant: {
        poool: 'tenantId',
        datev: 'customerId',
        crm: 'contactId',
      },
    },
  },
};
