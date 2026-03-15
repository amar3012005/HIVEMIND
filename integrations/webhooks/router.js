/**
 * Webhook Router
 * 
 * Routes incoming webhooks to platform-specific handlers
 * Supports ChatGPT, Claude, Perplexity, Gemini, and generic webhooks
 * 
 * @module webhooks/router
 */

import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

// Logger
const logger = {
  info: (msg, ctx) => console.log(`[WEBHOOK ROUTER INFO] ${msg}`, ctx),
  warn: (msg, ctx) => console.warn(`[WEBHOOK ROUTER WARN] ${msg}`, ctx),
  error: (msg, ctx) => console.error(`[WEBHOOK ROUTER ERROR] ${msg}`, ctx)
};

// ==========================================
// Event Type Schemas
// ==========================================

const BaseWebhookSchema = z.object({
  type: z.string(),
  timestamp: z.string().datetime().optional(),
  platform: z.string().optional()
});

const ChatGPTWebhookSchema = BaseWebhookSchema.extend({
  type: z.enum([
    'conversation.started',
    'conversation.updated',
    'conversation.ended',
    'message.created',
    'action.invoked',
    'action.completed',
    'action.failed'
  ]),
  conversation_id: z.string(),
  user_id: z.string(),
  payload: z.record(z.unknown()).optional()
});

const ClaudeWebhookSchema = BaseWebhookSchema.extend({
  type: z.enum([
    'conversation.start',
    'conversation.message',
    'conversation.end',
    'tool.call',
    'tool.result'
  ]),
  conversation_id: z.string().uuid(),
  user_id: z.string(),
  payload: z.object({
    message: z.string().optional(),
    tool_name: z.string().optional(),
    tool_input: z.record(z.unknown()).optional()
  }).optional()
});

const PerplexityWebhookSchema = BaseWebhookSchema.extend({
  type: z.enum([
    'query.received',
    'response.generated',
    'session.started',
    'session.ended'
  ]),
  session_id: z.string(),
  user_id: z.string(),
  query: z.string().optional(),
  payload: z.record(z.unknown()).optional()
});

const GeminiWebhookSchema = BaseWebhookSchema.extend({
  type: z.enum([
    'message.received',
    'message.sent',
    'context.updated',
    'session.created',
    'session.deleted'
  ]),
  session_id: z.string(),
  user_id: z.string(),
  payload: z.record(z.unknown()).optional()
});

const GenericWebhookSchema = BaseWebhookSchema.extend({
  event: z.string(),
  data: z.record(z.unknown()),
  metadata: z.record(z.unknown()).optional()
});

// ==========================================
// Platform Handlers Registry
// ==========================================

const platformHandlers = new Map();

/**
 * Register a platform handler
 * 
 * @param {string} platform - Platform name
 * @param {object} handlers - Event handlers
 */
export function registerPlatformHandler(platform, handlers) {
  platformHandlers.set(platform, handlers);
  logger.info('Platform handler registered', { platform });
}

/**
 * Get platform handler
 * 
 * @param {string} platform - Platform name
 * @returns {object|null} Handler or null
 */
export function getPlatformHandler(platform) {
  return platformHandlers.get(platform) || null;
}

// ==========================================
// Event Routing
// ==========================================

/**
 * Detect platform from webhook payload and headers
 * 
 * @param {object} req - Express request
 * @returns {string} Platform name
 */
export function detectPlatform(req) {
  // Check URL path
  const path = req.path.toLowerCase();
  if (path.includes('chatgpt') || path.includes('chat-gpt')) {
    return 'chatgpt';
  }
  if (path.includes('claude')) {
    return 'claude';
  }
  if (path.includes('perplexity')) {
    return 'perplexity';
  }
  if (path.includes('gemini')) {
    return 'gemini';
  }

  // Check header
  const platformHeader = req.headers['x-webhook-platform'];
  if (platformHeader) {
    return platformHeader.toLowerCase();
  }

  // Check payload structure
  const body = req.body;
  if (body.conversation_id && body.tool_name) {
    return 'claude';
  }
  if (body.action?.id || body.action_id) {
    return 'chatgpt';
  }
  if (body.query && body.session_id) {
    return 'perplexity';
  }

  return 'generic';
}

/**
 * Validate webhook payload based on platform
 * 
 * @param {object} payload - Webhook payload
 * @param {string} platform - Platform name
 * @returns {object} Validated payload
 * @throws {Error} If validation fails
 */
export function validateWebhookPayload(payload, platform) {
  try {
    switch (platform) {
      case 'chatgpt':
        return ChatGPTWebhookSchema.parse(payload);
      case 'claude':
        return ClaudeWebhookSchema.parse(payload);
      case 'perplexity':
        return PerplexityWebhookSchema.parse(payload);
      case 'gemini':
        return GeminiWebhookSchema.parse(payload);
      default:
        return GenericWebhookSchema.parse(payload);
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      const details = error.errors.map(e => ({
        field: e.path.join('.'),
        message: e.message
      }));
      
      throw new Error(`Validation failed: ${details.map(d => `${d.field}: ${d.message}`).join(', ')}`);
    }
    throw error;
  }
}

/**
 * Route webhook to appropriate handler
 * 
 * @param {object} req - Express request
 * @param {object} res - Express response
 * @returns {Promise<object>} Handler result
 */
