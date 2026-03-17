/**
 * API Key Management Routes
 * HIVE-MIND Cross-Platform Context Sync
 *
 * RESTful endpoints for API key CRUD operations
 * - POST /api/keys - Create new API key
 * - GET /api/keys - List all API keys
 * - GET /api/keys/:id - Get API key details
 * - PUT /api/keys/:id - Update API key metadata
 * - DELETE /api/keys/:id - Revoke API key
 * - POST /api/keys/:id/revoke - Revoke API key
 *
 * All endpoints require JWT authentication (ZITADEL OIDC)
 * API keys cannot be used to manage other API keys (security)
 * Audit logging enabled for all operations (NIS2/DORA compliance)
 *
 * @module api/routes/keys
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import * as apiKeyService from '../services/api-key.service.js';
import * as auditLogService from '../services/audit-log.service.js';
import { createApiKeySchema, updateApiKeySchema, revokeApiKeySchema } from '../services/api-key.service.js';

const router = Router();

// ==========================================
// HELPER FUNCTIONS
// ==========================================

/**
 * Generate a unique request ID for tracing
 * @returns {string} UUID request ID
 */
function generateRequestId() {
  return uuidv4();
}

/**
 * Extract client IP from request
 * @param {Object} req - Express request object
 * @returns {string|null} Client IP address
 */
function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() 
    || req.headers['x-real-ip'] 
    || req.connection?.remoteAddress 
    || null;
}

/**
 * Standard success response
 * @param {Object} res - Express response object
 * @param {number} statusCode - HTTP status code
 * @param {Object} data - Response data
 * @param {string} requestId - Request ID for tracing
 */
function sendSuccess(res, statusCode, data, requestId) {
  res.status(statusCode).json({
    success: true,
    data,
    requestId
  });
}

/**
 * Standard error response
 * @param {Object} res - Express response object
 * @param {number} statusCode - HTTP status code
 * @param {string} error - Error code
 * @param {string} message - Human-readable message
 * @param {Object|null} details - Additional error details
 * @param {string} requestId - Request ID for tracing
 */
function sendError(res, statusCode, error, message, details = null, requestId) {
  res.status(statusCode).json({
    success: false,
    error,
    message,
    details,
    requestId
  });
}

// ==========================================
// ROUTES
// ==========================================

/**
 * POST /api/keys
 * Create a new API key
 * 
 * @auth JWT required (ZITADEL OIDC)
 * @scope write, admin
 * 
 * @body {Object} request
 * @body {string} request.name - Human-readable name for the key
 * @body {string} [request.description] - Optional description
 * @body {string} [request.expiresAt] - ISO 8601 expiration date
 * @body {string[]} [request.scopes] - Permission scopes (default: ['read', 'write'])
 * @body {number} [request.rateLimitPerMinute] - Rate limit (default: 60)
 * 
 * @response {201} Created API key (plain text key shown only once)
 * @response {400} Validation error
 * @response {401} Unauthorized
 * @response {403} Insufficient scope
 */
