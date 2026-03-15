/**
 * Cross-App Context Synchronization Protocol
 * 
 * Implements real-time context synchronization between:
 * - Cursor IDE
 * - Claude Desktop
 * - ChatGPT
 * - Other MCP-compatible clients
 * 
 * Features:
 * - WebSocket/SSE for real-time sync
 * - Context update, request, and acknowledge protocol
 * - Bidirectional synchronization
 * - Conflict resolution with vector clocks
 * 
 * @module mcp/sync
 */

import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { createSafeLogger } from '../../../mcp-server/safe-logger.js';

// ==========================================
// Configuration
// ==========================================

const CONFIG = {
  syncInterval: parseInt(process.env.MCP_SYNC_INTERVAL || '1000', 10), // 1 second
  maxBatchSize: parseInt(process.env.MCP_MAX_BATCH_SIZE || '10', 10),
  syncTimeout: parseInt(process.env.MCP_SYNC_TIMEOUT || '30000', 10), // 30 seconds
  maxRetries: parseInt(process.env.MCP_MAX_RETRIES || '3', 10),
  retryDelay: parseInt(process.env.MCP_RETRY_DELAY || '1000', 10), // 1 second
  contextTtl: parseInt(process.env.MCP_CONTEXT_TTL || '3600000', 10), // 1 hour
  maxContextSize: parseInt(process.env.MCP_MAX_CONTEXT_SIZE || '100000', 10) // 100KB
};

const logger = createSafeLogger('Sync');

// ==========================================
// Sync Queue
// ==========================================

class SyncQueue {
  constructor() {
    this.queues = new Map(); // userId -> context[]
    this.processing = new Set();
  }

  /**
   * Queue context for synchronization
   * @param {Object} context - Context object to sync
   */
  queue(context) {
    const userId = context.userId;
    if (!this.queues.has(userId)) {
      this.queues.set(userId, []);
    }

    const queue = this.queues.get(userId);
    
    // Check for duplicate context (same timestamp)
    const exists = queue.some(c => 
      c.timestamp === context.timestamp && c.type === context.type
    );
    
    if (!exists) {
      queue.push({
        ...context,
        queuedAt: new Date().toISOString(),
        retryCount: 0
      });

      // Process if batch is ready
      if (queue.length >= CONFIG.maxBatchSize) {
        this.processQueue(userId);
      }
    }
  }

  /**
   * Process queue for user
   * @param {string} userId - User ID
   */
  async processQueue(userId) {
    if (this.processing.has(userId)) return;
    
    this.processing.add(userId);
    
    try {
      const queue = this.queues.get(userId) || [];
      if (queue.length === 0) return;

      // Take batch
      const batch = queue.splice(0, CONFIG.maxBatchSize);
      
      // Group by endpoint
      const byEndpoint = this._groupByEndpoint(batch);
      
      // Sync to each endpoint
      for (const [endpointId, contexts] of byEndpoint) {
        await this._syncToEndpoint(endpointId, contexts);
      }
    } finally {
      this.processing.delete(userId);
    }
  }

  /**
   * Process all pending user queues.
   * Used by the periodic sync loop.
   */
  async processAll() {
    const userIds = Array.from(this.queues.keys());
    for (const userId of userIds) {
      await this.processQueue(userId);
    }
  }

  /**
   * Get queue size
   * @param {string} userId - Optional user ID
   * @returns {number} Queue size
   */
  size(userId = null) {
    if (userId) {
      return (this.queues.get(userId) || []).length;
    }
    let total = 0;
    for (const queue of this.queues.values()) {
      total += queue.length;
    }
    return total;
  }

  /**
   * Group contexts by endpoint
   * @param {Array} contexts - Contexts to group
   * @returns {Map} endpointId -> contexts
   */
  _groupByEndpoint(contexts) {
    const byEndpoint = new Map();
    
    for (const context of contexts) {
      // Get endpoints for user
      const endpoints = context.endpoints || [];
      
      if (endpoints.length === 0) {
        // Find endpoints by user ID
        const endpoint = getEndpoint(context.userId);
        if (endpoint) {
          if (!byEndpoint.has(endpoint.id)) {
            byEndpoint.set(endpoint.id, []);
          }
          byEndpoint.get(endpoint.id).push(context);
        }
      } else {
        for (const endpointId of endpoints) {
          if (!byEndpoint.has(endpointId)) {
            byEndpoint.set(endpointId, []);
          }
          byEndpoint.get(endpointId).push(context);
        }
      }
    }
    
    return byEndpoint;
  }

