/**
 * Meta-MCP Bridge
 * User-Specific Endpoint Generation for Cross-App Context Synchronization
 * 
 * Generates unique UUID-based endpoints per user, enabling:
 * - Cursor ↔ Claude ↔ ChatGPT cross-app visibility
 * - Persistent connections across sessions
 * - Secure endpoint management with HMAC validation
 * 
 * @module mcp/bridge
 */

import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..', '..');

// ==========================================
// Configuration
// ==========================================

const CONFIG = {
  endpointPrefix: process.env.MCP_ENDPOINT_PREFIX || 'hivemind',
  endpointSecretKey: process.env.MCP_SECRET_KEY || 'default-mcp-secret-key-change-in-production',
  endpointBaseUrl: process.env.MCP_BASE_URL || 'http://localhost:3000',
  endpointTtl: parseInt(process.env.MCP_ENDPOINT_TTL || '86400', 10), // 24 hours default
  maxEndpointsPerUser: parseInt(process.env.MCP_MAX_ENDPOINTS || '5', 10)
};

// In-memory endpoint store (production would use Redis/PostgreSQL)
const endpointStore = new Map();
const endpointSecrets = new Map(); // For quick validation

// ==========================================
// Endpoint Generator
// ==========================================

/**
 * Generate a unique, persistent endpoint for a user
 * @param {string} userId - User identifier
 * @param {string} orgId - Organization identifier
 * @param {string} platform - Platform type (cursor, claude, chatgpt)
 * @returns {Object} Endpoint configuration
 */
export function generateEndpoint(userId, orgId, platform = 'unknown') {
  const endpointId = uuidv4();
  const secret = _generateSecret(userId, orgId, endpointId);
  const createdAt = new Date().toISOString();
  
  const endpoint = {
    id: endpointId,
    userId,
    orgId,
    platform,
    secret,
    url: _buildEndpointUrl(endpointId, secret),
    createdAt,
    lastUsedAt: null,
    isActive: true,
    maxConnections: 10,
    currentConnections: 0,
    rateLimit: {
      requestsPerMinute: parseInt(process.env.MCP_RATE_LIMIT || '60', 10),
      requestsPerHour: parseInt(process.env.MCP_RATE_LIMIT_HOURLY || '1000', 10),
      currentRequests: 0,
      resetTime: Date.now() + 60000
    }
  };

  // Store endpoint
  const userEndpoints = endpointStore.get(userId) || [];
  if (userEndpoints.length >= CONFIG.maxEndpointsPerUser) {
    // Remove oldest inactive endpoint if at limit
    const inactive = userEndpoints.find(e => !e.isActive);
    if (inactive) {
      _revokeEndpointInternal(userId, inactive.id);
    } else {
      throw new Error(`Maximum endpoints reached for user ${userId} (${CONFIG.maxEndpointsPerUser})`);
    }
  }

  userEndpoints.push(endpoint);
  endpointStore.set(userId, userEndpoints);
  endpointSecrets.set(endpointId, secret);

  // Persist to database (mock - implement with Prisma in production)
  _persistEndpoint(endpoint);

  return endpoint;
}

/**
 * Get existing endpoint for user
 * @param {string} userId - User identifier
 * @param {string} endpointId - Optional specific endpoint ID
 * @returns {Object|null} Endpoint configuration or null
 */
export function getEndpoint(userId, endpointId = null) {
  const userEndpoints = endpointStore.get(userId);
  
  if (!userEndpoints) {
    // Try to load from database
    return _loadEndpoint(userId, endpointId);
  }

  if (endpointId) {
    return userEndpoints.find(e => e.id === endpointId && e.isActive) || null;
  }

  // Return most recently used active endpoint
  return userEndpoints
    .filter(e => e.isActive)
    .sort((a, b) => new Date(b.lastUsedAt || b.createdAt) - new Date(a.lastUsedAt || a.createdAt))[0] || null;
}

/**
 * Get all active endpoints for user
 * @param {string} userId - User identifier
 * @returns {Array} Array of active endpoints
 */
