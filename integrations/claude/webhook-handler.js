/**
 * Claude Webhook Handler
 * 
 * Handles incoming webhook events from Claude Actions API
 * Verifies HMAC signatures and routes events to appropriate handlers
 * 
 * @module integrations/claude/webhook-handler
 */

import crypto from 'crypto';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';

// Logger placeholder - integrate with your logging system
const logger = {
  info: (msg, ctx) => console.log(`[INFO] ${msg}`, ctx),
  warn: (msg, ctx) => console.warn(`[WARN] ${msg}`, ctx),
  error: (msg, ctx) => console.error(`[ERROR] ${msg}`, ctx)
};

// ==========================================
// Zod Schemas for Validation
// ==========================================

const WebhookEventSchema = z.object({
  type: z.enum([
    'conversation.start',
    'conversation.message',
    'conversation.end',
    'tool.call',
    'tool.result'
  ]),
  conversation_id: z.string().uuid(),
  user_id: z.string(),
  timestamp: z.string().datetime(),
  payload: z.object({
    message: z.string().optional(),
    tool_name: z.string().optional(),
    tool_input: z.record(z.unknown()).optional(),
    metadata: z.record(z.unknown()).optional()
  }).optional(),
  signature: z.string().optional()
});

const MemoryCreateSchema = z.object({
  content: z.string().min(1).max(10000),
  memoryType: z.enum(['fact', 'preference', 'decision', 'lesson', 'goal', 'event', 'relationship']).optional(),
  title: z.string().max(500).optional(),
  tags: z.array(z.string()).optional(),
  importanceScore: z.number().min(0).max(1).optional()
});

const RecallQuerySchema = z.object({
  query: z.string().min(1).max(2000),
  limit: z.number().min(1).max(50).optional(),
  memoryTypes: z.array(z.string()).optional()
});

// ==========================================
// Signature Verification
// ==========================================

/**
 * Verify HMAC-SHA256 webhook signature
 * Uses timing-safe comparison to prevent timing attacks
 * 
 * @param {string} body - Raw request body
 * @param {string} signature - Signature from header
 * @param {string} secret - Webhook secret
 * @param {string} timestamp - Timestamp from header
 * @returns {boolean} True if signature is valid
 */
export function verifyWebhookSignature(body, signature, secret, timestamp) {
  if (!signature || !timestamp) {
    return false;
  }

  // Check timestamp freshness (5 minute window)
  const now = Date.now();
  const webhookTime = parseInt(timestamp) * 1000;
  const maxAge = 5 * 60 * 1000; // 5 minutes

  if (Math.abs(now - webhookTime) > maxAge) {
    logger.warn('Webhook timestamp expired', { timestamp, now });
    return false;
  }

  // Create expected signature
  const signedPayload = `${timestamp}.${body}`;
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');

  // Timing-safe comparison
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    );
  } catch (e) {
    logger.error('Signature comparison failed', { error: e.message });
    return false;
  }
}

/**
 * Generate HMAC signature for outgoing webhooks
 * 
 * @param {object} payload - Webhook payload
 * @param {string} secret - Webhook secret
 * @returns {{ signature: string, timestamp: number }} Signature and timestamp
 */
export function generateWebhookSignature(payload, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify(payload);
  const signedPayload = `${timestamp}.${body}`;

  const signature = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');

  return { signature, timestamp };
}

// ==========================================
// Event Handlers
// ==========================================

/**
 * Handle conversation start event
 * Injects relevant context at conversation beginning
 * 
 * @param {object} event - Webhook event
 * @param {string} requestId - Request tracking ID
 */
async function handleConversationStart(event, requestId) {
  logger.info('Conversation started', {
    requestId,
    conversationId: event.conversation_id,
    userId: event.user_id
  });

  // Get relevant context for user (implement based on your data layer)
  const context = await getConversationContext({
    userId: event.user_id,
    limit: 20
  });

  // Store context for injection (Redis or similar)
  await storeContext(event.conversation_id, context);

  // Create session record
  await createSession({
    userId: event.user_id,
    platformType: 'claude',
    platformSessionId: event.conversation_id,
    memoriesInjected: context.memories?.map(m => m.id) || [],
    startedAt: new Date(event.timestamp)
  });

  logger.info('Context injected for conversation', {
    requestId,
    memoryCount: context.memories?.length || 0
  });
}

