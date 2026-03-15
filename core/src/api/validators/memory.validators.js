/**
 * Memory API Validators
 * Zod schemas for validating memory API requests
 * 
 * Compliance: GDPR, NIS2, DORA
 * Multi-tenant isolation: org_id, user_id, project scoping
 */

import { z } from 'zod';

/**
 * Memory type enumeration matching database schema
 */
export const memoryTypeEnum = z.enum([
  'fact',
  'preference',
  'decision',
  'lesson',
  'goal',
  'event',
  'relationship'
]);

/**
 * Visibility scope enumeration
 */
export const visibilityScopeEnum = z.enum([
  'private',
  'organization',
  'public'
]);

/**
 * Base memory scoping - required for all memory operations
 * Ensures multi-tenant isolation with org_id, user_id, project
 */
export const memoryScopingSchema = z.object({
  /** User ID - required for tenant isolation */
  user_id: z.string()
    .uuid('user_id must be a valid UUID')
    .min(1, 'user_id is required'),
  
  /** Organization ID - required for org-level isolation */
  org_id: z.string()
    .uuid('org_id must be a valid UUID')
    .min(1, 'org_id is required'),
  
  /** Project ID - optional workspace context */
  project: z.string()
    .max(255, 'project must be less than 255 characters')
    .optional()
    .nullable()
});

/**
 * Memory creation request schema
 * Validates all fields for POST /api/memories
 */
export const createMemorySchema = z.object({
  // Required scoping fields
  user_id: z.string()
    .uuid('user_id must be a valid UUID')
    .min(1, 'user_id is required'),
  
  org_id: z.string()
    .uuid('org_id must be a valid UUID')
    .min(1, 'org_id is required'),
  
  project: z.string()
    .max(255, 'project must be less than 255 characters')
    .optional()
    .nullable(),
  
  // Required content
  content: z.string()
    .min(1, 'content is required')
    .max(100000, 'content must be less than 100,000 characters'),
  
  // Optional metadata
  memory_type: memoryTypeEnum.optional().default('fact'),
  
  title: z.string()
    .max(500, 'title must be less than 500 characters')
    .optional()
    .nullable(),
  
  tags: z.array(z.string().max(100))
    .max(50, 'maximum 50 tags allowed')
    .optional()
    .default([]),
  
  // Source tracking
  source_platform: z.string()
    .max(50)
    .optional()
    .nullable(),
  
  source_session_id: z.string()
    .max(255)
    .optional()
    .nullable(),
  
  source_message_id: z.string()
    .max(255)
    .optional()
    .nullable(),
  
  source_url: z.string()
    .url('source_url must be a valid URL')
    .optional()
    .nullable(),
  
  // Relationship (for versioning)
  is_latest: z.boolean().optional().default(true),
  
  supersedes_id: z.string()
    .uuid('supersedes_id must be a valid UUID')
    .optional()
    .nullable(),
  
  // Cognitive scoring
  strength: z.number()
    .min(0)
    .max(1)
    .optional()
    .default(1.0),
  
  importance_score: z.number()
    .min(0)
    .max(1)
    .optional()
    .default(0.5),
  
  // Temporal grounding
  document_date: z.string()
    .datetime()
    .optional()
    .nullable(),
  
  event_dates: z.array(z.string().datetime())
    .optional()
    .default([]),
  
  // Visibility
  visibility: visibilityScopeEnum.optional().default('private'),
  
  shared_with_orgs: z.array(z.string().uuid())
    .optional()
    .default([]),
  
  // GDPR compliance
  processing_basis: z.string()
    .max(100)
    .optional()
    .default('consent'),
  
  retention_until: z.string()
    .datetime()
    .optional()
    .nullable(),
  
  // Additional metadata
  metadata: z.record(z.any()).optional().default({})
});

/**
 * Memory update request schema
 * Allows partial updates for PATCH /api/memories/:id
 */
export const updateMemorySchema = createMemorySchema.partial();

/**
 * Memory search request schema
 * Validates search parameters for POST /api/memories/search
 */
