/**
 * Poool Integration Tests
 *
 * Test harness for Phase 4 real-estate rail:
 * 1. Webhook listener (payment.late → churn signal)
 * 2. REST poller (properties, tenants, leases, payments, tickets)
 * 3. Churn signal enrichment (multi-source join)
 * 4. Cross-system ID mapping
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PooolAdapter } from '../../src/connectors/providers/poool/poool-adapter.js';
import { PooolWebhookProcessor } from '../../src/connectors/providers/poool/poool-webhook-processor.js';
import { ChurnSignalEnricher } from '../../src/connectors/providers/poool/churn-signal-enricher.js';

// Mock token resolver
const mockTokenResolver = async ({ userId, orgId, providerKey }) => {
  if (providerKey !== 'poool') throw new Error('Invalid provider');
  return `mock_token_${userId}_${orgId}`;
};

// Mock logger
const mockLogger = {
  debug: (...args) => console.debug('[DEBUG]', ...args),
  info: (...args) => console.info('[INFO]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
};

describe('Phase 4: Poool Real-Estate Rail', () => {
  let adapter;
  let processor;
  let enricher;

  beforeEach(() => {
    adapter = new PooolAdapter({
      tokenResolver: mockTokenResolver,
      logger: mockLogger,
      prisma: {}, // Stub
    });

    processor = new PooolWebhookProcessor({
      tokenResolver: mockTokenResolver,
      logger: mockLogger,
      prisma: {}, // Stub
    });

    enricher = new ChurnSignalEnricher({
      tokenResolver: mockTokenResolver,
      logger: mockLogger,
      prisma: {}, // Stub
    });
  });

  describe('Poool Adapter', () => {
    it('should instantiate with correct provider key', () => {
      expect(adapter.providerKey).toBe('poool');
      expect(adapter.supportsWebhooks).toBe(true);
    });

    it('should resolve bearer token', async () => {
      const token = await adapter.getBearer({
        userId: 'user123',
        orgId: 'org456',
      });
      expect(token).toBe('mock_token_user123_org456');
    });

    it('should process webhook event (payment.late)', async () => {
      const payload = {
        eventType: 'payment.late',
        data: {
          leaseId: 'lease123',
          propertyId: 'prop456',
          tenantId: 'tenant789',
          paymentId: 'pay001',
          amount: 1500,
          daysLate: 5,
        },
      };

      const result = await adapter.processWebhook(payload);

      expect(result.processed).toBe(true);
      expect(result.record.type).toBe('churn_signal');
      expect(result.record.severity).toBe('high');
      expect(result.record.reason).toBe('late_payment');
      expect(result.record.daysLate).toBe(5);
    });

    it('should handle unknown webhook event gracefully', async () => {
      const payload = {
        eventType: 'unknown.event',
        data: {},
      };

      const result = await adapter.processWebhook(payload);

      expect(result.processed).toBe(false);
      expect(result.reason).toBe('unknown event type');
    });

    it('should validate webhook payload structure', async () => {
      const invalidPayload = {
        data: { test: true },
        // Missing eventType
      };

      expect(() => adapter.processWebhook(invalidPayload)).toThrow(
        'missing eventType'
      );
    });
  });

  describe('Webhook Processor', () => {
    it('should process payment.late webhook', async () => {
      const payload = {
        eventType: 'payment.late',
        data: {
          leaseId: 'lease123',
          propertyId: 'prop456',
          tenantId: 'tenant789',
          paymentId: 'pay001',
          amount: 1500,
          daysLate: 5,
          dueDate: '2026-05-01',
          orgId: 'org456',
          userId: 'user123',
        },
      };

      const result = await processor.process(payload);

      expect(result.processed).toBe(true);
      expect(result.emitted).toBe(true);
      expect(result.record.type).toBe('churn_signal');
      expect(result.record.severity).toBe('high');
      expect(result.record.riskScore).toBe(60);
      expect(result.record.signals.latePayment).toBe(true);
    });

    it('should process ticket.created webhook with negative sentiment', async () => {
      const payload = {
        eventType: 'ticket.created',
        data: {
          ticketId: 'ticket001',
          propertyId: 'prop456',
          tenantId: 'tenant789',
          subject: 'Broken heating',
          sentiment: 'negative',
          orgId: 'org456',
          userId: 'user123',
        },
      };

      const result = await processor.process(payload);

      expect(result.processed).toBe(true);
      expect(result.churnSignalEmitted).toBe(true);
    });

    it('should NOT emit churn signal for positive sentiment ticket', async () => {
      const payload = {
        eventType: 'ticket.created',
        data: {
          ticketId: 'ticket002',
          propertyId: 'prop456',
          tenantId: 'tenant789',
          subject: 'Great service',
          sentiment: 'positive',
          orgId: 'org456',
          userId: 'user123',
        },
      };

      const result = await processor.process(payload);

      expect(result.processed).toBe(true);
      expect(result.churnSignalEmitted).toBe(false);
    });
  });

  describe('Churn Signal Enricher', () => {
    it('should detect late payment churn factor', async () => {
      const context = {
        leaseId: 'lease123',
        propertyId: 'prop456',
        tenantId: 'tenant789',
        orgId: 'org456',
        userId: 'user123',
      };

      const data = {
        payments: [
          {
            id: 'pay001',
            refs: {
              isLate: true,
              dueDate: '2026-05-01T00:00:00Z',
              paidDate: '2026-05-10T00:00:00Z',
            },
          },
          {
            id: 'pay002',
            refs: {
              isLate: false,
              dueDate: '2026-06-01T00:00:00Z',
              paidDate: '2026-06-01T00:00:00Z',
            },
          },
        ],
        tickets: [],
        communications: [],
      };

      const result = await enricher.enrichLease(context, data);

      expect(result.riskScore).toBeGreaterThan(20);
      expect(result.factors.length).toBeGreaterThan(0);
      expect(result.factors[0]).toMatch(/late_payment/);
    });

    it('should detect complaint churn factor', async () => {
      const context = {
        leaseId: 'lease123',
        propertyId: 'prop456',
        tenantId: 'tenant789',
        orgId: 'org456',
        userId: 'user123',
      };

      const data = {
        payments: [],
        tickets: [
          {
            id: 'ticket001',
            refs: {
              sentiment: 'negative',
            },
          },
          {
            id: 'ticket002',
            refs: {
              sentiment: 'negative',
            },
          },
        ],
        communications: [],
      };

      const result = await enricher.enrichLease(context, data);

      expect(result.riskScore).toBeGreaterThan(15);
      expect(result.factors.some((f) => f.includes('complaints'))).toBe(true);
    });

    it('should detect silence churn factor', async () => {
      const context = {
        leaseId: 'lease123',
        propertyId: 'prop456',
        tenantId: 'tenant789',
        orgId: 'org456',
        userId: 'user123',
      };

      const data = {
        payments: [],
        tickets: [],
        communications: [], // No communication data = silence
      };

      const result = await enricher.enrichLease(context, data);

      expect(result.riskScore).toBeGreaterThan(10);
      expect(result.factors.some((f) => f.includes('silence'))).toBe(true);
    });

    it('should combine multiple churn factors', async () => {
      const context = {
        leaseId: 'lease123',
        propertyId: 'prop456',
        tenantId: 'tenant789',
        orgId: 'org456',
        userId: 'user123',
      };

      const data = {
        payments: [
          {
            id: 'pay001',
            refs: {
              isLate: true,
              dueDate: '2026-05-01T00:00:00Z',
              paidDate: '2026-05-15T00:00:00Z', // 14 days late
            },
          },
        ],
        tickets: [
          {
            id: 'ticket001',
            refs: { sentiment: 'negative' },
          },
        ],
        communications: [], // Silence
      };

      const result = await enricher.enrichLease(context, data);

      expect(result.riskScore).toBeGreaterThan(50);
      expect(result.factors.length).toBe(3);
      expect(result.churnSignal).toBeDefined();
      expect(result.churnSignal.riskScore).toBeGreaterThanOrEqual(35);
    });

    it('should NOT emit signal below risk threshold', async () => {
      const context = {
        leaseId: 'lease123',
        propertyId: 'prop456',
        tenantId: 'tenant789',
        orgId: 'org456',
        userId: 'user123',
      };

      const data = {
        payments: [
          {
            id: 'pay001',
            refs: {
              isLate: false,
              dueDate: '2026-05-01T00:00:00Z',
              paidDate: '2026-05-01T00:00:00Z',
            },
          },
        ],
        tickets: [
          {
            id: 'ticket001',
            refs: { sentiment: 'positive' },
          },
        ],
        communications: [
          {
            ts: new Date().toISOString(), // Recent
          },
        ],
      };

      const result = await enricher.enrichLease(context, data);

      expect(result.riskScore).toBeLessThan(35);
      expect(result.churnSignal).toBeNull();
    });

    it('should recommend action based on risk level', async () => {
      const context = {
        leaseId: 'lease123',
        propertyId: 'prop456',
        tenantId: 'tenant789',
        orgId: 'org456',
        userId: 'user123',
      };

      // High risk scenario
      const highRiskData = {
        payments: [
          {
            id: 'pay001',
            refs: {
              isLate: true,
              dueDate: '2026-04-01T00:00:00Z',
              paidDate: '2026-05-10T00:00:00Z', // 39 days late
            },
          },
        ],
        tickets: [
          { id: 'ticket001', refs: { sentiment: 'negative' } },
          { id: 'ticket002', refs: { sentiment: 'negative' } },
        ],
        communications: [],
      };

      const result = await enricher.enrichLease(context, highRiskData);

      expect(result.churnSignal?.riskScore).toBeGreaterThan(75);
      expect(result.churnSignal?.recommendedAction).toMatch(/URGENT/);
    });

    it('should batch enrich multiple leases', async () => {
      const context = {
        propertyId: 'prop456',
        orgId: 'org456',
        userId: 'user123',
      };

      const leaseDataMap = {
        lease1: {
          payments: [
            { id: 'pay001', refs: { isLate: true, dueDate: '2026-05-01T00:00:00Z', paidDate: '2026-05-10T00:00:00Z' } },
          ],
          tickets: [],
          communications: [],
        },
        lease2: {
          payments: [],
          tickets: [{ id: 'ticket001', refs: { sentiment: 'negative' } }],
          communications: [],
        },
        lease3: {
          payments: [],
          tickets: [],
          communications: [{ ts: new Date().toISOString() }],
        },
      };

      const signals = await enricher.enrichBatch(context, leaseDataMap);

      // lease1 and lease2 should have signals, lease3 should not
      expect(signals.length).toBeGreaterThan(0);
      expect(signals.length).toBeLessThanOrEqual(2);
    });
  });

  describe('Cross-System ID Mapping', () => {
    it('should normalize property with cross_system_ids placeholder', async () => {
      // Mock property data from Poool API
      const mockData = {
        data: [
          {
            id: 'prop_poool_123',
            name: 'Downtown Office',
            address: '123 Main St',
            createdAt: '2026-01-01T00:00:00Z',
            tenants: ['tenant1', 'tenant2'],
          },
        ],
        pagination: { nextCursor: null },
      };

      // Mock fetch response
      global.fetch = async (url) => {
        if (url.includes('/properties')) {
          return {
            ok: true,
            json: async () => mockData,
          };
        }
        throw new Error('Unknown URL');
      };

      const result = await adapter.fetchProperties({
        userId: 'user123',
        orgId: 'org456',
      });

      expect(result.records.length).toBe(1);
      expect(result.records[0].refs.cross_system_ids).toBeDefined();
      expect(result.records[0].refs.cross_system_ids.sapAsset).toBeNull();
      expect(result.records[0].refs.cross_system_ids.datevLedger).toBeNull();
    });

    it('should normalize tenant with cross_system_ids placeholder', async () => {
      const mockData = {
        data: [
          {
            id: 'tenant_poool_456',
            name: 'John Doe',
            email: 'john@example.com',
            phone: '+1-555-0123',
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
        pagination: { nextCursor: null },
      };

      global.fetch = async (url) => {
        if (url.includes('/tenants')) {
          return {
            ok: true,
            json: async () => mockData,
          };
        }
        throw new Error('Unknown URL');
      };

      const result = await adapter.fetchTenants({
        userId: 'user123',
        orgId: 'org456',
      });

      expect(result.records.length).toBe(1);
      expect(result.records[0].refs.cross_system_ids).toBeDefined();
      expect(result.records[0].refs.cross_system_ids.datevId).toBeNull();
    });
  });

  afterEach(() => {
    // Clean up
    delete global.fetch;
  });
});
