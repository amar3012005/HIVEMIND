/**
 * API Key Service
 * HIVE-MIND Cross-Platform Context Sync
 * 
 * Manages API key lifecycle: creation, validation, revocation, and usage tracking
 * GDPR, NIS2, DORA compliant with audit logging
 * 
 * @module services/api-key.service
 */

import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { z } from 'zod';

const prisma = new PrismaClient();

// ==========================================
// ZOD SCHEMAS
// ==========================================

/**
 * Schema for creating a new API key
 */
export const createApiKeySchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  expiresAt: z.string().datetime().optional().or(z.date().optional()),
  scopes: z.array(z.enum(['read', 'write', 'admin', 'memories:read', 'memories:write', 'memories:delete'])).optional(),
  rateLimitPerMinute: z.number().int().positive().max(1000).optional()
});

/**
 * Schema for updating an API key
 */
export const updateApiKeySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional(),
  expiresAt: z.string().datetime().optional().or(z.date().optional()).nullable(),
  scopes: z.array(z.enum(['read', 'write', 'admin', 'memories:read', 'memories:write', 'memories:delete'])).optional(),
  rateLimitPerMinute: z.number().int().positive().max(1000).optional()
});

/**
 * Schema for revoking an API key
 */
export const revokeApiKeySchema = z.object({
  reason: z.string().max(255).optional()
});

// ==========================================
// CONSTANTS
// ==========================================

const API_KEY_PREFIX = 'hmk_';
const API_KEY_LENGTH = 32; // bytes

// ==========================================
// HELPER FUNCTIONS
// ==========================================

/**
 * Generate a secure random API key
 * @returns {string} The generated API key (e.g., "hmk_abc123...")
 */
export function generateApiKey() {
  const randomBytesData = randomBytes(API_KEY_LENGTH);
  const keyBody = randomBytesData.toString('base64url').slice(0, API_KEY_LENGTH);
  return `${API_KEY_PREFIX}${keyBody}`;
}

/**
 * Hash an API key for secure storage
 * @param {string} apiKey - The plain text API key
 * @returns {string} SHA-256 hash of the API key
 */
export function hashApiKey(apiKey) {
  return createHash('sha256').update(apiKey).digest('hex');
}

/**
 * Extract the prefix from an API key for identification
 * @param {string} apiKey - The plain text API key
 * @returns {string} First 14 characters (hmk_ + 8 chars)
 */
export function getKeyPrefix(apiKey) {
  return apiKey.slice(0, 14); // "hmk_" + first 10 chars of key body
}

/**
 * Parse ISO date string or return the date object
 * @param {string|Date|undefined} date - Date to parse
 * @returns {Date|undefined} Parsed date or undefined
 */
export function parseDate(date) {
  if (!date) return undefined;
  if (date instanceof Date) return date;
  return new Date(date);
}

// ==========================================
// SERVICE FUNCTIONS
// ==========================================

/**
 * Create a new API key for a user
 * 
 * @param {Object} params - Parameters for creating the API key
 * @param {string} params.userId - User ID who owns this key
 * @param {string} [params.orgId] - Optional organization ID
 * @param {string} params.name - Human-readable name for the key
 * @param {string} [params.description] - Optional description
 * @param {Date} [params.expiresAt] - Optional expiration date
 * @param {string[]} [params.scopes] - Permission scopes
 * @param {number} [params.rateLimitPerMinute] - Rate limit
 * @param {string} [params.createdByIp] - IP address of creator
 * @param {string} [params.userAgent] - User agent of creator
 * @returns {Promise<Object>} Created API key with plain text key (only returned once)
 * 
 * @throws {Error} If validation fails or database error occurs
 */
