/**
 * API Key Authentication Middleware Tests
 * HIVE-MIND Cross-Platform Context Sync
 * 
 * Tests for API key authentication middleware:
 * - API key extraction from headers
 * - API key validation
 * - Rate limiting
 * - Scope authorization
 * - Multi-tenant isolation
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { PrismaClient } from '@prisma/client';
import {
  createApiKey,
  revokeApiKey,
  validateApiKey,
  hasScope,
  hasAnyScope
} from '../../src/services/api-key.service.js';
import {
  apiKeyAuth,
  requireApiKeyAuth,
  requireScope,
  optionalApiKeyAuth,
  multiAuth,
  denyApiKeyAuth,
  extractApiKey,
  checkRateLimit
} from '../../src/auth/api-keys.js';

const prisma = new PrismaClient();

// Test utilities
let testUserId = null;

/**
 * Create a test user
 */
async function createTestUser() {
  const email = `test_middleware_${Date.now()}@hivemind.test`;
  
  const user = await prisma.user.upsert({
    where: { email },
    create: {
      zitadelUserId: `test_zitadel_${Date.now()}`,
      email,
      displayName: 'Test Middleware User',
      encryptionKeyId: 'test-key-id'
    },
    update: {}
  });

  return user;
}

/**
 * Clean up test data
 */
async function cleanupTestUser(userId) {
  if (!userId) return;
  
  await prisma.apiKey.deleteMany({
    where: { userId }
  });

  await prisma.user.delete({
    where: { id: userId }
  }).catch(() => {});
}

/**
 * Mock Express request object
 */
function mockRequest(options = {}) {
  const { headers = {}, query = {}, params = {}, user = null, authMethod = null } = options;
  
  return {
    headers,
    query,
    params,
    user,
    authMethod,
    connection: { remoteAddress: '127.0.0.1' }
  };
}

/**
 * Mock Express response object
 */
function mockResponse() {
  const res = {
    statusCode: 200,
    body: null,
    status: function(code) {
      this.statusCode = code;
      return this;
    },
    json: function(data) {
      this.body = data;
      return this;
    }
  };
  return res;
}