export const searchMemorySchema = z.object({
  // Query is optional for filter-only searches
  query: z.string()
    .min(1, 'query must be at least 1 character')
    .optional(),
  
  // Required scoping
  user_id: z.string()
    .uuid('user_id must be a valid UUID')
    .min(1, 'user_id is required'),
  
  org_id: z.string()
    .uuid('org_id must be a valid UUID')
    .min(1, 'org_id is required'),
  
  project: z.string()
    .max(255)
    .optional()
    .nullable(),
  
  // Filters
  memory_type: memoryTypeEnum.optional(),
  
  tags: z.array(z.string()).optional(),
  
  source_platform: z.string().max(50).optional(),
  
  // Pagination
  n_results: z.number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(10),
  
  // Additional filters
  is_latest: z.boolean().optional().default(true),
  
  visibility: visibilityScopeEnum.optional(),
  
  // Date range filters
  created_after: z.string().datetime().optional(),
  created_before: z.string().datetime().optional(),
  
  // Scoring weights
  weights: z.object({
    similarity: z.number().min(0).max(1).optional().default(0.5),
    recency: z.number().min(0).max(1).optional().default(0.3),
    importance: z.number().min(0).max(1).optional().default(0.2)
  }).optional()
});

/**
 * Memory relationship schema
 * For creating graph relationships between memories
 */
export const relationshipSchema = z.object({
  from_id: z.string()
    .uuid('from_id must be a valid UUID'),
  
  to_id: z.string()
    .uuid('to_id must be a valid UUID'),
  
  type: z.enum(['Updates', 'Extends', 'Derives']),
  
  confidence: z.number()
    .min(0)
    .max(1)
    .optional()
    .default(1.0),
  
  metadata: z.record(z.any()).optional().default({})
});

/**
 * Memory ID path parameter schema
 * For routes like /api/memories/:id
 */
export const memoryIdParamSchema = z.object({
  id: z.string()
    .uuid('id must be a valid UUID')
});

/**
 * Query parameter schema for GET /api/memories
 */
export const memoryQueryParamsSchema = z.object({
  user_id: z.string()
    .uuid('user_id must be a valid UUID')
    .optional(),
  
  org_id: z.string()
    .uuid('org_id must be a valid UUID')
    .optional(),
  
  project: z.string()
    .max(255)
    .optional(),
  
  memory_type: memoryTypeEnum.optional(),
  
  tags: z.string()
    .transform(val => val ? val.split(',') : undefined)
    .optional(),
  
  is_latest: z.string()
    .transform(val => val === 'true')
    .optional()
    .default('true'),
  
  limit: z.string()
    .transform(val => parseInt(val, 10))
    .pipe(z.number().int().min(1).max(100))
    .optional()
    .default('50'),
  
  offset: z.string()
    .transform(val => parseInt(val, 10))
    .pipe(z.number().int().min(0))
    .optional()
    .default('0')
});

/**
 * Validate memory creation request
 * @param {object} data - Request body
 * @returns {{ success: boolean, data?: object, error?: object }}
 */
export function validateCreateMemory(data) {
  const result = createMemorySchema.safeParse(data);
  
  if (!result.success) {
    return {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        details: result.error.errors.map(err => ({
          field: err.path.join('.'),
          message: err.message,
          code: err.code
        }))
      }
    };
  }
  
  return { success: true, data: result.data };
}

/**
 * Validate memory search request
 * @param {object} data - Request body
 * @returns {{ success: boolean, data?: object, error?: object }}
 */
export function validateSearchMemory(data) {
  const result = searchMemorySchema.safeParse(data);
  
  if (!result.success) {
    return {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        details: result.error.errors.map(err => ({
          field: err.path.join('.'),
          message: err.message,
          code: err.code
        }))
      }
    };
  }
  
  return { success: true, data: result.data };
}

/**
 * Validate query parameters
 * @param {object} params - Query parameters
 * @returns {{ success: boolean, data?: object, error?: object }}
 */
export function validateMemoryQueryParams(params) {
  const result = memoryQueryParamsSchema.safeParse(params);
  
  if (!result.success) {
    return {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        details: result.error.errors.map(err => ({
          field: err.path.join('.'),
          message: err.message,
          code: err.code
        }))
      }
    };
  }
  
  return { success: true, data: result.data };
}

/**
 * Validate memory ID
 * @param {string} id - Memory ID
 * @returns {{ success: boolean, data?: object, error?: object }}
 */
export function validateMemoryId(id) {
  const result = memoryIdParamSchema.safeParse({ id });
  
  if (!result.success) {
    return {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        details: result.error.errors.map(err => ({
          field: err.path.join('.'),
          message: err.message,
          code: err.code
        }))
      }
    };
  }
  
  return { success: true, data: result.data };
}