/**
 * Handle conversation message event
 * Analyzes messages for memory-worthy content
 * 
 * @param {object} event - Webhook event
 * @param {string} requestId - Request tracking ID
 */
async function handleConversationMessage(event, requestId) {
  const message = event.payload?.message;
  if (!message) {
    return;
  }

  logger.info('Message received', {
    requestId,
    conversationId: event.conversation_id,
    messageLength: message.length
  });

  // Analyze message for memory-worthy content
  const memorySuggestions = await analyzeForMemories({
    userId: event.user_id,
    message,
    conversationId: event.conversation_id
  });

  if (memorySuggestions.length > 0) {
    // Store suggestions for model to consider
    await storeMemorySuggestions(event.conversation_id, memorySuggestions);

    logger.info('Memory suggestions generated', {
      requestId,
      count: memorySuggestions.length
    });
  }

  // Update session activity
  await updateSessionActivity(event.conversation_id);
}

/**
 * Handle conversation end event
 * Triggers auto-capture of decisions/lessons
 * 
 * @param {object} event - Webhook event
 * @param {string} requestId - Request tracking ID
 */
async function handleConversationEnd(event, requestId) {
  logger.info('Conversation ended', {
    requestId,
    conversationId: event.conversation_id
  });

  // Auto-capture decisions and lessons from conversation
  const capturedMemories = await autoCaptureMemories({
    userId: event.user_id,
    conversationId: event.conversation_id
  });

  // End session
  await endSession({
    platformSessionId: event.conversation_id,
    endedAt: new Date(),
    capturedMemoriesCount: capturedMemories.length
  });

  logger.info('Session ended with auto-capture', {
    requestId,
    capturedCount: capturedMemories.length
  });
}

/**
 * Handle tool call event
 * Processes save_memory, recall_memories, get_context calls
 * 
 * @param {object} event - Webhook event
 * @param {string} requestId - Request tracking ID
 */
async function handleToolCall(event, requestId) {
  const toolName = event.payload?.tool_name;
  const toolInput = event.payload?.tool_input;

  logger.info('Tool called', {
    requestId,
    toolName,
    conversationId: event.conversation_id
  });

  switch (toolName) {
    case 'save_memory':
      await handleSaveMemory(event, toolInput, requestId);
      break;

    case 'recall_memories':
      await handleRecallMemories(event, toolInput, requestId);
      break;

    case 'get_context':
      await handleGetContext(event, toolInput, requestId);
      break;

    default:
      logger.warn('Unknown tool called', { toolName });
  }
}

/**
 * Handle save_memory tool call
 * 
 * @param {object} event - Webhook event
 * @param {object} input - Tool input
 * @param {string} requestId - Request tracking ID
 */
async function handleSaveMemory(event, input, requestId) {
  try {
    const validated = MemoryCreateSchema.parse(input);

    const memory = await createMemory({
      userId: event.user_id,
      content: validated.content,
      memoryType: validated.memoryType || 'fact',
      title: validated.title,
      tags: validated.tags || [],
      importanceScore: validated.importanceScore || 0.5,
      sourcePlatform: 'claude',
      sourceSessionId: event.conversation_id
    });

    logger.info('Memory saved via Claude', {
      requestId,
      memoryId: memory.id,
      memoryType: memory.memoryType
    });

    return memory;
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.warn('Invalid save_memory input', { errors: error.errors });
      throw new Error(`Invalid input: ${error.errors.map(e => e.message).join(', ')}`);
    }
    throw error;
  }
}

/**
 * Handle recall_memories tool call
 * 
 * @param {object} event - Webhook event
 * @param {object} input - Tool input
 * @param {string} requestId - Request tracking ID
 */
async function handleRecallMemories(event, input, requestId) {
  try {
    const validated = RecallQuerySchema.parse(input);

    const results = await searchMemories({
      userId: event.user_id,
      query: validated.query,
      limit: validated.limit || 10,
      memoryTypes: validated.memoryTypes
    });

    // Cache results for quick access
    await cacheRecallResults(event.conversation_id, requestId, results);

    logger.info('Memories recalled', {
      requestId,
      resultCount: results.results?.length || 0
    });

    return results;
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.warn('Invalid recall_memories input', { errors: error.errors });
      throw new Error(`Invalid input: ${error.errors.map(e => e.message).join(', ')}`);
    }
    throw error;
  }
}