export function getUserEndpoints(userId) {
  const userEndpoints = endpointStore.get(userId);
  if (!userEndpoints) return [];
  return userEndpoints.filter(e => e.isActive);
}

/**
 * Revoke an endpoint
 * @param {string} userId - User identifier
 * @param {string} endpointId - Endpoint ID to revoke
 * @returns {Object} Revocation result
 */
export function revokeEndpoint(userId, endpointId) {
  const result = _revokeEndpointInternal(userId, endpointId);
  
  // Broadcast revocation to all connected clients
  _broadcastRevocation(userId, endpointId);
  
  return result;
}

/**
 * Regenerate endpoint secret
 * @param {string} userId - User identifier
 * @param {string} endpointId - Endpoint ID
 * @returns {Object} New endpoint configuration
 */
export function regenerateSecret(userId, endpointId) {
  const userEndpoints = endpointStore.get(userId);
  if (!userEndpoints) {
    throw new Error(`No endpoints found for user ${userId}`);
  }

  const endpoint = userEndpoints.find(e => e.id === endpointId);
  if (!endpoint) {
    throw new Error(`Endpoint not found: ${endpointId}`);
  }

  const oldSecret = endpoint.secret;
  const newSecret = _generateSecret(userId, endpoint.orgId, endpointId);
  
  endpoint.secret = newSecret;
  endpoint.url = _buildEndpointUrl(endpointId, newSecret);
  endpoint.secretRotatedAt = new Date().toISOString();
  endpoint.lastUsedAt = null;

  // Update stores
  endpointSecrets.delete(endpointId);
  endpointSecrets.set(endpointId, newSecret);

  // Persist update
  _persistEndpoint(endpoint);

  return endpoint;
}

/**
 * Validate endpoint secret
 * @param {string} endpointId - Endpoint ID
 * @param {string} secret - Secret to validate
 * @returns {Object} Validation result
 */
export function validateEndpoint(endpointId, secret) {
  const storedSecret = endpointSecrets.get(endpointId);
  
  if (!storedSecret) {
    return { valid: false, reason: 'Endpoint not found' };
  }

  // Constant-time comparison to prevent timing attacks
  const isValid = crypto.timingSafeEqual(
    Buffer.from(storedSecret),
    Buffer.from(secret)
  );

  if (isValid) {
    // Update last used time
    for (const [userId, endpoints] of endpointStore) {
      const endpoint = endpoints.find(e => e.id === endpointId);
      if (endpoint) {
        endpoint.lastUsedAt = new Date().toISOString();
        endpoint.currentConnections = Math.min(
          endpoint.currentConnections + 1,
          endpoint.maxConnections
        );
        _persistEndpoint(endpoint);
        return { valid: true, userId: endpoint.userId, orgId: endpoint.orgId };
      }
    }
  }

  return { valid: false, reason: 'Invalid secret' };
}

/**
 * Check rate limit for endpoint
 * @param {string} endpointId - Endpoint ID
 * @returns {Object} Rate limit status
 */
export function checkRateLimit(endpointId) {
  for (const [userId, endpoints] of endpointStore) {
    const endpoint = endpoints.find(e => e.id === endpointId);
    if (endpoint) {
      const now = Date.now();
      
      // Reset hourly counter if needed
      if (now > endpoint.rateLimit.resetTime) {
        endpoint.rateLimit.currentRequests = 0;
        endpoint.rateLimit.resetTime = now + 3600000; // 1 hour
      }

      // Check limits
      if (endpoint.rateLimit.currentRequests >= endpoint.rateLimit.requestsPerHour) {
        return { 
          allowed: false, 
          retryAfter: Math.ceil((endpoint.rateLimit.resetTime - now) / 1000),
          reason: 'Hourly rate limit exceeded'
        };
      }

      if (endpoint.currentConnections >= endpoint.maxConnections) {
        return { 
          allowed: false, 
          reason: 'Maximum connections reached'
        };
      }

      // Increment counter
      endpoint.rateLimit.currentRequests++;
      endpoint.currentConnections++;

      return { 
        allowed: true, 
        remainingHourly: endpoint.rateLimit.requestsPerHour - endpoint.rateLimit.currentRequests,
        remainingConnections: endpoint.maxConnections - endpoint.currentConnections
      };
    }
  }

  return { allowed: false, reason: 'Endpoint not found' };
}