export async function createApiKey({
  userId,
  orgId = null,
  name,
  description = null,
  expiresAt = null,
  scopes = ['read', 'write'],
  rateLimitPerMinute = 60,
  createdByIp = null,
  userAgent = null
}) {
  // Validate input
  const validatedData = createApiKeySchema.parse({
    name,
    description,
    expiresAt,
    scopes,
    rateLimitPerMinute
  });

  // Generate the API key
  const plainTextKey = generateApiKey();
  const keyHash = hashApiKey(plainTextKey);
  const keyPrefix = getKeyPrefix(plainTextKey);

  // Parse expiration date
  const parsedExpiresAt = parseDate(expiresAt);

  // Create the API key in database
  const apiKey = await prisma.apiKey.create({
    data: {
      userId,
      orgId,
      name: validatedData.name,
      keyHash,
      keyPrefix,
      description: validatedData.description,
      expiresAt: parsedExpiresAt,
      scopes: validatedData.scopes || ['read', 'write'],
      rateLimitPerMinute: validatedData.rateLimitPerMinute || 60,
      createdByIp,
      userAgent
    },
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      expiresAt: true,
      scopes: true,
      rateLimitPerMinute: true,
      description: true,
      createdAt: true,
      updatedAt: true
    }
  });

  // Return the API key with the plain text key (only time it's shown)
  return {
    ...apiKey,
    key: plainTextKey // Only returned once, never stored
  };
}

/**
 * Validate an API key and return the associated user info
 * 
 * @param {string} apiKey - The plain text API key to validate
 * @returns {Promise<Object|null>} Validated key info with user details, or null if invalid
 * 
 * @description
 * This function:
 * 1. Hashes the provided API key
 * 2. Looks up the key in the database
 * 3. Checks if it's expired or revoked
 * 4. Updates last_used_at and usage_count
 * 5. Returns user info if valid
 */
export async function validateApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== 'string') {
    return null;
  }

  const keyHash = hashApiKey(apiKey);

  // Find the API key in database
  const dbKey = await prisma.apiKey.findFirst({
    where: {
      keyHash,
      revokedAt: null // Only non-revoked keys
    },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          displayName: true,
          deletedAt: true
        }
      },
      organization: {
        select: {
          id: true,
          name: true,
          slug: true
        }
      }
    }
  });

  if (!dbKey) {
    return null;
  }

  // Check if user is deleted
  if (dbKey.user.deletedAt) {
    return null;
  }

  // Check if key is expired
  if (dbKey.expiresAt && dbKey.expiresAt < new Date()) {
    return null;
  }

  // Update last_used_at and usage_count asynchronously (don't block auth)
  prisma.apiKey.update({
    where: { id: dbKey.id },
    data: {
      lastUsedAt: new Date(),
      usageCount: { increment: 1 }
    }
  }).catch(err => {
    console.error('[API_KEY_SERVICE] Failed to update last_used_at:', err);
  });

  // Return validated key info
  return {
    id: dbKey.id,
    userId: dbKey.userId,
    orgId: dbKey.orgId,
    scopes: dbKey.scopes,
    rateLimitPerMinute: dbKey.rateLimitPerMinute,
    user: {
      id: dbKey.user.id,
      email: dbKey.user.email,
      displayName: dbKey.user.displayName
    },
    organization: dbKey.organization ? {
      id: dbKey.organization.id,
      name: dbKey.organization.name,
      slug: dbKey.organization.slug
    } : null
  };
}

/**
 * Get an API key by ID (for management operations)
 * 
 * @param {string} keyId - API key ID
 * @param {string} userId - User ID for authorization check
 * @returns {Promise<Object|null>} API key details (without hash) or null
 */
export async function getApiKeyById(keyId, userId) {
  const apiKey = await prisma.apiKey.findFirst({
    where: {
      id: keyId,
      userId
    },
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      expiresAt: true,
      revokedAt: true,
      revokedReason: true,
      lastUsedAt: true,
      usageCount: true,
      scopes: true,
      rateLimitPerMinute: true,
      description: true,
      createdByIp: true,
      createdAt: true,
      updatedAt: true,
      organization: {
        select: {
          id: true,
          name: true,
          slug: true
        }
      }
    }
  });

  return apiKey;
}