router.post('/', async (req, res) => {
  const requestId = generateRequestId();

  try {
    // Extract user context from JWT (set by auth middleware)
    const user = req.user;
    if (!user || !user.id) {
      return sendError(res, 401, 'UNAUTHORIZED', 'JWT authentication required', null, requestId);
    }

    // Check scope
    if (!user.scopes?.includes('admin') && !user.scopes?.includes('write')) {
      return sendError(res, 403, 'INSUFFICIENT_SCOPE', 'Requires write or admin scope', null, requestId);
    }

    // Validate request body
    const validationResult = createApiKeySchema.safeParse(req.body);
    if (!validationResult.success) {
      return sendError(
        res, 
        400, 
        'VALIDATION_ERROR', 
        'Invalid request body', 
        validationResult.error.errors,
        requestId
      );
    }

    const { name, description, expiresAt, scopes, rateLimitPerMinute } = validationResult.data;

    // Create the API key
    const apiKey = await apiKeyService.createApiKey({
      userId: user.id,
      orgId: user.organizationId || null,
      name,
      description,
      expiresAt,
      scopes,
      rateLimitPerMinute,
      createdByIp: getClientIp(req),
      userAgent: req.headers['user-agent']
    });

    // Audit log: API key created
    await auditLogService.logApiKeyOperation({
      userId: user.id,
      keyId: apiKey.id,
      action: auditLogService.AUDIT_ACTIONS.CREATE,
      details: {
        name: apiKey.name,
        keyPrefix: apiKey.keyPrefix,
        scopes: apiKey.scopes,
        expiresAt: apiKey.expiresAt,
      },
      request: req,
    });

    // Log creation (audit trail)
    console.log('[API_KEYS] API key created', {
      requestId,
      keyId: apiKey.id,
      userId: user.id,
      keyPrefix: apiKey.keyPrefix,
      expiresAt: apiKey.expiresAt
    });

    return sendSuccess(res, 201, apiKey, requestId);

  } catch (error) {
    console.error('[API_KEYS] Error creating API key:', {
      requestId,
      error: error.message,
      stack: error.stack
    });

    if (error.name === 'ZodError') {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request body', error.errors, requestId);
    }

    return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to create API key', null, requestId);
  }
});

/**
 * GET /api/keys
 * List all API keys for the authenticated user
 * 
 * @auth JWT required (ZITADEL OIDC)
 * @scope read, admin
 * 
 * @query {boolean} [includeRevoked=false] - Include revoked keys
 * @query {boolean} [includeExpired=false] - Include expired keys
 * @query {number} [limit=50] - Maximum results
 * @query {number} [offset=0] - Pagination offset
 * 
 * @response {200} List of API keys
 * @response {401} Unauthorized
 */
router.get('/', async (req, res) => {
  const requestId = generateRequestId();

  try {
    // Extract user context from JWT
    const user = req.user;
    if (!user || !user.id) {
      return sendError(res, 401, 'UNAUTHORIZED', 'JWT authentication required', null, requestId);
    }

    // Check scope
    if (!user.scopes?.includes('admin') && !user.scopes?.includes('read')) {
      return sendError(res, 403, 'INSUFFICIENT_SCOPE', 'Requires read or admin scope', null, requestId);
    }

    // Parse query parameters
    const includeRevoked = req.query.includeRevoked === 'true';
    const includeExpired = req.query.includeExpired === 'true';
    const limit = Math.min(parseInt(req.query.limit) || 50, 100); // Cap at 100
    const offset = parseInt(req.query.offset) || 0;

    // List API keys
    const apiKeys = await apiKeyService.listApiKeys(user.id, {
      includeRevoked,
      includeExpired,
      limit,
      offset
    });

    // Get stats
    const stats = await apiKeyService.getApiKeyStats(user.id);

    return sendSuccess(res, 200, {
      keys: apiKeys,
      pagination: {
        limit,
        offset,
        total: apiKeys.length
      },
      stats
    }, requestId);

  } catch (error) {
    console.error('[API_KEYS] Error listing API keys:', {
      requestId,
      error: error.message
    });

    return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to list API keys', null, requestId);
  }
});

/**
 * GET /api/keys/:id
 * Get details of a specific API key
 * 
 * @auth JWT required (ZITADEL OIDC)
 * @scope read, admin
 * 
 * @param {string} id - API key ID
 * 
 * @response {200} API key details
 * @response {404} Key not found
 * @response {401} Unauthorized
 */
router.get('/:id', async (req, res) => {
  const requestId = generateRequestId();

  try {
    // Extract user context from JWT
    const user = req.user;
    if (!user || !user.id) {
      return sendError(res, 401, 'UNAUTHORIZED', 'JWT authentication required', null, requestId);
    }

    // Check scope
    if (!user.scopes?.includes('admin') && !user.scopes?.includes('read')) {
      return sendError(res, 403, 'INSUFFICIENT_SCOPE', 'Requires read or admin scope', null, requestId);
    }

    const keyId = req.params.id;

    // Get API key
    const apiKey = await apiKeyService.getApiKeyById(keyId, user.id);

    if (!apiKey) {
      return sendError(res, 404, 'API_KEY_NOT_FOUND', 'API key not found', null, requestId);
    }

    return sendSuccess(res, 200, apiKey, requestId);

  } catch (error) {
    console.error('[API_KEYS] Error getting API key:', {
      requestId,
      error: error.message
    });

    return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to get API key', null, requestId);
  }
});