export async function routeWebhook(req, res) {
  const requestId = uuidv4();
  const startTime = Date.now();
  
  try {
    // Detect platform
    const platform = detectPlatform(req);
    
    logger.info('Webhook received', {
      requestId,
      platform,
      path: req.path,
      method: req.method
    });

    // Validate payload
    const validatedPayload = validateWebhookPayload(req.body, platform);
    
    // Get event type
    const eventType = validatedPayload.type || validatedPayload.event;
    
    logger.info('Webhook validated', {
      requestId,
      platform,
      eventType,
      userId: validatedPayload.user_id
    });

    // Get platform handler
    const handler = getPlatformHandler(platform);
    
    if (!handler) {
      logger.warn('No handler registered for platform', { platform });
      
      // Use default handler
      return await handleDefaultEvent(validatedPayload, platform, requestId);
    }

    // Get event-specific handler
    const eventHandler = handler[eventType] || handler.default || handler.handle;
    
    if (!eventHandler) {
      logger.warn('No handler for event type', { platform, eventType });
      
      return {
        status: 'ignored',
        reason: 'No handler registered for event type',
        eventType,
        platform
      };
    }

    // Execute handler
    const result = await eventHandler(validatedPayload, {
      requestId,
      platform,
      timestamp: new Date()
    });

    const latency = Date.now() - startTime;
    
    logger.info('Webhook processed', {
      requestId,
      platform,
      eventType,
      latencyMs: latency,
      status: result?.status || 'success'
    });

    return result;

  } catch (error) {
    const latency = Date.now() - startTime;
    
    if (error instanceof z.ZodError) {
      logger.warn('Webhook validation failed', {
        requestId,
        errors: error.errors,
        latencyMs: latency
      });
      
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: error.message,
        details: error.errors,
        requestId
      });
      return;
    }

    logger.error('Webhook routing failed', {
      requestId,
      error: error.message,
      stack: error.stack,
      latencyMs: latency
    });

    res.status(500).json({
      error: 'PROCESSING_ERROR',
      message: error.message,
      requestId,
      latencyMs: latency
    });
  }
}

// ==========================================
// Default Event Handler
// ==========================================

/**
 * Handle events without specific handlers
 * 
 * @param {object} payload - Webhook payload
 * @param {string} platform - Platform name
 * @param {string} requestId - Request ID
 * @returns {object} Handler result
 */
async function handleDefaultEvent(payload, platform, requestId) {
  logger.info('Default event handling', {
    requestId,
    platform,
    eventType: payload.type || payload.event
  });

  // Store event for later processing
  await storeWebhookEvent(payload, platform, requestId);

  return {
    status: 'queued',
    message: 'Event queued for processing',
    requestId,
    platform,
    eventType: payload.type || payload.event
  };
}

// ==========================================
// Express Router
// ==========================================

/**
 * Create Express router for webhooks
 * 
 * @param {object} options - Router options
 * @returns {function} Express router
 */
export function createWebhookRouter(options = {}) {
  const { 
    signatureVerification = true,
    rateLimit = true,
    logging = true 
  } = options;

  // Import Express
  const express = require('express');
  const router = express.Router();

  // Optional logging middleware
  if (logging) {
    router.use((req, res, next) => {
      req.webhookId = uuidv4();
      req.webhookReceivedAt = Date.now();
      
      logger.info('Webhook request', {
        webhookId: req.webhookId,
        path: req.path,
        method: req.method,
        headers: req.headers
      });
      
      next();
    });
  }

  // Main webhook endpoint
  router.post('/:platform?', async (req, res) => {
    await routeWebhook(req, res);
  });

  // Health check endpoint
  router.get('/health', (req, res) => {
    res.json({
      status: 'healthy',
      platforms: Array.from(platformHandlers.keys()),
      timestamp: new Date().toISOString()
    });
  });

  // Status endpoint
  router.get('/status', (req, res) => {
    res.json({
      status: 'operational',
      version: '1.0.0',
      uptime: process.uptime(),
      platforms: Array.from(platformHandlers.keys())
    });
  });

  return router;
}

// ==========================================
// Placeholder Functions (Implement based on your data layer)
// ==========================================

async function storeWebhookEvent(payload, platform, requestId) {
  // Implement with your database/queue
  console.log(`Storing webhook event: ${platform}/${payload.type || payload.event}`, { requestId });
}

// ==========================================
// Example Platform Handlers
// ==========================================

/**
 * Example ChatGPT handler registration
 */
export function registerChatGPThandler() {
  registerPlatformHandler('chatgpt', {
    'conversation.started': async (payload, context) => {
      logger.info('ChatGPT conversation started', context);
      // Handle conversation start
      return { status: 'processed' };
    },
    'conversation.ended': async (payload, context) => {
      logger.info('ChatGPT conversation ended', context);
      // Handle conversation end
      return { status: 'processed' };
    },
    'action.invoked': async (payload, context) => {
      logger.info('ChatGPT action invoked', context);
      // Handle action invocation
      return { status: 'processed' };
    }
  });
}

/**
 * Example Claude handler registration
 */
export function registerClaudeHandler() {
  registerPlatformHandler('claude', {
    'conversation.start': async (payload, context) => {
      logger.info('Claude conversation started', context);
      return { status: 'processed' };
    },
    'tool.call': async (payload, context) => {
      logger.info('Claude tool called', context);
      return { status: 'processed' };
    }
  });
}

// ==========================================
// Exports
// ==========================================

export default {
  routeWebhook,
  detectPlatform,
  validateWebhookPayload,
  registerPlatformHandler,
  getPlatformHandler,
  createWebhookRouter,
  registerChatGPThandler,
  registerClaudeHandler
};