/**
 * List all API keys for a user
 * 
 * @param {string} userId - User ID
 * @param {Object} [options] - Query options
 * @param {boolean} [options.includeRevoked=false] - Include revoked keys
 * @param {boolean} [options.includeExpired=false] - Include expired keys
 * @param {number} [options.limit=50] - Maximum number of results
 * @param {number} [options.offset=0] - Offset for pagination
 * @returns {Promise<Object[]>} List of API keys (without hash)
 */
export async function listApiKeys(userId, options = {}) {
  const {
    includeRevoked = false,
    includeExpired = false,
    limit = 50,
    offset = 0
  } = options;

  const where = { userId };

  // Filter revoked keys if not requested
  if (!includeRevoked) {
    where.revokedAt = null;
  }

  // Filter expired keys if not requested
  if (!includeExpired) {
    where.OR = [
      { expiresAt: null },
      { expiresAt: { gt: new Date() } }
    ];
  }

  const apiKeys = await prisma.apiKey.findMany({
    where,
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      expiresAt: true,
      revokedAt: true,
      revokedReason: true,
      lastUsedAt: true,
      usageCount: true,
      scopes: true,
      rateLimitPerMinute: true,
      description: true,
      createdAt: true,
      updatedAt: true,
      organization: {
        select: {
          id: true,
          name: true,
          slug: true
        }
      }
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: offset
  });

  return apiKeys;
}

/**
 * Revoke an API key
 * 
 * @param {string} keyId - API key ID
 * @param {string} userId - User ID for authorization check
 * @param {string} [reason] - Optional reason for revocation
 * @returns {Promise<Object>} Revoked API key details
 * @throws {Error} If key not found or unauthorized
 */
export async function revokeApiKey(keyId, userId, reason = null) {
  // Validate reason if provided
  if (reason) {
    revokeApiKeySchema.parse({ reason });
  }

  const apiKey = await prisma.apiKey.findFirst({
    where: {
      id: keyId,
      userId
    }
  });

  if (!apiKey) {
    throw new Error('API_KEY_NOT_FOUND');
  }

  if (apiKey.revokedAt) {
    throw new Error('API_KEY_ALREADY_REVOKED');
  }

  const updated = await prisma.apiKey.update({
    where: { id: keyId },
    data: {
      revokedAt: new Date(),
      revokedReason: reason
    },
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      revokedAt: true,
      revokedReason: true,
      expiresAt: true,
      scopes: true,
      createdAt: true
    }
  });

  return updated;
}

/**
 * Update an API key's metadata
 * 
 * @param {string} keyId - API key ID
 * @param {string} userId - User ID for authorization check
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>} Updated API key details
 * @throws {Error} If key not found, unauthorized, or validation fails
 */
export async function updateApiKey(keyId, userId, updates) {
  // Validate updates
  const validatedUpdates = updateApiKeySchema.parse(updates);

  const apiKey = await prisma.apiKey.findFirst({
    where: {
      id: keyId,
      userId
    }
  });

  if (!apiKey) {
    throw new Error('API_KEY_NOT_FOUND');
  }

  if (apiKey.revokedAt) {
    throw new Error('API_KEY_REVOKED_CANNOT_UPDATE');
  }

  // Build update data
  const updateData = {};

  if (validatedUpdates.name !== undefined) {
    updateData.name = validatedUpdates.name;
  }

  if (validatedUpdates.description !== undefined) {
    updateData.description = validatedUpdates.description;
  }

  if (validatedUpdates.scopes !== undefined) {
    updateData.scopes = validatedUpdates.scopes;
  }

  if (validatedUpdates.rateLimitPerMinute !== undefined) {
    updateData.rateLimitPerMinute = validatedUpdates.rateLimitPerMinute;
  }

  if (validatedUpdates.expiresAt !== undefined) {
    updateData.expiresAt = parseDate(validatedUpdates.expiresAt);
  }

  const updated = await prisma.apiKey.update({
    where: { id: keyId },
    data: updateData,
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      expiresAt: true,
      revokedAt: true,
      scopes: true,
      rateLimitPerMinute: true,
      description: true,
      createdAt: true,
      updatedAt: true
    }
  });

  return updated;
}

