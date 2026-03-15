/**
 * =============================================================================
 * HIVE-MIND Input Validation Middleware
 * =============================================================================
 * Purpose: Validate and sanitize all user input
 * Library: Zod (TypeScript-first schema validation)
 * Compliance: OWASP Input Validation Cheat Sheet
 * =============================================================================
 */

const { z } = require('zod');
const { logger } = require('../core/utils/logger');

// =============================================================================
// Common Schema Definitions
// =============================================================================

/**
 * UUID schema
 */
const uuidSchema = z.string().uuid();

/**
 * Email schema
 */
const emailSchema = z.string().email();

/**
 * URL schema
 */
const urlSchema = z.string().url();

/**
 * Date schema (ISO 8601)
 */
const dateSchema = z.string().datetime();

/**
 * Pagination schema
 */
const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

/**
 * Sorting schema
 */
const sortingSchema = z.object({
  sortBy: z.string().max(50).optional(),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
});

// =============================================================================
// Memory Schemas
// =============================================================================

/**
 * Memory creation schema
 */
const createMemorySchema = z.object({
  body: z.object({
    content: z.string().min(1).max(10000),
    title: z.string().max(500).optional(),
    memoryType: z.enum(['fact', 'preference', 'decision', 'lesson', 'goal', 'event', 'relationship']).default('fact'),
    tags: z.array(z.string().max(50)).max(20).optional(),
    visibility: z.enum(['private', 'organization', 'public']).default('private'),
    documentDate: z.string().datetime().optional(),
    eventDates: z.array(z.string().datetime()).optional(),
    importanceScore: z.number().min(0).max(1).optional(),
  }),
});

/**
 * Memory update schema
 */
const updateMemorySchema = z.object({
  params: z.object({
    id: uuidSchema,
  }),
  body: z.object({
    content: z.string().min(1).max(10000).optional(),
    title: z.string().max(500).optional(),
    memoryType: z.enum(['fact', 'preference', 'decision', 'lesson', 'goal', 'event', 'relationship']).optional(),
    tags: z.array(z.string().max(50)).max(20).optional(),
    visibility: z.enum(['private', 'organization', 'public']).optional(),
    importanceScore: z.number().min(0).max(1).optional(),
  }).strict(), // No unknown fields
});

/**
 * Memory query schema
 */
const queryMemoriesSchema = z.object({
  query: paginationSchema.merge(sortingSchema).merge(z.object({
    type: z.enum(['fact', 'preference', 'decision', 'lesson', 'goal', 'event', 'relationship']).optional(),
    tag: z.string().max(50).optional(),
    search: z.string().max(200).optional(),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
  })),
});

// =============================================================================
// User Schemas
// =============================================================================

/**
 * User update schema
 */
const updateUserSchema = z.object({
  body: z.object({
    displayName: z.string().min(1).max(100).optional(),
    timezone: z.string().max(50).optional(),
    locale: z.string().max(10).optional(),
    avatarUrl: urlSchema.optional(),
  }).strict(),
});

// =============================================================================
// Session Schemas
// =============================================================================

/**
 * Session query schema
 */
const querySessionsSchema = z.object({
  query: paginationSchema.merge(z.object({
    platform: z.string().max(50).optional(),
    active: z.string().transform(v => v === 'true').optional(),
  })),
});

// =============================================================================
// Platform Integration Schemas
// =============================================================================

/**
 * Create integration schema
 */
const createIntegrationSchema = z.object({
  body: z.object({
    platformType: z.enum(['chatgpt', 'claude', 'perplexity', 'gemini', 'other']),
    platformUserId: z.string().max(255).optional(),
    oauthCode: z.string().max(500).optional(),
    redirectUri: urlSchema.optional(),
  }),
});

// =============================================================================
// GDPR Schemas
// =============================================================================

/**
 * GDPR export request schema
 */
const gdprExportSchema = z.object({
  body: z.object({
    format: z.enum(['json', 'csv', 'parquet']).default('json'),
    email: emailSchema.optional(),
    includeArchived: z.boolean().default(false),
  }),
});

/**
 * GDPR erasure request schema
 */
const gdprErasureSchema = z.object({
  body: z.object({
    confirmation: z.literal('DELETE_MY_DATA'),
    reason: z.string().max(1000).optional(),
  }),
});

/**
 * GDPR erasure cancel schema
 */
const gdprErasureCancelSchema = z.object({
  body: z.object({
    confirmationCode: z.string().hex().length(32),
  }),
});

// =============================================================================
// Consent Schemas
// =============================================================================

/**
 * Consent grant schema
 */
const consentGrantSchema = z.object({
  body: z.object({
    consentType: z.enum([
      'service_terms',
      'privacy_policy',
      'marketing',
      'analytics',
      'personalization',
      'third_party',
      'research',
      'special_data',
    ]),
  }),
});

/**
 * Consent withdraw schema
 */
const consentWithdrawSchema = z.object({
  body: z.object({
    consentType: z.enum([
      'service_terms',
      'privacy_policy',
      'marketing',
      'analytics',
      'personalization',
      'third_party',
      'research',
      'special_data',
    ]),
    reason: z.string().max(500).optional(),
  }),
});

// =============================================================================
// Authentication Schemas
// =============================================================================

/**
 * Login schema
 */
const loginSchema = z.object({
  body: z.object({
    email: emailSchema,
    password: z.string().min(8).max(128),
    mfaCode: z.string().length(6).regex(/^\d+$/).optional(),
  }),
});

/**
 * Password reset request schema
 */
