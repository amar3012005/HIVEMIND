/**
 * Audit Logging Service Tests
 * HIVE-MIND Cross-Platform Context Sync
 *
 * Tests for audit logging functionality
 * - Audit log creation
 * - Query and filtering
 * - Statistics and reporting
 * - Memory operation logging
 * - Auth event logging
 * - API key operation logging
 *
 * Compliance: GDPR, NIS2, DORA
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { PrismaClient } from '@prisma/client';
import * as auditLogService from '../../src/services/audit-log.service.js';
import { v4 as uuidv4 } from 'uuid';

const prisma = new PrismaClient();

// ==========================================
// TEST FIXTURES
// ==========================================

const testUser = {
  id: uuidv4(),
  email: `test-${uuidv4()}@hivemind.test`,
};

const testOrg = {
  id: uuidv4(),
  name: 'Test Organization',
};

const testMemory = {
  id: uuidv4(),
  content: 'Test memory content',
  memory_type: 'fact',
};

const testApiKey = {
  id: uuidv4(),
  name: 'Test API Key',
};

// ==========================================
// HELPER FUNCTIONS
// ==========================================

/**
 * Clean up test data
 */
async function cleanupTestData() {
  await prisma.auditLog.deleteMany({
    where: {
      userId: testUser.id,
    },
  });
}

/**
 * Create test audit log
 */
async function createTestAuditLog(overrides = {}) {
  return prisma.auditLog.create({
    data: {
      id: uuidv4(),
      userId: testUser.id,
      organizationId: testOrg.id,
      eventType: 'test_event',
      eventCategory: 'system',
      resourceType: 'memory',
      resourceId: testMemory.id,
      action: 'create',
      ...overrides,
    },
  });
}

// ==========================================
// TESTS
// ==========================================