/**
 * Delete an API key permanently (hard delete)
 * Use revoke instead for audit trail compliance
 * 
 * @param {string} keyId - API key ID
 * @param {string} userId - User ID for authorization check
 * @returns {Promise<void>}
 * @throws {Error} If key not found or unauthorized
 * 
 * @deprecated Use revokeApiKey instead for NIS2/DORA compliance
 */
export async function deleteApiKey(keyId, userId) {
  const apiKey = await prisma.apiKey.findFirst({
    where: {
      id: keyId,
      userId
    }
  });

  if (!apiKey) {
    throw new Error('API_KEY_NOT_FOUND');
  }

  await prisma.apiKey.delete({
    where: { id: keyId }
  });
}

/**
 * Check if an API key has a specific scope
 * 
 * @param {Object} validatedKey - Validated API key from validateApiKey()
 * @param {string} requiredScope - Required scope to check
 * @returns {boolean} True if key has the required scope
 */
export function hasScope(validatedKey, requiredScope) {
  if (!validatedKey || !validatedKey.scopes) {
    return false;
  }

  // Admin scope grants all permissions
  if (validatedKey.scopes.includes('admin')) {
    return true;
  }

  return validatedKey.scopes.includes(requiredScope);
}

/**
 * Check if an API key has any of the required scopes
 * 
 * @param {Object} validatedKey - Validated API key from validateApiKey()
 * @param {string[]} requiredScopes - Array of required scopes
 * @returns {boolean} True if key has at least one required scope
 */
export function hasAnyScope(validatedKey, requiredScopes) {
  if (!validatedKey || !validatedKey.scopes) {
    return false;
  }

  // Admin scope grants all permissions
  if (validatedKey.scopes.includes('admin')) {
    return true;
  }

  return requiredScopes.some(scope => validatedKey.scopes.includes(scope));
}

/**
 * Get statistics about API keys for a user
 * 
 * @param {string} userId - User ID
 * @returns {Promise<Object>} API key statistics
 */
export async function getApiKeyStats(userId) {
  const [total, active, revoked, expired, expiringSoon] = await Promise.all([
    prisma.apiKey.count({
      where: { userId }
    }),
    prisma.apiKey.count({
      where: {
        userId,
        revokedAt: null,
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: new Date() } }
        ]
      }
    }),
    prisma.apiKey.count({
      where: {
        userId,
        revokedAt: { not: null }
      }
    }),
    prisma.apiKey.count({
      where: {
        userId,
        expiresAt: { lt: new Date() }
      }
    }),
    prisma.apiKey.count({
      where: {
        userId,
        revokedAt: null,
        expiresAt: {
          lte: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // Next 7 days
        }
      }
    })
  ]);

  return {
    total,
    active,
    revoked,
    expired,
    expiringSoon
  };
}

/**
 * Clean up expired API keys (maintenance task)
 * Run periodically to archive old keys
 * 
 * @param {number} daysSinceExpiry - Only archive keys expired more than this many days ago
 * @returns {Promise<number>} Number of keys archived
 */
export async function cleanupExpiredApiKeys(daysSinceExpiry = 30) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysSinceExpiry);

  const result = await prisma.apiKey.updateMany({
    where: {
      expiresAt: { lt: cutoffDate },
      revokedAt: null
    },
    data: {
      revokedAt: new Date(),
      revokedReason: 'AUTO_REVOKED_EXPIRED'
    }
  });

  return result.count;
}

export default {
  createApiKey,
  validateApiKey,
  getApiKeyById,
  listApiKeys,
  revokeApiKey,
  updateApiKey,
  deleteApiKey,
  hasScope,
  hasAnyScope,
  getApiKeyStats,
  cleanupExpiredApiKeys,
  // Helpers (exported for testing)
  generateApiKey,
  hashApiKey,
  getKeyPrefix,
  parseDate
};