/**
 * PUT /api/keys/:id
 * Update API key metadata
 * 
 * @auth JWT required (ZITADEL OIDC)
 * @scope write, admin
 * 
 * @param {string} id - API key ID
 * @body {Object} updates
 * @body {string} [updates.name] - New name
 * @body {string} [updates.description] - New description
 * @body {string} [updates.expiresAt] - New expiration date
 * @body {string[]} [updates.scopes] - New scopes
 * @body {number} [updates.rateLimitPerMinute] - New rate limit
 * 
 * @response {200} Updated API key
 * @response {404} Key not found
 * @response {400} Validation error
 * @response {401} Unauthorized
 */
router.put('/:id', async (req, res) => {
  const requestId = generateRequestId();

  try {
    // Extract user context from JWT
    const user = req.user;
    if (!user || !user.id) {
      return sendError(res, 401, 'UNAUTHORIZED', 'JWT authentication required', null, requestId);
    }

    // Check scope
    if (!user.scopes?.includes('admin') && !user.scopes?.includes('write')) {
      return sendError(res, 403, 'INSUFFICIENT_SCOPE', 'Requires write or admin scope', null, requestId);
    }

    const keyId = req.params.id;

    // Validate updates
    const validationResult = updateApiKeySchema.safeParse(req.body);
    if (!validationResult.success) {
      return sendError(
        res,
        400,
        'VALIDATION_ERROR',
        'Invalid request body',
        validationResult.error.errors,
        requestId
      );
    }

    // Update API key
    const apiKey = await apiKeyService.updateApiKey(keyId, user.id, validationResult.data);

    console.log('[API_KEYS] API key updated', {
      requestId,
      keyId,
      userId: user.id
    });

    return sendSuccess(res, 200, apiKey, requestId);

  } catch (error) {
    console.error('[API_KEYS] Error updating API key:', {
      requestId,
      error: error.message
    });

    if (error.name === 'ZodError') {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request body', error.errors, requestId);
    }

    if (error.message === 'API_KEY_NOT_FOUND') {
      return sendError(res, 404, 'API_KEY_NOT_FOUND', 'API key not found', null, requestId);
    }

    if (error.message === 'API_KEY_REVOKED_CANNOT_UPDATE') {
      return sendError(res, 400, 'API_KEY_REVOKED', 'Cannot update a revoked API key', null, requestId);
    }

    return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to update API key', null, requestId);
  }
});

/**
 * DELETE /api/keys/:id
 * Revoke an API key
 * 
 * @auth JWT required (ZITADEL OIDC)
 * @scope write, admin
 * 
 * @param {string} id - API key ID
 * @query {string} [reason] - Optional reason for revocation
 * 
 * @response {200} Revoked API key
 * @response {404} Key not found
 * @response {401} Unauthorized
 */
router.delete('/:id', async (req, res) => {
  const requestId = generateRequestId();

  try {
    // Extract user context from JWT
    const user = req.user;
    if (!user || !user.id) {
      return sendError(res, 401, 'UNAUTHORIZED', 'JWT authentication required', null, requestId);
    }

    // Check scope
    if (!user.scopes?.includes('admin') && !user.scopes?.includes('write')) {
      return sendError(res, 403, 'INSUFFICIENT_SCOPE', 'Requires write or admin scope', null, requestId);
    }

    const keyId = req.params.id;
    const reason = req.query.reason || null;

    // Revoke API key
    const apiKey = await apiKeyService.revokeApiKey(keyId, user.id, reason);

    // Audit log: API key revoked
    await auditLogService.logApiKeyOperation({
      userId: user.id,
      keyId: keyId,
      action: auditLogService.AUDIT_ACTIONS.API_KEY_REVOKED,
      details: {
        reason,
        revokedAt: apiKey.revokedAt,
      },
      request: req,
    });

    console.log('[API_KEYS] API key revoked', {
      requestId,
      keyId,
      userId: user.id,
      reason
    });

    return sendSuccess(res, 200, apiKey, requestId);

  } catch (error) {
    console.error('[API_KEYS] Error revoking API key:', {
      requestId,
      error: error.message
    });

    if (error.message === 'API_KEY_NOT_FOUND') {
      return sendError(res, 404, 'API_KEY_NOT_FOUND', 'API key not found', null, requestId);
    }

    if (error.message === 'API_KEY_ALREADY_REVOKED') {
      return sendError(res, 400, 'API_KEY_ALREADY_REVOKED', 'API key is already revoked', null, requestId);
    }

    return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to revoke API key', null, requestId);
  }
});

