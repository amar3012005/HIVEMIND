/**
 * Input Validation Middleware
 * Zod-based validation for API requests
 *
 * Features:
 * - Zod schema validation
 * - Request body validation
 * - Query parameter validation
 * - Path parameter validation
 * - Custom error handling
 */

import { z } from 'zod';

// Validation error class
export class ValidationError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
    this.statusCode = 400;
  }
}

/**
 * Create Zod schema validator for request body
 */
export function validateBody(schema) {
  return (req, res, next) => {
    try {
      const parsed = schema.parse(req.body);
      req.validatedBody = parsed;
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const details = error.errors.map(err => ({
          field: err.path.join('.'),
          message: err.message,
          code: err.code,
        }));

        res.status(400).json({
          error: 'Validation failed',
          message: 'Request body validation error',
          details,
        });
        return;
      }
      next(error);
    }
  };
}

/**
 * Create Zod schema validator for query parameters
 */
export function validateQuery(schema) {
  return (req, res, next) => {
    try {
      const parsed = schema.parse(req.query);
      req.validatedQuery = parsed;
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const details = error.errors.map(err => ({
          field: err.path.join('.'),
          message: err.message,
          code: err.code,
        }));

        res.status(400).json({
          error: 'Validation failed',
          message: 'Query parameter validation error',
          details,
        });
        return;
      }
      next(error);
    }
  };
}

/**
 * Create Zod schema validator for path parameters
 */
export function validateParams(schema) {
  return (req, res, next) => {
    try {
      const parsed = schema.parse(req.params);
      req.validatedParams = parsed;
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const details = error.errors.map(err => ({
          field: err.path.join('.'),
          message: err.message,
          code: err.code,
        }));

        res.status(400).json({
          error: 'Validation failed',
          message: 'Path parameter validation error',
          details,
        });
        return;
      }
      next(error);
    }
  };
}

/**
 * Create Zod schema validator for headers
 */
export function validateHeaders(schema) {
  return (req, res, next) => {
    try {
      const parsed = schema.parse(req.headers);
      req.validatedHeaders = parsed;
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const details = error.errors.map(err => ({
          field: err.path.join('.'),
          message: err.message,
          code: err.code,
        }));

        res.status(400).json({
          error: 'Validation failed',
          message: 'Header validation error',
          details,
        });
        return;
      }
      next(error);
    }
  };
}

/**
 * Combined validator for all request parts
 */
export function validateRequest(schema) {
  return (req, res, next) => {
    try {
      const parsed = schema.parse({
        body: req.body,
        query: req.query,
        params: req.params,
        headers: req.headers,
      });
      req.validatedRequest = parsed;
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const details = error.errors.map(err => ({
          field: err.path.join('.'),
          message: err.message,
          code: err.code,
          location: err.context?.key || 'unknown',
        }));

        res.status(400).json({
          error: 'Validation failed',
          message: 'Request validation error',
          details,
        });
        return;
      }
      next(error);
    }
  };
}

/**
 * Common validation schemas
 */

// UUID validation
export const UUIDSchema = z.string().uuid();

// Email validation
export const EmailSchema = z.string().email().min(1).max(255);

// Password validation (8+ chars, at least one uppercase, one lowercase, one number)
export const PasswordSchema = z.string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number');

// String validation
export const StringSchema = (options = {}) => {
  const { min = 1, max = 255, pattern } = options;
  let schema = z.string().min(min).max(max);

  if (pattern) {
    schema = schema.regex(pattern);
  }

  return schema;
};

// Number validation
export const NumberSchema = (options = {}) => {
  const { min, max, integer = false } = options;
  let schema = z.number();

  if (min !== undefined) schema = schema.min(min);
  if (max !== undefined) schema = schema.max(max);
  if (integer) schema = schema.int();

  return schema;
};

// Boolean validation
export const BooleanSchema = z.boolean();

// Array validation
export const ArraySchema = (itemSchema) => z.array(itemSchema);

// Object validation
export const ObjectSchema = (shape) => z.object(shape);

// Date validation
export const DateSchema = z.string().datetime();

// Pagination validation
export const PaginationSchema = z.object({
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).optional(),
});

// Sort validation
export const SortSchema = z.object({
  field: z.string(),
  order: z.enum(['asc', 'desc']).default('asc'),
});