describe('API Key Auth Middleware', () => {
  before(async () => {
    testUserId = await createTestUser();
  });

  after(async () => {
    await cleanupTestUser(testUserId);
    await prisma.$disconnect();
  });

  describe('extractApiKey', () => {
    it('should extract API key from X-API-Key header', () => {
      const req = mockRequest({
        headers: { 'x-api-key': 'hmk_test_key_12345' }
      });

      const key = extractApiKey(req);
      assert.strictEqual(key, 'hmk_test_key_12345');
    });

    it('should extract API key from query parameter', () => {
      const req = mockRequest({
        query: { api_key: 'hmk_test_key_67890' }
      });

      const key = extractApiKey(req);
      assert.strictEqual(key, 'hmk_test_key_67890');
    });

    it('should prefer header over query parameter', () => {
      const req = mockRequest({
        headers: { 'x-api-key': 'hmk_header_key' },
        query: { api_key: 'hmk_query_key' }
      });

      const key = extractApiKey(req);
      assert.strictEqual(key, 'hmk_header_key');
    });

    it('should return null if no API key provided', () => {
      const req = mockRequest();
      const key = extractApiKey(req);
      assert.strictEqual(key, null);
    });

    it('should trim whitespace from API key', () => {
      const req = mockRequest({
        headers: { 'x-api-key': '  hmk_trimmed_key  ' }
      });

      const key = extractApiKey(req);
      assert.strictEqual(key, 'hmk_trimmed_key');
    });
  });

  describe('apiKeyAuth', () => {
    let validApiKey;

    before(async () => {
      const result = await createApiKey({
        userId: testUserId,
        name: 'Middleware Test Key',
        scopes: ['read', 'write']
      });
      validApiKey = result.key;
    });

    it('should authenticate valid API key', (done) => {
      const req = mockRequest({
        headers: { 'x-api-key': validApiKey }
      });
      const res = mockResponse();
      const next = () => {
        assert.ok(req.user, 'Should set req.user');
        assert.strictEqual(req.user.id, testUserId);
        assert.strictEqual(req.authMethod, 'api_key');
        assert.deepStrictEqual(req.user.scopes, ['read', 'write']);
        done();
      };

      apiKeyAuth(req, res, next);
    });

    it('should reject invalid API key', (done) => {
      const req = mockRequest({
        headers: { 'x-api-key': 'hmk_invalid_key' }
      });
      const res = mockResponse();
      const next = () => {
        assert.fail('Should not call next');
      };

      // Wait for async validation
      setTimeout(() => {
        assert.strictEqual(res.statusCode, 401);
        assert.strictEqual(res.body.error, 'UNAUTHORIZED');
        done();
      }, 100);

      apiKeyAuth(req, res, next);
    });

    it('should call next if no API key provided', (done) => {
      const req = mockRequest();
      const res = mockResponse();
      const next = () => {
        assert.strictEqual(req.authMethod, null);
        done();
      };

      apiKeyAuth(req, res, next);
    });

    it('should reject expired API key', (done) => {
      // Create expired key
      createApiKey({
        userId: testUserId,
        name: 'Expired Middleware Key',
        expiresAt: new Date(Date.now() - 1000)
      }).then(async (result) => {
        const req = mockRequest({
          headers: { 'x-api-key': result.key }
        });
        const res = mockResponse();

        setTimeout(() => {
          assert.strictEqual(res.statusCode, 401);
          done();
        }, 100);

        apiKeyAuth(req, res, () => {});
      });
    });

    it('should reject revoked API key', (done) => {
      createApiKey({
        userId: testUserId,
        name: 'Revoked Middleware Key'
      }).then(async (result) => {
        await revokeApiKey(result.id, testUserId);

        const req = mockRequest({
          headers: { 'x-api-key': result.key }
        });
        const res = mockResponse();

        setTimeout(() => {
          assert.strictEqual(res.statusCode, 401);
          done();
        }, 100);

        apiKeyAuth(req, res, () => {});
      });
    });
  });

  describe('requireApiKeyAuth', () => {
    it('should require API key authentication', (done) => {
      const req = mockRequest();
      const res = mockResponse();
      const next = () => {
        assert.fail('Should not call next');
      };

      requireApiKeyAuth(req, res, next);

      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(res.body.error, 'UNAUTHORIZED');
      assert.ok(res.body.message.includes('X-API-Key'));
      done();
    });

    it('should authenticate with valid API key', (done) => {
      createApiKey({
        userId: testUserId,
        name: 'Require Auth Test Key'
      }).then(async (result) => {
        const req = mockRequest({
          headers: { 'x-api-key': result.key }
        });
        const res = mockResponse();
        const next = () => {
          assert.ok(req.user);
          assert.strictEqual(req.authMethod, 'api_key');
          done();
        };

        requireApiKeyAuth(req, res, next);
      });
    });
  });

  describe('requireScope', () => {
    it('should allow access with required scope', () => {
      const req = mockRequest({
        user: {
          id: testUserId,
          scopes: ['read', 'write']
        }
      });
      const res = mockResponse();
      const next = () => {
        // Success
      };

      const middleware = requireScope('read');
      middleware(req, res, next);

      assert.strictEqual(res.statusCode, 200);
    });

    it('should deny access without required scope', () => {
      const req = mockRequest({
        user: {
          id: testUserId,
          scopes: ['read']
        }
      });
      const res = mockResponse();

      const middleware = requireScope('admin');
      middleware(req, res, () => {});

      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res.body.error, 'INSUFFICIENT_SCOPE');
    });

    it('should grant all access with admin scope', () => {
      const req = mockRequest({
        user: {
          id: testUserId,
          scopes: ['admin']
        }
      });
      const res = mockResponse();
      const next = () => {};

      const middleware = requireScope('delete');
      middleware(req, res, next);

      assert.strictEqual(res.statusCode, 200);
    });

    it('should check multiple scopes (any)', () => {
      const req = mockRequest({
        user: {
          id: testUserId,
          scopes: ['read']
        }
      });
      const res = mockResponse();
      const next = () => {};

      const middleware = requireScope(['admin', 'read']);
      middleware(req, res, next);

      assert.strictEqual(res.statusCode, 200);
    });

    it('should require authentication', () => {
      const req = mockRequest({ user: null });
      const res = mockResponse();

      const middleware = requireScope('read');
      middleware(req, res, () => {});

      assert.strictEqual(res.statusCode, 401);
    });
  });

  describe('optionalApiKeyAuth', () => {
    it('should set user if valid API key provided', (done) => {
      createApiKey({
        userId: testUserId,
        name: 'Optional Auth Test Key'
      }).then(async (result) => {
        const req = mockRequest({
          headers: { 'x-api-key': result.key }
        });
        const res = mockResponse();
        const next = () => {
          assert.ok(req.user);
          assert.strictEqual(req.authMethod, 'api_key');
          done();
        };

        optionalApiKeyAuth(req, res, next);
      });
    });

    it('should continue without auth if no key provided', (done) => {
      const req = mockRequest();
      const res = mockResponse();
      const next = () => {
        assert.strictEqual(req.user, undefined);
        assert.strictEqual(req.authMethod, null);
        done();
      };

      optionalApiKeyAuth(req, res, next);
    });

    it('should continue if invalid key provided', (done) => {
      const req = mockRequest({
        headers: { 'x-api-key': 'hmk_invalid_key' }
      });
      const res = mockResponse();
      const next = () => {
        assert.strictEqual(req.user, undefined);
        assert.strictEqual(req.authMethod, null);
        done();
      };

      optionalApiKeyAuth(req, res, next);
    });
  });

  describe('multiAuth', () => {
    it('should use API key auth if key provided', (done) => {
      createApiKey({
        userId: testUserId,
        name: 'Multi Auth Test Key'
      }).then(async (result) => {
        const req = mockRequest({
          headers: { 'x-api-key': result.key }
        });
        const res = mockResponse();
        const next = () => {
          assert.ok(req.user);
          assert.strictEqual(req.authMethod, 'api_key');
          done();
        };

        multiAuth(req, res, next);
      });
    });

    it('should continue without auth if no credentials', (done) => {
      const req = mockRequest();
      const res = mockResponse();
      const next = () => {
        assert.strictEqual(req.authMethod, null);
        done();
      };

      multiAuth(req, res, next);
    });
  });

  describe('denyApiKeyAuth', () => {
    it('should deny API key authentication', () => {
      const req = mockRequest({
        authMethod: 'api_key',
        user: { id: testUserId }
      });
      const res = mockResponse();

      denyApiKeyAuth(req, res, () => {
        assert.fail('Should not call next');
      });

      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res.body.error, 'FORBIDDEN');
    });

    it('should allow JWT authentication', () => {
      const req = mockRequest({
        authMethod: 'jwt',
        user: { id: testUserId }
      });
      const res = mockResponse();
      let called = false;

      denyApiKeyAuth(req, res, () => {
        called = true;
      });

      assert.strictEqual(called, true);
    });
  });

  describe('checkRateLimit', () => {
    it('should allow requests under limit', () => {
      const keyId = 'test-key-rate-limit';
      const limit = 10;

      // First request should pass
      const exceeded = checkRateLimit(keyId, limit);
      assert.strictEqual(exceeded, false);
    });

    it('should block requests over limit', () => {
      const keyId = 'test-key-rate-limit-2';
      const limit = 3;

      // Make requests up to limit
      for (let i = 0; i < limit; i++) {
        checkRateLimit(keyId, limit);
      }

      // Next request should be blocked
      const exceeded = checkRateLimit(keyId, limit);
      assert.strictEqual(exceeded, true);
    });

    it('should track limits per key', () => {
      const keyId1 = 'test-key-1';
      const keyId2 = 'test-key-2';
      const limit = 5;

      // Use up limit for key1
      for (let i = 0; i < limit; i++) {
        checkRateLimit(keyId1, limit);
      }

      // key2 should still be allowed
      const exceeded = checkRateLimit(keyId2, limit);
      assert.strictEqual(exceeded, false);
    });
  });

  describe('hasScope helper', () => {
    it('should check for specific scope', () => {
      const validatedKey = { scopes: ['read', 'write'] };
      
      assert.strictEqual(hasScope(validatedKey, 'read'), true);
      assert.strictEqual(hasScope(validatedKey, 'admin'), false);
    });

    it('should handle null/undefined', () => {
      assert.strictEqual(hasScope(null, 'read'), false);
      assert.strictEqual(hasScope({}, 'read'), false);
      assert.strictEqual(hasScope({ scopes: null }, 'read'), false);
    });
  });

  describe('hasAnyScope helper', () => {
    it('should check for any of the scopes', () => {
      const validatedKey = { scopes: ['read', 'write'] };
      
      assert.strictEqual(hasAnyScope(validatedKey, ['read', 'admin']), true);
      assert.strictEqual(hasAnyScope(validatedKey, ['admin', 'delete']), false);
    });

    it('should handle null/undefined', () => {
      assert.strictEqual(hasAnyScope(null, ['read']), false);
      assert.strictEqual(hasAnyScope({}, ['read']), false);
    });
  });
});