/**
 * POST /api/keys/:id/revoke
 * Revoke an API key (alternative to DELETE)
 * 
 * @auth JWT required (ZITADEL OIDC)
 * @scope write, admin
 * 
 * @param {string} id - API key ID
 * @body {string} [reason] - Optional reason for revocation
 * 
 * @response {200} Revoked API key
 * @response {404} Key not found
 * @response {401} Unauthorized
 */
router.post('/:id/revoke', async (req, res) => {
  const requestId = generateRequestId();

  try {
    // Extract user context from JWT
    const user = req.user;
    if (!user || !user.id) {
      return sendError(res, 401, 'UNAUTHORIZED', 'JWT authentication required', null, requestId);
    }

    // Check scope
    if (!user.scopes?.includes('admin') && !user.scopes?.includes('write')) {
      return sendError(res, 403, 'INSUFFICIENT_SCOPE', 'Requires write or admin scope', null, requestId);
    }

    const keyId = req.params.id;

    // Validate reason if provided
    const validationResult = revokeApiKeySchema.safeParse(req.body);
    if (!validationResult.success) {
      return sendError(
        res,
        400,
        'VALIDATION_ERROR',
        'Invalid request body',
        validationResult.error.errors,
        requestId
      );
    }

    const { reason } = validationResult.data;

    // Revoke API key
    const apiKey = await apiKeyService.revokeApiKey(keyId, user.id, reason);

    // Audit log: API key revoked
    await auditLogService.logApiKeyOperation({
      userId: user.id,
      keyId: keyId,
      action: auditLogService.AUDIT_ACTIONS.API_KEY_REVOKED,
      details: {
        reason,
        revokedAt: apiKey.revokedAt,
      },
      request: req,
    });

    console.log('[API_KEYS] API key revoked', {
      requestId,
      keyId,
      userId: user.id,
      reason
    });

    return sendSuccess(res, 200, apiKey, requestId);

  } catch (error) {
    console.error('[API_KEYS] Error revoking API key:', {
      requestId,
      error: error.message
    });

    if (error.name === 'ZodError') {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request body', error.errors, requestId);
    }

    if (error.message === 'API_KEY_NOT_FOUND') {
      return sendError(res, 404, 'API_KEY_NOT_FOUND', 'API key not found', null, requestId);
    }

    if (error.message === 'API_KEY_ALREADY_REVOKED') {
      return sendError(res, 400, 'API_KEY_ALREADY_REVOKED', 'API key is already revoked', null, requestId);
    }

    return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to revoke API key', null, requestId);
  }
});

/**
 * GET /api/keys/stats
 * Get API key usage statistics
 * 
 * @auth JWT required (ZITADEL OIDC)
 * @scope read, admin
 * 
 * @response {200} API key statistics
 * @response {401} Unauthorized
 */
router.get('/stats', async (req, res) => {
  const requestId = generateRequestId();

  try {
    // Extract user context from JWT
    const user = req.user;
    if (!user || !user.id) {
      return sendError(res, 401, 'UNAUTHORIZED', 'JWT authentication required', null, requestId);
    }

    // Get stats
    const stats = await apiKeyService.getApiKeyStats(user.id);

    return sendSuccess(res, 200, stats, requestId);

  } catch (error) {
    console.error('[API_KEYS] Error getting API key stats:', {
      requestId,
      error: error.message
    });

    return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to get API key statistics', null, requestId);
  }
});

export default router;