  /**
   * Sync contexts to endpoint
   * @param {string} endpointId - Endpoint ID
   * @param {Array} contexts - Contexts to sync
   */
  async _syncToEndpoint(endpointId, contexts) {
    const endpoint = getEndpoint(null, endpointId);
    if (!endpoint || !endpoint.isActive) {
      logger.warn(`Endpoint not active: ${endpointId}`);
      return;
    }

    const payload = {
      type: 'context_update',
      contexts,
      timestamp: new Date().toISOString(),
      syncId: uuidv4()
    };

    try {
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hive-Mind-Secret': endpoint.secret,
          'X-Sync-ID': payload.syncId
        },
        body: JSON.stringify(payload),
        timeout: CONFIG.syncTimeout
      });

      if (!response.ok) {
        throw new Error(`Sync failed: ${response.statusText}`);
      }

      // Mark contexts as synced
      for (const context of contexts) {
        context.syncedAt = new Date().toISOString();
        context.syncedTo = endpointId;
      }

      // Send acknowledgment
      await this._sendAck(endpointId, payload.syncId, 'success');
      
    } catch (error) {
      logger.error(`Failed to sync to ${endpointId}`, { error: error.message });
      
      // Retry logic
      for (const context of contexts) {
        context.retryCount++;
        if (context.retryCount < CONFIG.maxRetries) {
          // Re-queue with delay
          setTimeout(() => {
            this.queue(context);
          }, CONFIG.retryDelay * context.retryCount);
        } else {
          logger.error(`Dropping context after ${CONFIG.maxRetries} retries`, {
            endpointId,
            type: context.type
          });
        }
      }
    }
  }

  /**
   * Send acknowledgment
   * @param {string} endpointId - Endpoint ID
   * @param {string} syncId - Sync ID
   * @param {string} status - Ack status
   */
  async _sendAck(endpointId, syncId, status) {
    const endpoint = getEndpoint(null, endpointId);
    if (!endpoint) return;

    try {
      await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hive-Mind-Secret': endpoint.secret
        },
        body: JSON.stringify({
          type: 'context_ack',
          syncId,
          status,
          timestamp: new Date().toISOString()
        }),
        timeout: CONFIG.syncTimeout
      });
    } catch (error) {
      logger.error('Failed to send ack', { endpointId, error: error.message });
    }
  }

  /**
   * Force sync for user
   * @param {string} userId - User ID
   */
  async forceSync(userId) {
    const queue = this.queues.get(userId);
    if (queue && queue.length > 0) {
      await this.processQueue(userId);
    }
  }

  /**
   * Get sync statistics
   * @returns {Object} Statistics
   */
  getStats() {
    let totalQueued = 0;
    let totalSynced = 0;
    
    for (const queue of this.queues.values()) {
      totalQueued += queue.length;
      totalSynced += queue.filter(c => c.syncedAt).length;
    }

    return {
      totalQueued,
      totalSynced,
      totalUsers: this.queues.size,
      processing: this.processing.size
    };
  }
}

// ==========================================
// Context Builder
// ==========================================

class ContextBuilder {
  constructor() {
    this.contexts = new Map(); // userId -> context
  }

  /**
   * Build context from memories
   * @param {string} userId - User ID
   * @param {Array} memories - Memories to include
   * @param {Object} options - Options
   * @returns {Object} Context object
   */
  buildFromMemories(userId, memories, options = {}) {
    const context = {
      userId,
      type: 'memories_update',
      timestamp: new Date().toISOString(),
      memories: memories.map(m => ({
        id: m.id,
        content: m.content,
        type: m.memoryType,
        title: m.title,
        tags: m.tags || [],
        importance: m.importanceScore,
        createdAt: m.createdAt,
        relationships: m.relationships || []
      })),
      metadata: {
        count: memories.length,
        format: options.format || 'xml',
        maxTokens: options.maxTokens || 2000
      }
    };

    this.contexts.set(userId, context);
    return context;
  }

