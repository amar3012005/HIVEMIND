/**
 * Memory API Routes
 * HIVE-MIND Cross-Platform Context Sync
 *
 * RESTful endpoints for memory CRUD operations with audit logging
 * - POST /api/memories - Create memory
 * - GET /api/memories - List memories
 * - GET /api/memories/:id - Get memory details
 * - PUT /api/memories/:id - Update memory
 * - DELETE /api/memories/:id - Delete memory
 * - POST /api/memories/search - Search memories
 *
 * All endpoints require JWT authentication (ZITADEL OIDC)
 * Audit logging enabled for all operations (NIS2/DORA compliance)
 *
 * @module api/routes/memories
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { MemoryEngine } from '../engine.local.js';
import * as auditLogService from '../services/audit-log.service.js';
import {
  validateCreateMemory,
  validateSearchMemory,
  validateMemoryQueryParams,
  validateMemoryId
} from '../validators/memory.validators.js';

const router = Router();

// Initialize memory engine
const engine = new MemoryEngine();

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
    requestId,
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
    requestId,
  });
}

// ==========================================
// ROUTES
// ==========================================

/**
 * POST /api/memories
 * Create a new memory
 *
 * @auth JWT required (ZITADEL OIDC)
 * @scope write, admin
 *
 * @body {Object} memory - Memory data
 * @body {string} memory.content - Memory content (required)
 * @body {string} [memory.memory_type=fact] - Memory type
 * @body {string} [memory.title] - Memory title
 * @body {string[]} [memory.tags] - Memory tags
 * @body {string} [memory.source_platform] - Source platform
 * @body {string} [memory.visibility=private] - Visibility scope
 *
 * @response {201} Created memory
 * @response {400} Validation error
 * @response {401} Unauthorized
 * @response {403} Insufficient scope
 */
router.post('/', async (req, res) => {
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

    // Validate request body with scoping enforcement
    const scopedBody = {
      ...req.body,
      user_id: user.id,
      org_id: user.organizationId,
    };

    const validation = validateCreateMemory(scopedBody);
    if (!validation.success) {
      return sendError(
        res,
        400,
        'VALIDATION_ERROR',
        'Invalid request body',
        validation.error.details,
        requestId
      );
    }

    // Store memory
    const result = await engine.storeMemory(validation.data);

    // Audit log: memory created
    await auditLogService.logMemoryOperation({
      userId: user.id,
      memoryId: result.memory.id,
      action: auditLogService.AUDIT_ACTIONS.CREATE,
      newValue: {
        content: result.memory.content,
        memoryType: result.memory.memory_type,
        tags: result.memory.tags,
        sourcePlatform: result.memory.source_platform,
      },
      request: req,
    });

    console.log('[MEMORIES] Memory created', {
      requestId,
      memoryId: result.memory.id,
      userId: user.id,
    });

    return sendSuccess(res, 201, result.memory, requestId);

  } catch (error) {
    console.error('[MEMORIES] Error creating memory:', {
      requestId,
      error: error.message,
      stack: error.stack,
    });

    if (error.name === 'ZodError') {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request body', error.errors, requestId);
    }

    return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to create memory', null, requestId);
  }
});