// Search validation
export const SearchSchema = z.object({
  query: z.string().min(1).max(255),
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(20),
});

// Filter validation
export const FilterSchema = z.record(z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number(), z.boolean()])),
]));

// Pagination query schema
export const PaginationQuerySchema = z.object({
  page: z.string().transform(val => parseInt(val, 10)).optional().default('1'),
  limit: z.string().transform(val => parseInt(val, 10)).optional().default('20'),
  offset: z.string().transform(val => parseInt(val, 10)).optional(),
});

// Sort query schema
export const SortQuerySchema = z.object({
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional().default('asc'),
});

// Common request schemas

// User login schema
export const LoginSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  rememberMe: z.boolean().optional().default(false),
});

// User registration schema
export const RegisterSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  confirmPassword: z.string(),
  displayName: StringSchema({ min: 1, max: 100 }).optional(),
}).refine(data => data.password === data.confirmPassword, {
  message: "Passwords don't match",
  path: ['confirmPassword'],
});

// Memory creation schema
export const MemorySchema = z.object({
  content: z.string().min(1).max(10000),
  memoryType: z.enum(['fact', 'preference', 'decision', 'lesson', 'goal', 'event', 'relationship']).optional().default('fact'),
  title: z.string().max(500).optional(),
  tags: z.array(z.string().max(50)).optional(),
  sourcePlatform: z.string().max(50).optional(),
  sourceSessionId: z.string().uuid().optional(),
  sourceMessageId: z.string().max(255).optional(),
  sourceUrl: z.string().url().optional(),
  visibility: z.enum(['private', 'organization', 'public']).optional().default('private'),
  sharedWithOrgs: z.array(z.string().uuid()).optional(),
  processingBasis: z.string().max(100).optional().default('consent'),
});

// Memory update schema
export const MemoryUpdateSchema = z.object({
  content: z.string().max(10000).optional(),
  memoryType: z.enum(['fact', 'preference', 'decision', 'lesson', 'goal', 'event', 'relationship']).optional(),
  title: z.string().max(500).optional(),
  tags: z.array(z.string().max(50)).optional(),
  visibility: z.enum(['private', 'organization', 'public']).optional(),
  sharedWithOrgs: z.array(z.string().uuid()).optional(),
  strength: z.number().min(0).max(1).optional(),
  importanceScore: z.number().min(0).max(1).optional(),
});

// Platform integration schema
export const PlatformIntegrationSchema = z.object({
  platformType: z.enum(['chatgpt', 'claude', 'perplexity', 'gemini', 'other']),
  authType: z.enum(['oauth2', 'api_key', 'webhook']),
  accessTokenEncrypted: z.string().optional(),
  refreshTokenEncrypted: z.string().optional(),
  tokenExpiresAt: z.string().datetime().optional(),
  apiKeyHash: z.string().max(255).optional(),
  webhookSecretEncrypted: z.string().optional(),
  oauthScopes: z.array(z.string()).optional(),
});

// Export request schema
export const ExportRequestSchema = z.object({
  format: z.enum(['json', 'csv']).optional().default('json'),
  categories: z.array(z.string()).optional(),
});

// Erasure request schema
export const ErasureRequestSchema = z.object({
  confirmation: z.literal('DELETE_MY_DATA'),
  categories: z.array(z.string()).optional(),
  reason: z.string().max(1000).optional(),
});

// Cancel erasure schema
export const CancelErasureSchema = z.object({
  confirmationToken: z.string().min(1),
});

// Consent update schema
export const ConsentSchema = z.object({
  consentType: z.string().min(1),
  granted: z.boolean(),
  subOptions: z.record(z.boolean()).optional(),
  metadata: z.record(z.any()).optional(),
});

// Search schema
export const SearchRequestSchema = z.object({
  query: z.string().min(1).max(500),
  n_results: z.number().int().min(1).max(100).optional().default(10),
  filter: z.record(z.any()).optional(),
});

// Traverse schema
export const TraverseSchema = z.object({
  start_id: z.string().uuid(),
  depth: z.number().int().min(1).max(10).optional().default(3),
  relationship_types: z.array(z.string()).optional(),
});