describe('Audit Log Service', () => {
  beforeEach(async () => {
    await cleanupTestData();
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  describe('createAuditLog', () => {
    it('should create an audit log entry successfully', async () => {
      const auditData = {
        userId: testUser.id,
        organizationId: testOrg.id,
        eventType: 'memory_created',
        eventCategory: auditLogService.EVENT_CATEGORIES.DATA_MODIFICATION,
        resourceType: auditLogService.RESOURCE_TYPES.MEMORY,
        resourceId: testMemory.id,
        action: auditLogService.AUDIT_ACTIONS.CREATE,
        newValue: { content: 'Test content' },
      };

      const result = await auditLogService.createAuditLog(auditData);

      assert.ok(result);
      assert.strictEqual(result.userId, testUser.id);
      assert.strictEqual(result.eventType, 'memory_created');
      assert.strictEqual(result.action, 'create');
      assert.ok(result.createdAt);
    });

    it('should handle null optional fields', async () => {
      const auditData = {
        userId: testUser.id,
        eventType: 'test_event',
        eventCategory: 'system',
        action: 'read',
      };

      const result = await auditLogService.createAuditLog(auditData);

      assert.ok(result);
      assert.strictEqual(result.userId, testUser.id);
      assert.strictEqual(result.organizationId, null);
      assert.strictEqual(result.resourceType, null);
    });

    it('should not throw on database errors (graceful degradation)', async () => {
      // This test verifies the service doesn't throw on audit failures
      const auditData = {
        userId: 'invalid-uuid',
        eventType: 'test',
        eventCategory: 'system',
        action: 'read',
      };

      // Should return null instead of throwing
      const result = await auditLogService.createAuditLog(auditData);
      assert.strictEqual(result, null);
    });
  });

  describe('createAuditLogWithContext', () => {
    it('should extract context from request object', async () => {
      const mockRequest = {
        ip: '192.168.1.100',
        headers: {
          'user-agent': 'Mozilla/5.0 Test Browser',
          'x-platform-type': 'chatgpt',
          'x-session-id': uuidv4(),
        },
      };

      const result = await auditLogService.createAuditLogWithContext({
        eventType: 'memory_read',
        eventCategory: auditLogService.EVENT_CATEGORIES.DATA_ACCESS,
        action: auditLogService.AUDIT_ACTIONS.READ,
        resourceType: auditLogService.RESOURCE_TYPES.MEMORY,
        resourceId: testMemory.id,
        userId: testUser.id,
        request: mockRequest,
      });

      assert.ok(result);
      assert.strictEqual(result.ipAddress, '192.168.1.100');
      assert.strictEqual(result.platformType, 'chatgpt');
    });

    it('should handle missing request object', async () => {
      const result = await auditLogService.createAuditLogWithContext({
        eventType: 'test_event',
        userId: testUser.id,
      });

      assert.ok(result);
      assert.strictEqual(result.ipAddress, null);
      assert.strictEqual(result.userAgent, null);
    });
  });

  describe('queryAuditLogs', () => {
    beforeEach(async () => {
      // Create test data
      await createTestAuditLog({ eventType: 'memory_created', action: 'create' });
      await createTestAuditLog({ eventType: 'memory_read', action: 'read' });
      await createTestAuditLog({ eventType: 'memory_updated', action: 'update' });
    });

    it('should return audit logs with pagination', async () => {
      const result = await auditLogService.queryAuditLogs({
        userId: testUser.id,
        limit: 2,
        offset: 0,
      });

      assert.ok(result.logs);
      assert.ok(result.total >= 3);
      assert.strictEqual(result.logs.length, 2);
      assert.strictEqual(result.limit, 2);
      assert.strictEqual(result.offset, 0);
      assert.ok(result.hasMore);
    });

    it('should filter by event type', async () => {
      const result = await auditLogService.queryAuditLogs({
        userId: testUser.id,
        eventType: 'memory_created',
      });

      assert.ok(result.logs);
      assert.strictEqual(result.logs.length, 1);
      assert.strictEqual(result.logs[0].eventType, 'memory_created');
    });

    it('should filter by event category', async () => {
      const result = await auditLogService.queryAuditLogs({
        userId: testUser.id,
        eventCategory: auditLogService.EVENT_CATEGORIES.DATA_MODIFICATION,
      });

      assert.ok(result.logs);
      result.logs.forEach(log => {
        assert.strictEqual(log.eventCategory, auditLogService.EVENT_CATEGORIES.DATA_MODIFICATION);
      });
    });

    it('should filter by action', async () => {
      const result = await auditLogService.queryAuditLogs({
        userId: testUser.id,
        action: auditLogService.AUDIT_ACTIONS.READ,
      });

      assert.ok(result.logs);
      result.logs.forEach(log => {
        assert.strictEqual(log.action, auditLogService.AUDIT_ACTIONS.READ);
      });
    });

    it('should filter by date range', async () => {
      const now = new Date();
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      const result = await auditLogService.queryAuditLogs({
        userId: testUser.id,
        startDate: now,
        endDate: tomorrow,
      });

      assert.ok(result.logs);
      result.logs.forEach(log => {
        assert.ok(log.createdAt >= now);
        assert.ok(log.createdAt <= tomorrow);
      });
    });

    it('should respect max query limit', async () => {
      const result = await auditLogService.queryAuditLogs({
        userId: testUser.id,
        limit: 2000, // Exceeds max of 1000
      });

      assert.strictEqual(result.limit, auditLogService.AUDIT_CONFIG.maxQueryLimit);
    });
  });

  describe('getAuditLogById', () => {
    it('should return audit log by ID', async () => {
      const created = await createTestAuditLog();
      const result = await auditLogService.getAuditLogById(created.id);

      assert.ok(result);
      assert.strictEqual(result.id, created.id);
    });

    it('should return null for non-existent ID', async () => {
      const result = await auditLogService.getAuditLogById(uuidv4());

      assert.strictEqual(result, null);
    });
  });

  describe('getUserAuditLogs', () => {
    beforeEach(async () => {
      await createTestAuditLog();
      await createTestAuditLog();
    });

    it('should return audit logs for specific user', async () => {
      const result = await auditLogService.getUserAuditLogs(testUser.id);

      assert.ok(result);
      assert.strictEqual(result.userId, testUser.id);
      assert.ok(result.logs.length >= 2);
    });

    it('should support pagination', async () => {
      const result = await auditLogService.getUserAuditLogs(testUser.id, {
        limit: 1,
        offset: 0,
      });

      assert.strictEqual(result.logs.length, 1);
      assert.ok(result.hasMore);
    });
  });

  describe('getResourceAuditLogs', () => {
    beforeEach(async () => {
      await createTestAuditLog({
        resourceType: 'memory',
        resourceId: testMemory.id,
      });
    });

    it('should return audit logs for specific resource', async () => {
      const result = await auditLogService.getResourceAuditLogs(
        auditLogService.RESOURCE_TYPES.MEMORY,
        testMemory.id
      );

      assert.ok(result);
      assert.strictEqual(result.resourceType, 'memory');
      assert.strictEqual(result.resourceId, testMemory.id);
      assert.ok(result.logs.length >= 1);
    });
  });

  describe('getAuditLogStats', () => {
    beforeEach(async () => {
      await createTestAuditLog({ action: 'create' });
      await createTestAuditLog({ action: 'read' });
      await createTestAuditLog({ action: 'update' });
    });

    it('should return statistics object', async () => {
      const result = await auditLogService.getAuditLogStats({
        userId: testUser.id,
      });

      assert.ok(result);
      assert.ok(typeof result.total === 'number');
      assert.ok(result.byCategory);
      assert.ok(result.byAction);
      assert.ok(result.byResourceType);
      assert.ok(result.byUser);
    });

    it('should include breakdown by action', async () => {
      const result = await auditLogService.getAuditLogStats({
        userId: testUser.id,
      });

      assert.ok(result.byAction.create >= 1);
      assert.ok(result.byAction.read >= 1);
      assert.ok(result.byAction.update >= 1);
    });

    it('should filter stats by date range', async () => {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      const result = await auditLogService.getAuditLogStats({
        userId: testUser.id,
        startDate: yesterday,
        endDate: now,
      });

      assert.ok(result);
      assert.ok(result.period);
      assert.ok(result.period.start);
      assert.ok(result.period.end);
    });
  });

  describe('Specialized Logging Functions', () => {
    describe('logAuthEvent', () => {
      it('should log authentication success', async () => {
        const mockRequest = {
          ip: '192.168.1.100',
          headers: {
            'user-agent': 'Test Browser',
            'x-session-id': uuidv4(),
          },
        };

        const result = await auditLogService.logAuthEvent({
          userId: testUser.id,
          eventType: 'auth_success',
          request: mockRequest,
          details: { method: 'jwt' },
        });

        assert.ok(result);
        assert.strictEqual(result.eventCategory, auditLogService.EVENT_CATEGORIES.AUTH);
        assert.strictEqual(result.action, auditLogService.AUDIT_ACTIONS.AUTH_SUCCESS);
      });

      it('should log authentication failure', async () => {
        const mockRequest = {
          ip: '192.168.1.100',
          headers: {},
        };

        const result = await auditLogService.logAuthEvent({
          userId: null,
          eventType: 'auth_failure',
          request: mockRequest,
          details: { reason: 'Invalid token' },
        });

        assert.ok(result);
        assert.strictEqual(result.eventCategory, auditLogService.EVENT_CATEGORIES.AUTH);
        assert.strictEqual(result.action, auditLogService.AUDIT_ACTIONS.AUTH_FAILURE);
      });
    });

    describe('logMemoryOperation', () => {
      it('should log memory creation', async () => {
        const mockRequest = {
          ip: '192.168.1.100',
          headers: {
            'user-agent': 'Test Browser',
            'x-platform-type': 'chatgpt',
          },
        };

        const result = await auditLogService.logMemoryOperation({
          userId: testUser.id,
          memoryId: testMemory.id,
          action: auditLogService.AUDIT_ACTIONS.CREATE,
          newValue: { content: 'Test content' },
          request: mockRequest,
        });

        assert.ok(result);
        assert.strictEqual(result.resourceType, auditLogService.RESOURCE_TYPES.MEMORY);
        assert.strictEqual(result.action, auditLogService.AUDIT_ACTIONS.CREATE);
        assert.strictEqual(result.platformType, 'chatgpt');
      });

      it('should log memory update with old/new values', async () => {
        const mockRequest = {
          ip: '192.168.1.100',
          headers: {},
        };

        const result = await auditLogService.logMemoryOperation({
          userId: testUser.id,
          memoryId: testMemory.id,
          action: auditLogService.AUDIT_ACTIONS.UPDATE,
          oldValue: { content: 'Old content' },
          newValue: { content: 'New content' },
          request: mockRequest,
        });

        assert.ok(result);
        assert.strictEqual(result.action, auditLogService.AUDIT_ACTIONS.UPDATE);
        assert.ok(result.oldValue);
        assert.ok(result.newValue);
      });

      it('should log memory deletion', async () => {
        const mockRequest = {
          ip: '192.168.1.100',
          headers: {},
        };

        const result = await auditLogService.logMemoryOperation({
          userId: testUser.id,
          memoryId: testMemory.id,
          action: auditLogService.AUDIT_ACTIONS.DELETE,
          oldValue: { content: 'Deleted content' },
          request: mockRequest,
        });

        assert.ok(result);
        assert.strictEqual(result.action, auditLogService.AUDIT_ACTIONS.DELETE);
      });
    });

    describe('logApiKeyOperation', () => {
      it('should log API key creation', async () => {
        const mockRequest = {
          ip: '192.168.1.100',
          headers: {},
        };

        const result = await auditLogService.logApiKeyOperation({
          userId: testUser.id,
          keyId: testApiKey.id,
          action: auditLogService.AUDIT_ACTIONS.CREATE,
          details: { name: 'Test Key' },
          request: mockRequest,
        });

        assert.ok(result);
        assert.strictEqual(result.resourceType, auditLogService.RESOURCE_TYPES.API_KEY);
        assert.strictEqual(result.action, auditLogService.AUDIT_ACTIONS.CREATE);
      });

      it('should log API key revocation', async () => {
        const mockRequest = {
          ip: '192.168.1.100',
          headers: {},
        };

        const result = await auditLogService.logApiKeyOperation({
          userId: testUser.id,
          keyId: testApiKey.id,
          action: auditLogService.AUDIT_ACTIONS.API_KEY_REVOKED,
          details: { reason: 'Security concern' },
          request: mockRequest,
        });

        assert.ok(result);
        assert.strictEqual(result.action, auditLogService.AUDIT_ACTIONS.API_KEY_REVOKED);
      });
    });

    describe('logDataRequest', () => {
      it('should log data export request', async () => {
        const mockRequest = {
          ip: '192.168.1.100',
          headers: {},
        };

        const result = await auditLogService.logDataRequest({
          userId: testUser.id,
          action: auditLogService.AUDIT_ACTIONS.EXPORT,
          requestId: uuidv4(),
          details: { format: 'json' },
          request: mockRequest,
        });

        assert.ok(result);
        assert.strictEqual(result.eventCategory, auditLogService.EVENT_CATEGORIES.COMPLIANCE);
        assert.strictEqual(result.action, auditLogService.AUDIT_ACTIONS.EXPORT);
        assert.ok(result.processingBasis);
      });

      it('should log data erasure request', async () => {
        const mockRequest = {
          ip: '192.168.1.100',
          headers: {},
        };

        const result = await auditLogService.logDataRequest({
          userId: testUser.id,
          action: auditLogService.AUDIT_ACTIONS.ERASE,
          requestId: uuidv4(),
          request: mockRequest,
        });

        assert.ok(result);
        assert.strictEqual(result.action, auditLogService.AUDIT_ACTIONS.ERASE);
        assert.strictEqual(result.eventCategory, auditLogService.EVENT_CATEGORIES.COMPLIANCE);
      });
    });
  });

  describe('Constants', () => {
    it('should have correct EVENT_CATEGORIES', () => {
      assert.ok(auditLogService.EVENT_CATEGORIES.AUTH);
      assert.ok(auditLogService.EVENT_CATEGORIES.DATA_ACCESS);
      assert.ok(auditLogService.EVENT_CATEGORIES.DATA_MODIFICATION);
      assert.ok(auditLogService.EVENT_CATEGORIES.SECURITY);
      assert.ok(auditLogService.EVENT_CATEGORIES.COMPLIANCE);
    });

    it('should have correct AUDIT_ACTIONS', () => {
      assert.ok(auditLogService.AUDIT_ACTIONS.CREATE);
      assert.ok(auditLogService.AUDIT_ACTIONS.READ);
      assert.ok(auditLogService.AUDIT_ACTIONS.UPDATE);
      assert.ok(auditLogService.AUDIT_ACTIONS.DELETE);
      assert.ok(auditLogService.AUDIT_ACTIONS.EXPORT);
      assert.ok(auditLogService.AUDIT_ACTIONS.ERASE);
    });

    it('should have correct RESOURCE_TYPES', () => {
      assert.ok(auditLogService.RESOURCE_TYPES.MEMORY);
      assert.ok(auditLogService.RESOURCE_TYPES.USER);
      assert.ok(auditLogService.RESOURCE_TYPES.API_KEY);
    });

    it('should have correct AUDIT_CONFIG', () => {
      assert.strictEqual(auditLogService.AUDIT_CONFIG.retentionYears, 7);
      assert.ok(auditLogService.AUDIT_CONFIG.maxQueryLimit);
      assert.ok(auditLogService.AUDIT_CONFIG.defaultQueryLimit);
    });
  });
});

describe('Audit Log Compliance', () => {
  beforeEach(async () => {
    await cleanupTestData();
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  it('should support 7-year retention (NIS2/DORA)', async () => {
    assert.strictEqual(auditLogService.AUDIT_CONFIG.retentionYears, 7);
  });

  it('should include GDPR processing basis for data requests', async () => {
    const result = await auditLogService.logDataRequest({
      userId: testUser.id,
      action: auditLogService.AUDIT_ACTIONS.EXPORT,
      requestId: uuidv4(),
      request: { ip: '192.168.1.100', headers: {} },
    });

    assert.ok(result);
    assert.ok(result.processingBasis);
    assert.ok(result.legalBasisNote || result.eventType.includes('export'));
  });

  it('should track multi-tenant isolation (user_id, organization_id)', async () => {
    const result = await auditLogService.createAuditLog({
      userId: testUser.id,
      organizationId: testOrg.id,
      eventType: 'test',
      eventCategory: 'system',
      action: 'read',
    });

    assert.ok(result);
    assert.strictEqual(result.userId, testUser.id);
    assert.strictEqual(result.organizationId, testOrg.id);
  });
});