/**
 * Handle get_context tool call
 * 
 * @param {object} event - Webhook event
 * @param {object} input - Tool input
 * @param {string} requestId - Request tracking ID
 */
async function handleGetContext(event, input, requestId) {
  const topic = input?.topic;

  const context = await getConversationContext({
    userId: event.user_id,
    topic,
    limit: 20
  });

  logger.info('Context retrieved', {
    requestId,
    memoryCount: context.memories?.length || 0,
    topic
  });

  return context;
}

// ==========================================
// Main Webhook Handler
// ==========================================

/**
 * Express.js webhook handler middleware
 * 
 * @param {object} req - Express request
 * @param {object} res - Express response
 * @param {function} next - Express next middleware
 */
export async function claudeWebhookHandler(req, res) {
  const requestId = uuidv4();
  const startTime = Date.now();

  try {
    // Get signature headers
    const signature = req.headers['x-claude-signature'];
    const timestamp = req.headers['x-claude-timestamp'];
    const body = JSON.stringify(req.body);

    // Verify signature
    const webhookSecret = process.env.CLAUDE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      logger.error('Webhook secret not configured');
      res.status(500).json({ error: 'Server configuration error', requestId });
      return;
    }

    if (!verifyWebhookSignature(body, signature, webhookSecret, timestamp)) {
      logger.warn('Invalid webhook signature', { requestId });
      res.status(401).json({ error: 'Invalid signature', requestId });
      return;
    }

    // Parse and validate event
    const event = WebhookEventSchema.parse(req.body);

    logger.info('Webhook received', {
      requestId,
      type: event.type,
      conversationId: event.conversation_id,
      userId: event.user_id
    });

    // Route to appropriate handler
    switch (event.type) {
      case 'conversation.start':
        await handleConversationStart(event, requestId);
        break;

      case 'conversation.message':
        await handleConversationMessage(event, requestId);
        break;

      case 'conversation.end':
        await handleConversationEnd(event, requestId);
        break;

      case 'tool.call':
        await handleToolCall(event, requestId);
        break;

      default:
        logger.warn('Unknown event type', { type: event.type });
    }

    // Respond with success
    const latency = Date.now() - startTime;
    res.json({
      status: 'processed',
      requestId,
      latencyMs: latency
    });

  } catch (error) {
    const latency = Date.now() - startTime;

    if (error instanceof z.ZodError) {
      logger.warn('Invalid webhook payload', {
        requestId,
        errors: error.errors
      });
      res.status(400).json({
        error: 'Invalid payload',
        details: error.errors,
        requestId
      });
      return;
    }

    logger.error('Webhook processing failed', {
      requestId,
      error: error.message,
      stack: error.stack
    });

    res.status(500).json({
      error: 'Processing failed',
      requestId,
      latencyMs: latency
    });
  }
}

// ==========================================
// Placeholder Functions (Implement based on your data layer)
// ==========================================

async function getConversationContext({ userId, topic, limit }) {
  // Implement with your recall service
  return { memories: [], metadata: { total: 0 } };
}

async function storeContext(conversationId, context) {
  // Implement with Redis or similar
  console.log(`Storing context for ${conversationId}`);
}

async function createSession(sessionData) {
  // Implement with your database
  console.log('Creating session', sessionData);
}

async function analyzeForMemories({ userId, message, conversationId }) {
  // Implement with your memory analysis service
  return [];
}

async function storeMemorySuggestions(conversationId, suggestions) {
  // Implement with Redis or similar
  console.log(`Storing ${suggestions.length} suggestions for ${conversationId}`);
}

async function updateSessionActivity(conversationId) {
  // Implement with your database
  console.log(`Updating activity for ${conversationId}`);
}

async function autoCaptureMemories({ userId, conversationId }) {
  // Implement with your auto-capture service
  return [];
}

async function endSession(sessionData) {
  // Implement with your database
  console.log('Ending session', sessionData);
}

async function createMemory(memoryData) {
  // Implement with your memory service
  return { id: 'mock-id', ...memoryData };
}

async function searchMemories(searchData) {
  // Implement with your recall service
  return { results: [], metadata: { total: 0 } };
}

async function cacheRecallResults(conversationId, requestId, results) {
  // Implement with Redis or similar
  console.log(`Caching recall results for ${conversationId}`);
}

// Export for use in Express app
export default {
  claudeWebhookHandler,
  verifyWebhookSignature,
  generateWebhookSignature
};