/**
 * GET /api/memories
 * List memories with filtering and pagination
 *
 * @auth JWT required (ZITADEL OIDC)
 * @scope read, admin
 *
 * @query {string} [memory_type] - Filter by memory type
 * @query {string} [tags] - Filter by tags (comma-separated)
 * @query {string} [source_platform] - Filter by source platform
 * @query {boolean} [is_latest=true] - Filter by latest version
 * @query {number} [limit=50] - Maximum results (max: 100)
 * @query {number} [offset=0] - Pagination offset
 *
 * @response {200} List of memories with pagination
 * @response {401} Unauthorized
 * @response {403} Insufficient scope
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

    // Validate query parameters
    const validation = validateMemoryQueryParams(req.query);
    if (!validation.success) {
      return sendError(
        res,
        400,
        'VALIDATION_ERROR',
        'Invalid query parameters',
        validation.error.details,
        requestId
      );
    }

    const { user_id, org_id, project, ...filters } = validation.data;

    // Enforce scoping: always filter by authenticated user's org and user
    const memories = engine.getAllMemories(user.id, user.organizationId);

    // Apply additional filters
    const filteredMemories = memories.filter(m => {
      if (project && m.project !== project) return false;
      if (filters.memory_type && m.memory_type !== filters.memory_type) return false;
      if (filters.tags && filters.tags.length > 0) {
        if (!m.tags || !filters.tags.some(t => m.tags.includes(t))) return false;
      }
      if (filters.is_latest !== undefined && m.is_latest !== filters.is_latest) return false;
      return true;
    });

    // Apply pagination
    const offset = filters.offset || 0;
    const limit = filters.limit || 50;
    const paginatedMemories = filteredMemories.slice(offset, offset + limit);

    // Audit log: memories read (batch read)
    await auditLogService.createAuditLogWithContext({
      eventType: 'memories_list',
      eventCategory: auditLogService.EVENT_CATEGORIES.DATA_ACCESS,
      action: auditLogService.AUDIT_ACTIONS.READ,
      resourceType: auditLogService.RESOURCE_TYPES.MEMORY,
      userId: user.id,
      organizationId: user.organizationId,
      newValue: {
        count: paginatedMemories.length,
        total: filteredMemories.length,
        filters,
      },
      request: req,
    });

    return sendSuccess(res, 200, {
      memories: paginatedMemories,
      pagination: {
        total: filteredMemories.length,
        offset,
        limit,
        has_more: offset + limit < filteredMemories.length,
      },
    }, requestId);

  } catch (error) {
    console.error('[MEMORIES] Error listing memories:', {
      requestId,
      error: error.message,
    });

    return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to list memories', null, requestId);
  }
});

/**
 * GET /api/memories/:id
 * Get details of a specific memory
 *
 * @auth JWT required (ZITADEL OIDC)
 * @scope read, admin
 *
 * @param {string} id - Memory ID
 *
 * @response {200} Memory details
 * @response {404} Not found
 * @response {401} Unauthorized
 * @response {403} Insufficient scope
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

    // Validate memory ID
    const validation = validateMemoryId(req.params.id);
    if (!validation.success) {
      return sendError(
        res,
        400,
        'VALIDATION_ERROR',
        'Invalid memory ID',
        validation.error.details,
        requestId
      );
    }

    const memoryId = req.params.id;

    // Get memory (implement getMemoryById in engine)
    const memory = engine.memories.get(memoryId);

    if (!memory || memory.deleted_at) {
      return sendError(res, 404, 'MEMORY_NOT_FOUND', 'Memory not found', null, requestId);
    }

    // Enforce multi-tenant isolation
    if (memory.user_id !== user.id && !user.scopes?.includes('admin')) {
      return sendError(res, 403, 'FORBIDDEN', 'Access denied to this memory', null, requestId);
    }

    // Audit log: memory read
    await auditLogService.logMemoryOperation({
      userId: user.id,
      memoryId: memoryId,
      action: auditLogService.AUDIT_ACTIONS.READ,
      request: req,
    });

    return sendSuccess(res, 200, memory, requestId);

  } catch (error) {
    console.error('[MEMORIES] Error getting memory:', {
      requestId,
      error: error.message,
    });

    return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to get memory', null, requestId);
  }
});

/**
 * PUT /api/memories/:id
 * Update a memory (creates new version with versioning)
 *
 * @auth JWT required (ZITADEL OIDC)
 * @scope write, admin
 *
 * @param {string} id - Memory ID
 * @body {Object} updates - Memory updates (partial)
 * @body {string} [updates.content] - New content
 * @body {string} [updates.title] - New title
 * @body {string[]} [updates.tags] - New tags
 *
 * @response {200} Updated memory
 * @response {404} Not found
 * @response {400} Validation error
 * @response {401} Unauthorized
 * @response {403} Insufficient scope
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

    const memoryId = req.params.id;

    // Get existing memory
    const existingMemory = engine.memories.get(memoryId);

    if (!existingMemory || existingMemory.deleted_at) {
      return sendError(res, 404, 'MEMORY_NOT_FOUND', 'Memory not found', null, requestId);
    }

    // Enforce multi-tenant isolation
    if (existingMemory.user_id !== user.id && !user.scopes?.includes('admin')) {
      return sendError(res, 403, 'FORBIDDEN', 'Access denied to this memory', null, requestId);
    }

    // Validate updates (partial update)
    const updateSchema = validateCreateMemory({ ...existingMemory, ...req.body });
    if (!updateSchema.success) {
      return sendError(
        res,
        400,
        'VALIDATION_ERROR',
        'Invalid update data',
        updateSchema.error.details,
        requestId
      );
    }

    // Create new version (versioning pattern)
    const newMemoryId = uuidv4();
    const now = new Date().toISOString();

    const newMemory = {
      ...existingMemory,
      id: newMemoryId,
      ...req.body,
      is_latest: true,
      supersedes_id: memoryId,
      updated_at: now,
      version: (existingMemory.version || 1) + 1,
    };

    // Mark old memory as not latest
    existingMemory.is_latest = false;
    existingMemory.updated_at = now;

    // Store new memory
    engine.memories.set(newMemoryId, newMemory);

    // Audit log: memory updated
    await auditLogService.logMemoryOperation({
      userId: user.id,
      memoryId: memoryId,
      action: auditLogService.AUDIT_ACTIONS.UPDATE,
      oldValue: {
        content: existingMemory.content,
        title: existingMemory.title,
        tags: existingMemory.tags,
        isLatest: existingMemory.is_latest,
      },
      newValue: {
        content: newMemory.content,
        title: newMemory.title,
        tags: newMemory.tags,
        isLatest: newMemory.is_latest,
        newMemoryId,
        version: newMemory.version,
      },
      request: req,
    });

    console.log('[MEMORIES] Memory updated', {
      requestId,
      memoryId,
      newMemoryId,
      userId: user.id,
    });

    return sendSuccess(res, 200, newMemory, requestId);

  } catch (error) {
    console.error('[MEMORIES] Error updating memory:', {
      requestId,
      error: error.message,
      stack: error.stack,
    });

    if (error.name === 'ZodError') {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request body', error.errors, requestId);
    }

    return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to update memory', null, requestId);
  }
});

/**
 * DELETE /api/memories/:id
 * Soft delete a memory
 *
 * @auth JWT required (ZITADEL OIDC)
 * @scope write, admin
 *
 * @param {string} id - Memory ID
 *
 * @response {200} Deleted memory
 * @response {404} Not found
 * @response {401} Unauthorized
 * @response {403} Insufficient scope
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

    const memoryId = req.params.id;

    // Get existing memory
    const existingMemory = engine.memories.get(memoryId);

    if (!existingMemory || existingMemory.deleted_at) {
      return sendError(res, 404, 'MEMORY_NOT_FOUND', 'Memory not found', null, requestId);
    }

    // Enforce multi-tenant isolation
    if (existingMemory.user_id !== user.id && !user.scopes?.includes('admin')) {
      return sendError(res, 403, 'FORBIDDEN', 'Access denied to this memory', null, requestId);
    }

    // Capture old value before deletion
    const oldValue = {
      id: existingMemory.id,
      content: existingMemory.content,
      memoryType: existingMemory.memory_type,
      tags: existingMemory.tags,
    };

    // Soft delete
    const now = new Date().toISOString();
    existingMemory.deleted_at = now;
    existingMemory.updated_at = now;
    existingMemory.is_latest = false;

    // Audit log: memory deleted
    await auditLogService.logMemoryOperation({
      userId: user.id,
      memoryId: memoryId,
      action: auditLogService.AUDIT_ACTIONS.DELETE,
      oldValue,
      request: req,
    });

    console.log('[MEMORIES] Memory deleted', {
      requestId,
      memoryId,
      userId: user.id,
    });

    return sendSuccess(res, 200, {
      id: memoryId,
      deleted: true,
      deleted_at: now,
    }, requestId);

  } catch (error) {
    console.error('[MEMORIES] Error deleting memory:', {
      requestId,
      error: error.message,
    });

    return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to delete memory', null, requestId);
  }
});

/**
 * POST /api/memories/search
 * Search memories with hybrid search (vector + keyword)
 *
 * @auth JWT required (ZITADEL OIDC)
 * @scope read, admin
 *
 * @body {Object} search - Search parameters
 * @body {string} [search.query] - Search query (optional for filter-only)
 * @body {string} [search.memory_type] - Filter by memory type
 * @body {string[]} [search.tags] - Filter by tags
 * @body {string} [search.source_platform] - Filter by source platform
 * @body {number} [search.n_results=10] - Number of results
 *
 * @response {200} Search results with scores
 * @response {400} Validation error
 * @response {401} Unauthorized
 */