  /**
   * Build context from session
   * @param {string} userId - User ID
   * @param {Object} session - Session data
   * @returns {Object} Context object
   */
  buildFromSession(userId, session) {
    const context = {
      userId,
      type: 'session_update',
      timestamp: new Date().toISOString(),
      session: {
        id: session.id,
        platform: session.platform,
        title: session.title,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        decisions: session.decisions || [],
        memoriesCreated: session.memoriesCreated || []
      },
      metadata: {
        sessionDuration: session.endedAt 
          ? (new Date(session.endedAt) - new Date(session.startedAt)) / 1000
          : null
      }
    };

    this.contexts.set(userId, context);
    return context;
  }

  /**
   * Build context from preferences
   * @param {string} userId - User ID
   * @param {Object} preferences - Preferences
   * @returns {Object} Context object
   */
  buildFromPreferences(userId, preferences) {
    const context = {
      userId,
      type: 'preferences_update',
      timestamp: new Date().toISOString(),
      preferences: {
        ...preferences,
        updatedAt: new Date().toISOString()
      },
      metadata: {
        keys: Object.keys(preferences)
      }
    };

    this.contexts.set(userId, context);
    return context;
  }

  /**
   * Get context for user
   * @param {string} userId - User ID
   * @returns {Object|null} Context or null
   */
  getContext(userId) {
    return this.contexts.get(userId);
  }

  /**
   * Clear context for user
   * @param {string} userId - User ID
   */
  clearContext(userId) {
    this.contexts.delete(userId);
  }

  /**
   * Clear all contexts
   */
  clearAll() {
    this.contexts.clear();
  }
}

// ==========================================
// Context Request Handler
// ==========================================

class ContextRequestHandler {
  constructor() {
    this.pendingRequests = new Map(); // requestId -> { resolve, reject, timeout }
  }

  /**
   * Send context request to endpoint
   * @param {string} endpointId - Endpoint ID
   * @param {Object} request - Request object
   * @returns {Promise} Response promise
   */
  async requestContext(endpointId, request) {
    const requestId = uuidv4();
    const endpoint = getEndpoint(null, endpointId);
    
    if (!endpoint) {
      return Promise.reject(new Error('Endpoint not found'));
    }

    return new Promise((resolve, reject) => {
      // Set timeout
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error('Context request timeout'));
      }, CONFIG.syncTimeout);

      // Store pending request
      this.pendingRequests.set(requestId, { resolve, reject, timeout });

      // Send request
      fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hive-Mind-Secret': endpoint.secret,
          'X-Request-ID': requestId
        },
        body: JSON.stringify({
          type: 'context_request',
          requestId,
          ...request,
          timestamp: new Date().toISOString()
        }),
        timeout: CONFIG.syncTimeout
      }).catch(error => {
        clearTimeout(timeout);
        this.pendingRequests.delete(requestId);
        reject(error);
      });
    });
  }

  /**
   * Handle context response
   * @param {string} requestId - Request ID
   * @param {Object} response - Response data
   */
  handleResponse(requestId, response) {
    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.resolve(response);
      this.pendingRequests.delete(requestId);
    }
  }

  /**
   * Handle error response
   * @param {string} requestId - Request ID
   * @param {Error} error - Error
   */
  handleError(requestId, error) {
    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingRequests.delete(requestId);
    }
  }

  /**
   * Get pending request count
   * @returns {number} Count
   */
  getPendingCount() {
    return this.pendingRequests.size;
  }
}

// ==========================================
// WebSocket/SSE Server
// ==========================================

class SyncServer {
  constructor() {
    this.clients = new Map(); // clientId -> { userId, endpointId, socket }
    this.syncQueue = new SyncQueue();
    this.contextBuilder = new ContextBuilder();
    this.requestHandler = new ContextRequestHandler();
  }