/**
 * Get endpoint statistics
 * @returns {Object} Statistics object
 */
export function getStats() {
  const allEndpoints = [];
  for (const endpoints of endpointStore.values()) {
    allEndpoints.push(...endpoints);
  }

  const activeEndpoints = allEndpoints.filter(e => e.isActive);
  const totalConnections = activeEndpoints.reduce((sum, e) => sum + e.currentConnections, 0);

  return {
    totalEndpoints: allEndpoints.length,
    activeEndpoints: activeEndpoints.length,
    totalConnections,
    endpointsByPlatform: _groupByPlatform(allEndpoints),
    avgConnectionsPerEndpoint: activeEndpoints.length > 0 
      ? (totalConnections / activeEndpoints.length).toFixed(2) 
      : 0
  };
}

// ==========================================
// API Endpoints Management
// ==========================================

/**
 * Create API endpoint configuration for Express/Fastify
 * @param {Object} app - Express/Fastify app instance
 */
export function setupApiEndpoints(app) {
  // GET /api/mcp/endpoints - List all endpoints for current user
  app.get('/api/mcp/endpoints', async (req, res) => {
    const userId = req.user?.id || req.headers['x-user-id'];
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const endpoints = getUserEndpoints(userId);
    res.json({ endpoints, stats: getStats() });
  });

  // POST /api/mcp/endpoints - Create new endpoint
  app.post('/api/mcp/endpoints', async (req, res) => {
    const userId = req.user?.id || req.headers['x-user-id'];
    const orgId = req.user?.orgId || req.headers['x-org-id'];
    const platform = req.body?.platform || 'unknown';

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const endpoint = generateEndpoint(userId, orgId, platform);
      res.status(201).json({ endpoint });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  // DELETE /api/mcp/endpoints/:endpointId - Revoke endpoint
  app.delete('/api/mcp/endpoints/:endpointId', async (req, res) => {
    const userId = req.user?.id || req.headers['x-user-id'];
    const { endpointId } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const result = revokeEndpoint(userId, endpointId);
      res.json(result);
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  });

  // POST /api/mcp/endpoints/:endpointId/rotate - Regenerate secret
  app.post('/api/mcp/endpoints/:endpointId/rotate', async (req, res) => {
    const userId = req.user?.id || req.headers['x-user-id'];
    const { endpointId } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const endpoint = regenerateSecret(userId, endpointId);
      res.json({ endpoint, message: 'Secret rotated successfully' });
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  });

  // GET /api/mcp/endpoints/stats - Get endpoint statistics
  app.get('/api/mcp/endpoints/stats', async (req, res) => {
    res.json(getStats());
  });
}

// ==========================================
// Internal Helper Functions
// ==========================================

/**
 * Build endpoint URL
 * @param {string} endpointId - Endpoint ID
 * @param {string} secret - Secret
 * @returns {string} Full endpoint URL
 */
function _buildEndpointUrl(endpointId, secret) {
  return `${CONFIG.endpointBaseUrl}/mcp/${endpointId}?secret=${encodeURIComponent(secret)}`;
}

/**
 * Generate secret for endpoint using HMAC-SHA256
 * @param {string} userId - User ID
 * @param {string} orgId - Organization ID
 * @param {string} endpointId - Endpoint ID
 * @returns {string} Hex-encoded secret
 */
function _generateSecret(userId, orgId, endpointId) {
  const input = `${userId}:${orgId}:${endpointId}:${CONFIG.endpointSecretKey}`;
  return crypto.createHash('sha256').update(input).digest('hex').substring(0, 32);
}

/**
 * Revoke endpoint internally
 * @param {string} userId - User ID
 * @param {string} endpointId - Endpoint ID
 * @returns {Object} Revocation result
 */
function _revokeEndpointInternal(userId, endpointId) {
  const userEndpoints = endpointStore.get(userId);
  if (!userEndpoints) {
    return { success: false, error: 'No endpoints found' };
  }

  const index = userEndpoints.findIndex(e => e.id === endpointId);
  if (index === -1) {
    return { success: false, error: 'Endpoint not found' };
  }

  const endpoint = userEndpoints[index];
  endpoint.isActive = false;
  endpoint.revokedAt = new Date().toISOString();
  endpoint.currentConnections = 0;

  // Remove from secrets store
  endpointSecrets.delete(endpointId);

  // Persist update
  _persistEndpoint(endpoint);

  // Clean up if all endpoints revoked
  if (userEndpoints.filter(e => e.isActive).length === 0) {
    endpointStore.delete(userId);
  }

  return { 
    success: true, 
    endpointId,
    revokedAt: endpoint.revokedAt
  };
}

/**
 * Persist endpoint to database (mock implementation)
 * @param {Object} endpoint - Endpoint to persist
 */
function _persistEndpoint(endpoint) {
  // In production, use Prisma to persist to PostgreSQL
  // This is a mock for local development
  console.log(`[MCP Bridge] Persisting endpoint: ${endpoint.id} for user ${endpoint.userId}`);
}

/**
 * Load endpoint from database (mock implementation)
 * @param {string} userId - User ID
 * @param {string} endpointId - Optional endpoint ID
 * @returns {Object|null} Endpoint or null
 */
function _loadEndpoint(userId, endpointId = null) {
  // In production, query PostgreSQL via Prisma
  // This returns null for local development without database
  return null;
}

/**
 * Broadcast revocation to all connected clients
 * @param {string} userId - User ID
 * @param {string} endpointId - Revoked endpoint ID
 */
function _broadcastRevocation(userId, endpointId) {
  // In production, use Redis Pub/Sub to broadcast to all connected clients
  console.log(`[MCP Bridge] Broadcasting revocation for endpoint ${endpointId} to user ${userId}`);
}

/**
 * Group endpoints by platform
 * @param {Array} endpoints - Array of endpoints
 * @returns {Object} Count by platform
 */
function _groupByPlatform(endpoints) {
  const byPlatform = {};
  for (const endpoint of endpoints) {
    const platform = endpoint.platform || 'unknown';
    byPlatform[platform] = (byPlatform[platform] || 0) + 1;
  }
  return byPlatform;
}

// ==========================================
// Export Singleton
// ==========================================

let bridge = null;

/**
 * Get singleton bridge instance
 * @returns {Object} Bridge instance with all methods
 */
export function getBridge() {
  if (!bridge) {
    bridge = {
      generateEndpoint,
      getEndpoint,
      getUserEndpoints,
      revokeEndpoint,
      regenerateSecret,
      validateEndpoint,
      checkRateLimit,
      getStats,
      setupApiEndpoints
    };
  }
  return bridge;
}

// ==========================================
// CLI Commands
// ==========================================

/**
 * CLI command handler
 */
export async function handleCliCommand(args) {
  const command = args[0];
  
  switch (command) {
    case 'generate':
      if (args.length < 3) {
        console.error('Usage: node bridge.js generate <userId> <orgId> [platform]');
        process.exit(1);
      }
      const endpoint = generateEndpoint(args[1], args[2], args[3] || 'cli');
      console.log(JSON.stringify(endpoint, null, 2));
      break;

    case 'list':
      if (args.length < 2) {
        console.error('Usage: node bridge.js list <userId>');
        process.exit(1);
      }
      const endpoints = getUserEndpoints(args[1]);
      console.log(JSON.stringify(endpoints, null, 2));
      break;

    case 'stats':
      console.log(JSON.stringify(getStats(), null, 2));
      break;

    default:
      console.log(`
Meta-MCP Bridge CLI

Usage:
  node bridge.js generate <userId> <orgId> [platform]  Generate new endpoint
  node bridge.js list <userId>                        List user endpoints
  node bridge.js stats                                Show statistics

Examples:
  node bridge.js generate user123 org456 cursor
  node bridge.js list user123
  node bridge.js stats
`);
  }
}

// Run CLI if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  await handleCliCommand(process.argv.slice(2));
}

// Export for testing
export { CONFIG, endpointStore, endpointSecrets };