router.post('/search', async (req, res) => {
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

    // Validate search request with scoping enforcement
    const scopedBody = {
      ...req.body,
      user_id: user.id,
      org_id: user.organizationId,
    };

    const validation = validateSearchMemory(scopedBody);
    if (!validation.success) {
      return sendError(
        res,
        400,
        'VALIDATION_ERROR',
        'Invalid search request',
        validation.error.details,
        requestId
      );
    }

    // Perform search (implement searchMemories in engine)
    const results = await engine.searchMemories?.(validation.data) || [];

    // Audit log: memory search
    await auditLogService.createAuditLogWithContext({
      eventType: 'memory_search',
      eventCategory: auditLogService.EVENT_CATEGORIES.DATA_ACCESS,
      action: auditLogService.AUDIT_ACTIONS.READ,
      resourceType: auditLogService.RESOURCE_TYPES.MEMORY,
      userId: user.id,
      organizationId: user.organizationId,
      newValue: {
        query: validation.data.query,
        resultCount: results.length,
        filters: {
          memoryType: validation.data.memory_type,
          tags: validation.data.tags,
          sourcePlatform: validation.data.source_platform,
        },
      },
      request: req,
    });

    return sendSuccess(res, 200, {
      results,
      search_params: {
        query: validation.data.query,
        project: validation.data.project,
        memory_type: validation.data.memory_type,
        count: results.length,
      },
    }, requestId);

  } catch (error) {
    console.error('[MEMORIES] Error searching memories:', {
      requestId,
      error: error.message,
      stack: error.stack,
    });

    if (error.name === 'ZodError') {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid search request', error.errors, requestId);
    }

    return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to search memories', null, requestId);
  }
});

export default router;