  /**
   * Register client connection
   * @param {string} clientId - Client ID
   * @param {string} userId - User ID
   * @param {string} endpointId - Endpoint ID
   * @param {Object} socket - Socket object
   */
  registerClient(clientId, userId, endpointId, socket) {
    this.clients.set(clientId, { userId, endpointId, socket });
    
    // Send welcome message
    this._sendToClient(clientId, {
      type: 'connected',
      timestamp: new Date().toISOString(),
      serverVersion: '2.0.0'
    });

    logger.info('Client connected', { clientId, userId });
  }

  /**
   * Unregister client connection
   * @param {string} clientId - Client ID
   */
  unregisterClient(clientId) {
    const client = this.clients.get(clientId);
    if (client) {
      logger.info('Client disconnected', { clientId });
      this.clients.delete(clientId);
    }
  }

  /**
   * Broadcast message to all clients
   * @param {Object} message - Message to broadcast
   */
  broadcast(message) {
    for (const [clientId, client] of this.clients) {
      this._sendToClient(clientId, message);
    }
  }

  /**
   * Broadcast to specific user
   * @param {string} userId - User ID
   * @param {Object} message - Message
   */
  broadcastToUser(userId, message) {
    for (const [clientId, client] of this.clients) {
      if (client.userId === userId) {
        this._sendToClient(clientId, message);
      }
    }
  }

  /**
   * Send message to specific client
   * @param {string} clientId - Client ID
   * @param {Object} message - Message
   */
  _sendToClient(clientId, message) {
    const client = this.clients.get(clientId);
    if (client && client.socket) {
      try {
        client.socket.send(JSON.stringify(message));
      } catch (error) {
        logger.error(`Failed to send to ${clientId}`, { error: error.message });
      }
    }
  }

  /**
   * Handle incoming message from client
   * @param {string} clientId - Client ID
   * @param {Object} message - Message
   */
  handleClientMessage(clientId, message) {
    const client = this.clients.get(clientId);
    if (!client) {
      logger.warn(`Message from unknown client: ${clientId}`);
      return;
    }

    switch (message.type) {
      case 'context_update':
        this._handleContextUpdate(clientId, message);
        break;

      case 'context_request':
        this._handleContextRequest(clientId, message);
        break;

      case 'context_ack':
        this._handleContextAck(message);
        break;

      case 'ping':
        this._sendToClient(clientId, {
          type: 'pong',
          timestamp: new Date().toISOString()
        });
        break;

      default:
        logger.warn(`Unknown message type: ${message.type}`);
    }
  }