// Recall schema
export const RecallSchema = z.object({
  context: z.string().min(1).max(1000),
  max_memories: z.number().int().min(1).max(50).optional().default(5),
  weights: z.record(z.number()).optional(),
});

// Session end schema
export const SessionEndSchema = z.object({
  content: z.string().min(1).max(10000),
});

// Stats schema
export const StatsSchema = z.object({
  user_id: z.string().uuid(),
  org_id: z.string().uuid(),
});

// Health check schema
export const HealthCheckSchema = z.object({
  service: z.string().optional(),
});

/**
 * Validation middleware factory
 */
export function createValidator(schema) {
  return (req, res, next) => {
    try {
      const validated = schema.parse(req.body);
      req.validatedBody = validated;
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: 'Validation failed',
          message: 'Request validation error',
          details: error.errors.map(err => ({
            field: err.path.join('.'),
            message: err.message,
            code: err.code,
          })),
        });
        return;
      }
      next(error);
    }
  };
}

/**
 * Validate UUID parameter
 */
export function validateUUID(paramName) {
  return (req, res, next) => {
    const value = req.params[paramName] || req.query[paramName];

    if (!value || !z.string().uuid().safeParse(value).success) {
      res.status(400).json({
        error: 'Validation failed',
        message: `${paramName} must be a valid UUID`,
        details: [{
          field: paramName,
          message: 'Must be a valid UUID',
          code: 'invalid_string',
        }],
      });
      return;
    }

    next();
  };
}

/**
 * Validate required fields
 */
export function validateRequired(fields) {
  return (req, res, next) => {
    const missing = fields.filter(field => {
      const value = req.body?.[field] ?? req.query?.[field];
      return value === undefined || value === null || value === '';
    });

    if (missing.length > 0) {
      res.status(400).json({
        error: 'Validation failed',
        message: 'Required fields are missing',
        details: missing.map(field => ({
          field,
          message: 'Field is required',
          code: 'required',
        })),
      });
      return;
    }

    next();
  };
}

/**
 * Validate email format
 */
export function validateEmail(paramName = 'email') {
  return (req, res, next) => {
    const value = req.body?.[paramName] || req.query?.[paramName];

    if (value && !z.string().email().safeParse(value).success) {
      res.status(400).json({
        error: 'Validation failed',
        message: `${paramName} must be a valid email address`,
        details: [{
          field: paramName,
          message: 'Must be a valid email address',
          code: 'invalid_string',
        }],
      });
      return;
    }

    next();
  };
}

/**
 * Validate password strength
 */
export function validatePasswordStrength(paramName = 'password') {
  return (req, res, next) => {
    const value = req.body?.[paramName];

    if (!value) {
      next();
      return;
    }

    const errors = [];

    if (value.length < 8) {
      errors.push('Password must be at least 8 characters');
    }

    if (!/[A-Z]/.test(value)) {
      errors.push('Password must contain at least one uppercase letter');
    }

    if (!/[a-z]/.test(value)) {
      errors.push('Password must contain at least one lowercase letter');
    }

    if (!/[0-9]/.test(value)) {
      errors.push('Password must contain at least one number');
    }

    if (errors.length > 0) {
      res.status(400).json({
        error: 'Validation failed',
        message: 'Password does not meet strength requirements',
        details: errors.map(message => ({
          field: paramName,
          message,
          code: 'invalid_string',
        })),
      });
      return;
    }

    next();
  };
}

/**
 * Validate string length
 */
export function validateStringLength(paramName, options = {}) {
  const { min = 1, max = 255 } = options;

  return (req, res, next) => {
    const value = req.body?.[paramName] || req.query?.[paramName];

    if (value === undefined || value === null) {
      next();
      return;
    }

    if (typeof value !== 'string') {
      res.status(400).json({
        error: 'Validation failed',
        message: `${paramName} must be a string`,
        details: [{
          field: paramName,
          message: 'Must be a string',
          code: 'invalid_type',
        }],
      });
      return;
    }

    if (value.length < min) {
      res.status(400).json({
        error: 'Validation failed',
        message: `${paramName} must be at least ${min} characters`,
        details: [{
          field: paramName,
          message: `Must be at least ${min} characters`,
          code: 'too_small',
        }],
      });
      return;
    }

    if (value.length > max) {
      res.status(400).json({
        error: 'Validation failed',
        message: `${paramName} must be at most ${max} characters`,
        details: [{
          field: paramName,
          message: `Must be at most ${max} characters`,
          code: 'too_big',
        }],
      });
      return;
    }

    next();
  };
}