const passwordResetRequestSchema = z.object({
  body: z.object({
    email: emailSchema,
  }),
});

/**
 * Password reset confirm schema
 */
const passwordResetConfirmSchema = z.object({
  body: z.object({
    token: z.string(),
    newPassword: z.string().min(8).max(128),
  }),
});

// =============================================================================
// Validation Middleware Factory
// =============================================================================

/**
 * Create validation middleware from Zod schema
 * @param {z.ZodSchema} schema - Zod schema to validate against
 * @param {Object} options - Validation options
 * @returns {Function} Express middleware
 */
function validate(schema, options = {}) {
  const { 
    errorStatus = 400, 
    passThrough = false,
    onValidationError = null,
  } = options;

  return (req, res, next) => {
    try {
      // Parse and validate
      const result = schema.safeParse({
        body: req.body,
        query: req.query,
        params: req.params,
        headers: req.headers,
      });

      if (!result.success) {
        const errors = formatZodErrors(result.error);
        
        logger.debug('Validation failed', {
          path: req.path,
          errors,
        });

        if (onValidationError) {
          onValidationError(errors, req, res);
          return;
        }

        return res.status(errorStatus).json({
          error: 'Validation failed',
          details: errors,
        });
      }

      // Attach validated data to request
      if (result.data.body) req.body = result.data.body;
      if (result.data.query) req.query = result.data.query;
      if (result.data.params) req.params = result.data.params;
      if (result.data.headers) req.headers = result.data.headers;

      next();
    } catch (error) {
      logger.error('Validation middleware error', { error: error.message });
      
      if (passThrough) {
        next();
      } else {
        res.status(500).json({
          error: 'Validation error',
          message: 'An error occurred while validating the request',
        });
      }
    }
  };
}

/**
 * Format Zod errors into readable format
 * @param {z.ZodError} error - Zod error
 * @returns {Array} Formatted errors
 */
function formatZodErrors(error) {
  return error.errors.map(err => ({
    field: err.path.join('.'),
    message: err.message,
    code: err.code,
  }));
}

/**
 * Sanitize string input
 * Removes potentially dangerous characters
 * @param {string} input - Input string
 * @returns {string} Sanitized string
 */
function sanitizeString(input) {
  if (typeof input !== 'string') {
    return input;
  }

  return input
    .replace(/[<>]/g, '') // Remove HTML brackets
    .replace(/javascript:/gi, '') // Remove javascript: protocol
    .replace(/on\w+=/gi, '') // Remove event handlers
    .trim();
}

/**
 * Sanitize object recursively
 * @param {Object} obj - Object to sanitize
 * @returns {Object} Sanitized object
 */
function sanitizeObject(obj) {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }

  const sanitized = Array.isArray(obj) ? [] : {};

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      sanitized[key] = sanitizeString(value);
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeObject(value);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * HTML escape to prevent XSS
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
function escapeHtml(str) {
  if (typeof str !== 'string') {
    return str;
  }

  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };

  return str.replace(/[&<>"']/g, char => map[char]);
}

/**
 * Validate file upload
 * @param {Object} file - Uploaded file
 * @param {Object} options - Validation options
 * @returns {Object} Validation result
 */
function validateFile(file, options = {}) {
  const {
    maxSize = 10 * 1024 * 1024, // 10MB default
    allowedMimeTypes = [],
    allowedExtensions = [],
  } = options;

  const errors = [];

  if (!file) {
    errors.push('No file uploaded');
    return { valid: false, errors };
  }

  // Check file size
  if (file.size > maxSize) {
    errors.push(`File size exceeds limit of ${maxSize / 1024 / 1024}MB`);
  }

  // Check MIME type
  if (allowedMimeTypes.length > 0 && !allowedMimeTypes.includes(file.mimetype)) {
    errors.push(`File type ${file.mimetype} is not allowed`);
  }

  // Check extension
  if (allowedExtensions.length > 0) {
    const ext = file.originalname.split('.').pop().toLowerCase();
    if (!allowedExtensions.includes(ext)) {
      errors.push(`File extension .${ext} is not allowed`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Rate-limited validation for expensive operations
 * @param {Function} validator - Validation function
 * @param {number} timeout - Timeout in ms
 * @returns {Function} Wrapped validator
 */
function withTimeout(validator, timeout = 5000) {
  return async (req, res, next) => {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Validation timeout')), timeout);
    });

    try {
      await Promise.race([validator(req, res, next), timeoutPromise]);
    } catch (error) {
      logger.error('Validation timeout', { path: req.path });
      res.status(503).json({
        error: 'Service unavailable',
        message: 'Validation service is temporarily unavailable',
      });
    }
  };
}

module.exports = {
  // Schemas
  uuidSchema,
  emailSchema,
  urlSchema,
  dateSchema,
  paginationSchema,
  sortingSchema,
  
  // Resource schemas
  createMemorySchema,
  updateMemorySchema,
  queryMemoriesSchema,
  updateUserSchema,
  querySessionsSchema,
  createIntegrationSchema,
  
  // GDPR schemas
  gdprExportSchema,
  gdprErasureSchema,
  gdprErasureCancelSchema,
  
  // Consent schemas
  consentGrantSchema,
  consentWithdrawSchema,
  
  // Auth schemas
  loginSchema,
  passwordResetRequestSchema,
  passwordResetConfirmSchema,
  
  // Middleware
  validate,
  
  // Utilities
  formatZodErrors,
  sanitizeString,
  sanitizeObject,
  escapeHtml,
  validateFile,
  withTimeout,
};