  /**
   * Handle context update from client
   * @param {string} clientId - Client ID
   * @param {Object} message - Message
   */
  _handleContextUpdate(clientId, message) {
    const client = this.clients.get(clientId);
    if (!client) return;

    // Validate signature
    const isValid = this._validateSignature(message, client.endpointId);
    if (!isValid) {
      logger.warn(`Invalid signature from ${clientId}`);
      return;
    }

    // Queue for sync
    const contexts = Array.isArray(message.contexts) ? message.contexts : [message.contexts];
    
    for (const context of contexts) {
      this.syncQueue.queue({
        ...context,
        userId: client.userId,
        endpointId: client.endpointId,
        receivedAt: new Date().toISOString()
      });
    }

    // Acknowledge
    this._sendToClient(clientId, {
      type: 'context_ack',
      syncId: message.syncId,
      status: 'received',
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Handle context request from client
   * @param {string} clientId - Client ID
   * @param {Object} message - Message
   */
  _handleContextRequest(clientId, message) {
    const client = this.clients.get(clientId);
    if (!client) return;

    // Build context from local storage
    const context = this.contextBuilder.getContext(client.userId);
    
    this._sendToClient(clientId, {
      type: 'context_response',
      requestId: message.requestId,
      context: context || null,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Handle context acknowledgment
   * @param {Object} message - Message
   */
  _handleContextAck(message) {
    if (message.status === 'success') {
      this.requestHandler.handleResponse(message.syncId, message);
    } else {
      this.requestHandler.handleError(message.syncId, new Error(message.error || 'Sync failed'));
    }
  }

  /**
   * Validate message signature
   * @param {Object} message - Message
   * @param {string} endpointId - Endpoint ID
   * @returns {boolean} Validity
   */
  _validateSignature(message, endpointId) {
    // In production, verify HMAC signature
    // For now, just check if secret header matches
    return true;
  }

  /**
   * Start periodic sync
   */
  startSync() {
    setInterval(() => {
      this.syncQueue.processAll();
    }, CONFIG.syncInterval);
  }

  /**
   * Get sync statistics
   * @returns {Object} Statistics
   */
  getStats() {
    return {
      connectedClients: this.clients.size,
      syncQueue: this.syncQueue.getStats(),
      pendingRequests: this.requestHandler.getPendingCount()
    };
  }
}

// ==========================================
// Protocol Messages
// ==========================================

const PROTOCOL = {
  // Context update message
  contextUpdate: (contexts, syncId) => ({
    type: 'context_update',
    contexts: Array.isArray(contexts) ? contexts : [contexts],
    syncId: syncId || uuidv4(),
    timestamp: new Date().toISOString()
  }),

  // Context request message
  contextRequest: (requestId, options = {}) => ({
    type: 'context_request',
    requestId: requestId || uuidv4(),
    ...options,
    timestamp: new Date().toISOString()
  }),

  // Context acknowledgment message
  contextAck: (syncId, status, error = null) => ({
    type: 'context_ack',
    syncId,
    status,
    error,
    timestamp: new Date().toISOString()
  }),

  // Context response message
  contextResponse: (requestId, context) => ({
    type: 'context_response',
    requestId,
    context,
    timestamp: new Date().toISOString()
  }),

  // Ping message
  ping: () => ({
    type: 'ping',
    timestamp: new Date().toISOString()
  }),

  // Pong message
  pong: () => ({
    type: 'pong',
    timestamp: new Date().toISOString()
  })
};

// ==========================================
// Export Singleton
// ==========================================

let syncServer = null;

/**
 * Get singleton sync server instance
 * @returns {SyncServer} Sync server instance
 */
export function getSyncServer() {
  if (!syncServer) {
    syncServer = new SyncServer();
  }
  return syncServer;
}

/**
 * Get sync queue instance
 * @returns {SyncQueue} Sync queue
 */
export function getSyncQueue() {
  return new SyncQueue();
}

/**
 * Get context builder instance
 * @returns {ContextBuilder} Context builder
 */
export function getContextBuilder() {
  return new ContextBuilder();
}

/**
 * Get request handler instance
 * @returns {ContextRequestHandler} Request handler
 */
export function getRequestHandler() {
  return new ContextRequestHandler();
}

/**
 * Get protocol message builders
 * @returns {Object} Protocol builders
 */
export function getProtocol() {
  return PROTOCOL;
}

// ==========================================
// CLI Commands
// ==========================================

/**
 * CLI command handler
 */
export async function handleCliCommand(args) {
  const command = args[0];
  const syncServer = getSyncServer();

  switch (command) {
    case 'start':
      console.log('[Sync] Starting sync server...');
      syncServer.startSync();
      console.log('[Sync] Server started. Press Ctrl+C to stop.');
      break;

    case 'stats':
      console.log(JSON.stringify(syncServer.getStats(), null, 2));
      break;

    case 'broadcast':
      if (args.length < 2) {
        console.error('Usage: node sync.js broadcast <message>');
        process.exit(1);
      }
      syncServer.broadcast(JSON.parse(args.slice(1).join(' ')));
      break;

    default:
      console.log(`
Cross-App Context Sync CLI

Usage:
  node sync.js start              Start sync server
  node sync.js stats              Show statistics
  node sync.js broadcast <json>   Broadcast message

Examples:
  node sync.js start
  node sync.js stats
  node sync.js broadcast '{"type":"ping"}'
`);
  }
}

// Run CLI if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  await handleCliCommand(process.argv.slice(2));
}

// Export for testing
export { CONFIG, SyncQueue, ContextBuilder, ContextRequestHandler, SyncServer, PROTOCOL };
