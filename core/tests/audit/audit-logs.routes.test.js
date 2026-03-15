/**
 * Audit Logs API Routes Tests
 * HIVE-MIND Cross-Platform Context Sync
 *
 * Integration tests for audit log API endpoints
 * - GET /api/audit-logs
 * - GET /api/audit-logs/:id
 * - GET /api/audit-logs/stats
 * - GET /api/audit-logs/compliance
 *
 * Compliance: GDPR, NIS2, DORA
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { PrismaClient } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';

const prisma = new PrismaClient();

// ==========================================
// TEST FIXTURES
// ==========================================

const testUser = {
  id: uuidv4(),
  email: `test-user-${uuidv4()}@hivemind.test`,
};

const testAdmin = {
  id: uuidv4(),
  email: `test-admin-${uuidv4()}@hivemind.test`,
  scopes: ['admin', 'read', 'write'],
};

const testOrg = {
  id: uuidv4(),
  name: 'Test Organization',
};

// ==========================================
// MOCK REQUEST/RESPONSE
// ==========================================

function createMockRequest(user, params = {}, query = {}, headers = {}) {
  return {
    user,
    params,
    query,
    headers: {
      'user-agent': 'Test Agent',
      'x-request-id': uuidv4(),
      ...headers,
    },
    ip: '192.168.1.100',
    connection: {
      remoteAddress: '192.168.1.100',
    },
  };
}

function createMockResponse() {
  const res = {
    statusCode: 200,
    headers: {},
    jsonData: null,
  };

  res.status = function(code) {
    this.statusCode = code;
    return this;
  };

  res.json = function(data) {
    this.jsonData = data;
    return this;
  };

  res.setHeader = function(key, value) {
    this.headers[key] = value;
    return this;
  };

  return res;
}

// ==========================================
// HELPER FUNCTIONS
// ==========================================

async function cleanupTestData() {
  await prisma.auditLog.deleteMany({
    where: {
      userId: { in: [testUser.id, testAdmin.id] },
    },
  });
}

async function createTestAuditLog(overrides = {}) {
  return prisma.auditLog.create({
    data: {
      id: uuidv4(),
      userId: testUser.id,
      organizationId: testOrg.id,
      eventType: 'test_event',
      eventCategory: 'system',
      resourceType: 'memory',
      resourceId: uuidv4(),
      action: 'read',
      ...overrides,
    },
  });
}

// ==========================================
// TESTS
// ==========================================

describe('Audit Logs API Routes', () => {
  beforeEach(async () => {
    await cleanupTestData();
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  describe('GET /api/audit-logs', () => {
    it('should return 401 without authentication', async () => {
      // Dynamic import to avoid circular dependencies
      const auditLogsRouter = await import('../../src/api/routes/audit-logs.js');
      const router = auditLogsRouter.default;

      const req = createMockRequest(null);
      const res = createMockResponse();

      // Simulate route handler
      await router.handle(req, res, () => {});

      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(res.jsonData.success, false);
      assert.strictEqual(res.jsonData.error, 'UNAUTHORIZED');
    });

    it('should return 403 with insufficient scope', async () => {
      const req = createMockRequest({
        id: testUser.id,
        scopes: ['none'],
      });
      const res = createMockResponse();

      const auditLogsRouter = await import('../../src/api/routes/audit-logs.js');
      const router = auditLogsRouter.default;

      await router.handle(req, res, () => {});

      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res.jsonData.error, 'INSUFFICIENT_SCOPE');
    });

    it('should return audit logs with valid authentication', async () => {
      // Create test data
      await createTestAuditLog();
      await createTestAuditLog({ eventType: 'memory_created' });

      const req = createMockRequest({
        id: testUser.id,
        scopes: ['read'],
      });
      const res = createMockResponse();

      const auditLogsRouter = await import('../../src/api/routes/audit-logs.js');
      const router = auditLogsRouter.default;

      await router.handle(req, res, () => {});

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.jsonData.success, true);
      assert.ok(res.jsonData.data.logs);
      assert.ok(res.jsonData.data.total >= 2);
    });

    it('should support filtering by event type', async () => {
      await createTestAuditLog({ eventType: 'memory_created' });
      await createTestAuditLog({ eventType: 'auth_success' });

      const req = createMockRequest(
        { id: testUser.id, scopes: ['read'] },
        {},
        { eventType: 'memory_created' }
      );
      const res = createMockResponse();

      const auditLogsRouter = await import('../../src/api/routes/audit-logs.js');
      const router = auditLogsRouter.default;

      await router.handle(req, res, () => {});

      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.jsonData.data.logs.length >= 1);
      res.jsonData.data.logs.forEach(log => {
        assert.strictEqual(log.eventType, 'memory_created');
      });
    });

    it('should support pagination', async () => {
      for (let i = 0; i < 5; i++) {
        await createTestAuditLog();
      }

      const req = createMockRequest(
        { id: testUser.id, scopes: ['read'] },
        {},
        { limit: '2', offset: '0' }
      );
      const res = createMockResponse();

      const auditLogsRouter = await import('../../src/api/routes/audit-logs.js');
      const router = auditLogsRouter.default;

      await router.handle(req, res, () => {});

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.jsonData.data.logs.length, 2);
      assert.strictEqual(res.jsonData.data.limit, 2);
      assert.strictEqual(res.jsonData.data.offset, 0);
      assert.ok(res.jsonData.data.hasMore);
    });

    it('should enforce multi-tenant isolation for non-admin users', async () => {
      const otherUser = { id: uuidv4() };
      await createTestAuditLog({ userId: otherUser.id });

      const req = createMockRequest({
        id: testUser.id,
        scopes: ['read'],
      });
      const res = createMockResponse();

      const auditLogsRouter = await import('../../src/api/routes/audit-logs.js');
      const router = auditLogsRouter.default;

      await router.handle(req, res, () => {});

      assert.strictEqual(res.statusCode, 200);
      // Should only return logs for authenticated user
      res.jsonData.data.logs.forEach(log => {
        assert.strictEqual(log.userId, testUser.id);
      });
    });
  });

  describe('GET /api/audit-logs/:id', () => {
    it('should return 401 without authentication', async () => {
      const req = createMockRequest(null, { id: uuidv4() });
      const res = createMockResponse();

      const auditLogsRouter = await import('../../src/api/routes/audit-logs.js');
      const router = auditLogsRouter.default;

      await router.handle(req, res, () => {});

      assert.strictEqual(res.statusCode, 401);
    });

    it('should return audit log by ID', async () => {
      const auditLog = await createTestAuditLog();

      const req = createMockRequest(
        { id: testUser.id, scopes: ['read'] },
        { id: auditLog.id }
      );
      const res = createMockResponse();

      const auditLogsRouter = await import('../../src/api/routes/audit-logs.js');
      const router = auditLogsRouter.default;

      await router.handle(req, res, () => {});

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.jsonData.data.id, auditLog.id);
    });

    it('should return 404 for non-existent ID', async () => {
      const req = createMockRequest(
        { id: testUser.id, scopes: ['read'] },
        { id: uuidv4() }
      );
      const res = createMockResponse();

      const auditLogsRouter = await import('../../src/api/routes/audit-logs.js');
      const router = auditLogsRouter.default;

      await router.handle(req, res, () => {});

      assert.strictEqual(res.statusCode, 404);
      assert.strictEqual(res.jsonData.error, 'AUDIT_LOG_NOT_FOUND');
    });

    it('should enforce multi-tenant isolation', async () => {
      const otherUserAuditLog = await createTestAuditLog({
        userId: uuidv4(),
      });

      const req = createMockRequest(
        { id: testUser.id, scopes: ['read'] },
        { id: otherUserAuditLog.id }
      );
      const res = createMockResponse();

      const auditLogsRouter = await import('../../src/api/routes/audit-logs.js');
      const router = auditLogsRouter.default;

      await router.handle(req, res, () => {});

      assert.strictEqual(res.statusCode, 403);
    });
  });

  describe('GET /api/audit-logs/stats', () => {
    it('should return 401 without authentication', async () => {
      const req = createMockRequest(null);
      const res = createMockResponse();

      const auditLogsRouter = await import('../../src/api/routes/audit-logs.js');
      const router = auditLogsRouter.default;

      await router.handle(req, res, () => {});

      assert.strictEqual(res.statusCode, 401);
    });

    it('should return statistics object', async () => {
      await createTestAuditLog({ action: 'create' });
      await createTestAuditLog({ action: 'read' });
      await createTestAuditLog({ action: 'update' });

      const req = createMockRequest({
        id: testUser.id,
        scopes: ['read'],
      });
      const res = createMockResponse();

      const auditLogsRouter = await import('../../src/api/routes/audit-logs.js');
      const router = auditLogsRouter.default;

      await router.handle(req, res, () => {});

      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.jsonData.data);
      assert.ok(typeof res.jsonData.data.total === 'number');
      assert.ok(res.jsonData.data.byAction);
      assert.ok(res.jsonData.data.byCategory);
    });

    it('should support date range filtering', async () => {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      const req = createMockRequest(
        { id: testUser.id, scopes: ['read'] },
        {},
        {
          startDate: yesterday.toISOString(),
          endDate: now.toISOString(),
        }
      );
      const res = createMockResponse();

      const auditLogsRouter = await import('../../src/api/routes/audit-logs.js');
      const router = auditLogsRouter.default;

      await router.handle(req, res, () => {});

      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.jsonData.data);
    });
  });

  describe('GET /api/audit-logs/compliance', () => {
    it('should return 401 without authentication', async () => {
      const req = createMockRequest(null);
      const res = createMockResponse();

      const auditLogsRouter = await import('../../src/api/routes/audit-logs.js');
      const router = auditLogsRouter.default;

      await router.handle(req, res, () => {});

      assert.strictEqual(res.statusCode, 401);
    });

    it('should return 403 without admin scope', async () => {
      const req = createMockRequest({
        id: testUser.id,
        scopes: ['read'],
      });
      const res = createMockResponse();

      const auditLogsRouter = await import('../../src/api/routes/audit-logs.js');
      const router = auditLogsRouter.default;

      await router.handle(req, res, () => {});

      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res.jsonData.error, 'INSUFFICIENT_SCOPE');
    });

    it('should return compliance report with admin scope', async () => {
      await createTestAuditLog();

      const req = createMockRequest({
        id: testAdmin.id,
        scopes: ['admin'],
        organizationId: testOrg.id,
      });
      const res = createMockResponse();

      const auditLogsRouter = await import('../../src/api/routes/audit-logs.js');
      const router = auditLogsRouter.default;

      await router.handle(req, res, () => {});

      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.jsonData.data);
      assert.ok(res.jsonData.data.reportType);
    });

    it('should support different report types', async () => {
      const reportTypes = ['standard', 'nis2', 'dora', 'gdpr'];

      for (const reportType of reportTypes) {
        const req = createMockRequest(
          { id: testAdmin.id, scopes: ['admin'], organizationId: testOrg.id },
          {},
          { reportType }
        );
        const res = createMockResponse();

        const auditLogsRouter = await import('../../src/api/routes/audit-logs.js');
        const router = auditLogsRouter.default;

        await router.handle(req, res, () => {});

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.jsonData.data.reportType, reportType.toLowerCase());
      }
    });

    it('should return 400 for invalid report type', async () => {
      const req = createMockRequest(
        { id: testAdmin.id, scopes: ['admin'], organizationId: testOrg.id },
        {},
        { reportType: 'invalid_type' }
      );
      const res = createMockResponse();

      const auditLogsRouter = await import('../../src/api/routes/audit-logs.js');
      const router = auditLogsRouter.default;

      await router.handle(req, res, () => {});

      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.jsonData.error, 'INVALID_REPORT_TYPE');
    });
  });

  describe('GET /api/audit-logs/user/:userId', () => {
    it('should return 401 without authentication', async () => {
      const req = createMockRequest(null, { userId: uuidv4() });
      const res = createMockResponse();

      const auditLogsRouter = await import('../../src/api/routes/audit-logs.js');
      const router = auditLogsRouter.default;

      await router.handle(req, res, () => {});

      assert.strictEqual(res.statusCode, 401);
    });

    it('should return 403 without admin scope', async () => {
      const req = createMockRequest(
        { id: testUser.id, scopes: ['read'] },
        { userId: uuidv4() }
      );
      const res = createMockResponse();

      const auditLogsRouter = await import('../../src/api/routes/audit-logs.js');
      const router = auditLogsRouter.default;

      await router.handle(req, res, () => {});

      assert.strictEqual(res.statusCode, 403);
    });

    it('should return user audit logs with admin scope', async () => {
      await createTestAuditLog();
      await createTestAuditLog();

      const req = createMockRequest(
        { id: testAdmin.id, scopes: ['admin'] },
        { userId: testUser.id }
      );
      const res = createMockResponse();

      const auditLogsRouter = await import('../../src/api/routes/audit-logs.js');
      const router = auditLogsRouter.default;

      await router.handle(req, res, () => {});

      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.jsonData.data);
      assert.strictEqual(res.jsonData.data.userId, testUser.id);
    });
  });

  describe('GET /api/audit-logs/resource/:resourceType/:resourceId', () => {
    it('should return 401 without authentication', async () => {
      const req = createMockRequest(null, {
        resourceType: 'memory',
        resourceId: uuidv4(),
      });
      const res = createMockResponse();

      const auditLogsRouter = await import('../../src/api/routes/audit-logs.js');
      const router = auditLogsRouter.default;

      await router.handle(req, res, () => {});

      assert.strictEqual(res.statusCode, 401);
    });

    it('should return resource audit trail', async () => {
      const resourceId = uuidv4();
      await createTestAuditLog({
        resourceType: 'memory',
        resourceId,
      });
      await createTestAuditLog({
        resourceType: 'memory',
        resourceId,
        action: 'update',
      });

      const req = createMockRequest(
        { id: testUser.id, scopes: ['read'] },
        { resourceType: 'memory', resourceId }
      );
      const res = createMockResponse();

      const auditLogsRouter = await import('../../src/api/routes/audit-logs.js');
      const router = auditLogsRouter.default;

      await router.handle(req, res, () => {});

      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.jsonData.data);
      assert.strictEqual(res.jsonData.data.resourceType, 'memory');
      assert.strictEqual(res.jsonData.data.resourceId, resourceId);
    });
  });
});

describe('Audit API Response Format', () => {
  it('should include requestId in all responses', async () => {
    const req = createMockRequest({
      id: testUser.id,
      scopes: ['read'],
    });
    const res = createMockResponse();

    const auditLogsRouter = await import('../../api/routes/audit-logs.js');
    const router = auditLogsRouter.default;

    await router.handle(req, res, () => {});

    assert.ok(res.jsonData.requestId);
    assert.strictEqual(typeof res.jsonData.requestId, 'string');
  });

  it('should use consistent error response format', async () => {
    const req = createMockRequest(null);
    const res = createMockResponse();

    const auditLogsRouter = await import('../../api/routes/audit-logs.js');
    const router = auditLogsRouter.default;

    await router.handle(req, res, () => {});

    assert.strictEqual(res.jsonData.success, false);
    assert.ok(res.jsonData.error);
    assert.ok(res.jsonData.message);
    assert.ok(res.jsonData.requestId);
  });

  it('should use consistent success response format', async () => {
    await createTestAuditLog();

    const req = createMockRequest({
      id: testUser.id,
      scopes: ['read'],
    });
    const res = createMockResponse();

    const auditLogsRouter = await import('../../api/routes/audit-logs.js');
    const router = auditLogsRouter.default;

    await router.handle(req, res, () => {});

    assert.strictEqual(res.jsonData.success, true);
    assert.ok(res.jsonData.data);
    assert.ok(res.jsonData.requestId);
  });
});