/**
 * Validate number range
 */
export function validateNumberRange(paramName, options = {}) {
  const { min, max } = options;

  return (req, res, next) => {
    const value = req.body?.[paramName] || req.query?.[paramName];

    if (value === undefined || value === null) {
      next();
      return;
    }

    const numberValue = Number(value);

    if (isNaN(numberValue)) {
      res.status(400).json({
        error: 'Validation failed',
        message: `${paramName} must be a number`,
        details: [{
          field: paramName,
          message: 'Must be a number',
          code: 'invalid_type',
        }],
      });
      return;
    }

    if (min !== undefined && numberValue < min) {
      res.status(400).json({
        error: 'Validation failed',
        message: `${paramName} must be at least ${min}`,
        details: [{
          field: paramName,
          message: `Must be at least ${min}`,
          code: 'too_small',
        }],
      });
      return;
    }

    if (max !== undefined && numberValue > max) {
      res.status(400).json({
        error: 'Validation failed',
        message: `${paramName} must be at most ${max}`,
        details: [{
          field: paramName,
          message: `Must be at most ${max}`,
          code: 'too_big',
        }],
      });
      return;
    }

    next();
  };
}

/**
 * Validate enum value
 */
export function validateEnum(paramName, enumValues) {
  return (req, res, next) => {
    const value = req.body?.[paramName] || req.query?.[paramName];

    if (value === undefined || value === null) {
      next();
      return;
    }

    if (!enumValues.includes(value)) {
      res.status(400).json({
        error: 'Validation failed',
        message: `${paramName} must be one of: ${enumValues.join(', ')}`,
        details: [{
          field: paramName,
          message: `Must be one of: ${enumValues.join(', ')}`,
          code: 'invalid_enum_value',
        }],
      });
      return;
    }

    next();
  };
}

/**
 * Validate array items
 */
export function validateArrayItems(paramName, itemValidator) {
  return (req, res, next) => {
    const value = req.body?.[paramName] || req.query?.[paramName];

    if (value === undefined || value === null) {
      next();
      return;
    }

    if (!Array.isArray(value)) {
      res.status(400).json({
        error: 'Validation failed',
        message: `${paramName} must be an array`,
        details: [{
          field: paramName,
          message: 'Must be an array',
          code: 'invalid_type',
        }],
      });
      return;
    }

    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      const result = itemValidator(item);

      if (!result.valid) {
        res.status(400).json({
          error: 'Validation failed',
          message: `Array item at index ${i} is invalid`,
          details: [{
            field: `${paramName}[${i}]`,
            message: result.message,
            code: 'invalid_item',
          }],
        });
        return;
      }
    }

    next();
  };
}

/**
 * Async validation helper
 */
export async function validateAsync(schema, data) {
  try {
    return {
      valid: true,
      data: await schema.parseAsync(data),
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        valid: false,
        errors: error.errors,
      };
    }
    throw error;
  }
}

export default {
  ValidationError,
  validateBody,
  validateQuery,
  validateParams,
  validateHeaders,
  validateRequest,
  createValidator,
  validateUUID,
  validateRequired,
  validateEmail,
  validatePasswordStrength,
  validateStringLength,
  validateNumberRange,
  validateEnum,
  validateArrayItems,
  validateAsync,
  // Common schemas
  UUIDSchema,
  EmailSchema,
  PasswordSchema,
  StringSchema,
  NumberSchema,
  BooleanSchema,
  ArraySchema,
  ObjectSchema,
  DateSchema,
  PaginationSchema,
  SortSchema,
  SearchSchema,
  FilterSchema,
  PaginationQuerySchema,
  SortQuerySchema,
  LoginSchema,
  RegisterSchema,
  MemorySchema,
  MemoryUpdateSchema,
  PlatformIntegrationSchema,
  ExportRequestSchema,
  ErasureRequestSchema,
  CancelErasureSchema,
  ConsentSchema,
  SearchRequestSchema,
  TraverseSchema,
  RecallSchema,
  SessionEndSchema,
  StatsSchema,
  HealthCheckSchema,
};
