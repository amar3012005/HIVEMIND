/**
 * Webhook Validators
 * 
 * Zod schemas and validation utilities for webhook payloads
 * from all supported platforms
 * 
 * @module webhooks/validators
 */

import { z } from 'zod';

// ==========================================
// Common Schemas
// ==========================================

/**
 * Memory object schema
 */
export const MemorySchema = z.object({
  id: z.string().uuid(),
  content: z.string().min(1).max(10000),
  memoryType: z.enum(['fact', 'preference', 'decision', 'lesson', 'goal', 'event', 'relationship']),
  title: z.string().max(500).optional(),
  tags: z.array(z.string()).optional(),
  sourcePlatform: z.string().optional(),
  importanceScore: z.number().min(0).max(1).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional()
});

/**
 * User object schema
 */
export const UserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string().optional(),
  zitadelUserId: z.string()
});

/**
 * Session object schema
 */
export const SessionSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  platformType: z.string(),
  platformSessionId: z.string(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
  messageCount: z.number().int().min(0),
  memoriesInjected: z.array(z.string().uuid()).optional()
});

// ==========================================
// ChatGPT Webhook Schemas
// ==========================================

/**
 * ChatGPT conversation event payload
 */
export const ChatGPTConversationSchema = z.object({
  type: z.enum(['conversation.started', 'conversation.updated', 'conversation.ended']),
  conversation_id: z.string(),
  user_id: z.string(),
  platform_user_id: z.string(),
  timestamp: z.string().datetime(),
  payload: z.object({
    title: z.string().optional(),
    message_count: z.number().int().min(0).optional(),
    last_message: z.string().optional(),
    metadata: z.record(z.unknown()).optional()
  }).optional()
});

/**
 * ChatGPT action event payload
 */
export const ChatGPTActionSchema = z.object({
  type: z.enum(['action.invoked', 'action.completed', 'action.failed']),
  action_id: z.string(),
  action_name: z.string(),
  conversation_id: z.string(),
  user_id: z.string(),
  timestamp: z.string().datetime(),
  payload: z.object({
    input: z.record(z.unknown()).optional(),
    output: z.record(z.unknown()).optional(),
    error: z.string().optional(),
    latency_ms: z.number().int().min(0).optional()
  }).optional()
});

/**
 * ChatGPT message event payload
 */
export const ChatGPTMessageSchema = z.object({
  type: z.enum(['message.created', 'message.updated']),
  message_id: z.string(),
  conversation_id: z.string(),
  user_id: z.string(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  timestamp: z.string().datetime()
});

// ==========================================
// Claude Webhook Schemas
// ==========================================

/**
 * Claude conversation event payload
 */
export const ClaudeConversationSchema = z.object({
  type: z.enum(['conversation.start', 'conversation.message', 'conversation.end']),
  conversation_id: z.string().uuid(),
  user_id: z.string(),
  timestamp: z.string().datetime(),
  payload: z.object({
    message: z.string().optional(),
    message_index: z.number().int().min(0).optional(),
    metadata: z.record(z.unknown()).optional()
  }).optional()
});

/**
 * Claude tool event payload
 */
export const ClaudeToolSchema = z.object({
  type: z.enum(['tool.call', 'tool.result']),
  tool_name: z.string(),
  tool_id: z.string(),
  conversation_id: z.string().uuid(),
  user_id: z.string(),
  timestamp: z.string().datetime(),
  payload: z.object({
    input: z.record(z.unknown()).optional(),
    output: z.record(z.unknown()).optional(),
    error: z.string().optional()
  }).optional()
});

// ==========================================
// Perplexity Webhook Schemas
// ==========================================

/**
 * Perplexity query event payload
 */
export const PerplexityQuerySchema = z.object({
  type: z.enum(['query.received', 'response.generated']),
  session_id: z.string(),
  user_id: z.string(),
  query: z.string(),
  timestamp: z.string().datetime(),
  payload: z.object({
    response: z.string().optional(),
    sources: z.array(z.string()).optional(),
    follow_up_questions: z.array(z.string()).optional(),
    metadata: z.record(z.unknown()).optional()
  }).optional()
});

/**
 * Perplexity session event payload
 */
export const PerplexitySessionSchema = z.object({
  type: z.enum(['session.started', 'session.ended']),
  session_id: z.string(),
  user_id: z.string(),
  timestamp: z.string().datetime(),
  payload: z.object({
    message_count: z.number().int().min(0).optional(),
    duration_seconds: z.number().int().min(0).optional()
  }).optional()
});

// ==========================================
// Gemini Webhook Schemas
// ==========================================

/**
 * Gemini message event payload
 */
export const GeminiMessageSchema = z.object({
  type: z.enum(['message.received', 'message.sent']),
  session_id: z.string(),
  user_id: z.string(),
  message_id: z.string(),
  timestamp: z.string().datetime(),
  payload: z.object({
    content: z.string(),
    role: z.enum(['user', 'model']).optional(),
    parts: z.array(z.object({
      text: z.string()
    })).optional()
  })
});

/**
 * Gemini context event payload
 */
export const GeminiContextSchema = z.object({
  type: z.enum(['context.updated', 'session.created', 'session.deleted']),
  session_id: z.string(),
  user_id: z.string(),
  timestamp: z.string().datetime(),
  payload: z.object({
    context_tokens: z.number().int().min(0).optional(),
    memory_tokens: z.number().int().min(0).optional()
  }).optional()
});

// ==========================================
// Generic Webhook Schema
// ==========================================

/**
 * Generic webhook payload for custom integrations
 */
export const GenericWebhookSchema = z.object({
  event: z.string(),
  source: z.string().optional(),
  timestamp: z.string().datetime().optional(),
  data: z.record(z.unknown()),
  metadata: z.object({
    requestId: z.string().uuid().optional(),
    version: z.string().optional(),
    custom: z.record(z.unknown()).optional()
  }).optional()
});

// ==========================================
// Union Schema for All Webhooks
// ==========================================

/**
 * Union of all webhook types
 */
export const AnyWebhookSchema = z.discriminatedUnion('type', [
  // ChatGPT
  ChatGPTConversationSchema,
  ChatGPTActionSchema,
  ChatGPTMessageSchema,
  // Claude
  ClaudeConversationSchema,
  ClaudeToolSchema,
  // Perplexity
  PerplexityQuerySchema,
  PerplexitySessionSchema,
  // Gemini
  GeminiMessageSchema,
  GeminiContextSchema,
  // Generic
  GenericWebhookSchema.omit({ event: true }).extend({ type: z.string() })
]);

// ==========================================
// Validation Functions
// ==========================================

/**
 * Validate webhook payload for specific platform
 * 
 * @param {object} payload - Webhook payload
 * @param {string} platform - Platform name
 * @returns {object} Validated payload
 * @throws {z.ZodError} If validation fails
 */
export function validateWebhook(payload, platform) {
  switch (platform) {
    case 'chatgpt':
      if (payload.type?.includes('action')) {
        return ChatGPTActionSchema.parse(payload);
      }
      if (payload.type?.includes('message')) {
        return ChatGPTMessageSchema.parse(payload);
      }
      return ChatGPTConversationSchema.parse(payload);

    case 'claude':
      if (payload.type?.includes('tool')) {
        return ClaudeToolSchema.parse(payload);
      }
      return ClaudeConversationSchema.parse(payload);

    case 'perplexity':
      if (payload.type?.includes('query') || payload.type?.includes('response')) {
        return PerplexityQuerySchema.parse(payload);
      }
      return PerplexitySessionSchema.parse(payload);

    case 'gemini':
      if (payload.type?.includes('message')) {
        return GeminiMessageSchema.parse(payload);
      }
      return GeminiContextSchema.parse(payload);

    default:
      return GenericWebhookSchema.parse(payload);
  }
}

/**
 * Safely validate webhook payload
 * 
 * @param {object} payload - Webhook payload
 * @param {string} platform - Platform name
 * @returns {object} Validation result
 */
export function safeValidateWebhook(payload, platform) {
  try {
    const validated = validateWebhook(payload, platform);
    return {
      success: true,
      data: validated,
      error: null
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        data: null,
        error: {
          type: 'VALIDATION_ERROR',
          message: error.message,
          details: error.errors.map(e => ({
            field: e.path.join('.'),
            code: e.code,
            message: e.message
          }))
        }
      };
    }
    
    return {
      success: false,
      data: null,
      error: {
        type: 'UNKNOWN_ERROR',
        message: error.message
      }
    };
  }
}

/**
 * Extract common fields from any webhook type
 * 
 * @param {object} payload - Validated webhook payload
 * @returns {object} Common fields
 */
export function extractCommonFields(payload) {
  return {
    type: payload.type || payload.event,
    userId: payload.user_id,
    timestamp: payload.timestamp ? new Date(payload.timestamp) : new Date(),
    platform: payload.platform || 'unknown',
    conversationId: payload.conversation_id || payload.session_id,
    payload: payload.payload || payload.data
  };
}

/**
 * Get event category from event type
 * 
 * @param {string} eventType - Event type string
 * @returns {string} Event category
 */
export function getEventCategory(eventType) {
  if (!eventType) return 'unknown';
  
  const [category] = eventType.split('.');
  return category.toLowerCase();
}

/**
 * Check if event is conversation-related
 * 
 * @param {string} eventType - Event type
 * @returns {boolean} True if conversation event
 */
export function isConversationEvent(eventType) {
  return eventType?.includes('conversation') || 
         eventType?.includes('session') ||
         eventType?.includes('message');
}

/**
 * Check if event is action/tool-related
 * 
 * @param {string} eventType - Event type
 * @returns {boolean} True if action event
 */
export function isActionEvent(eventType) {
  return eventType?.includes('action') || 
         eventType?.includes('tool');
}

// ==========================================
// Request Validation Middleware
// ==========================================

/**
 * Express middleware to validate webhook payload
 * 
 * @param {string} platform - Platform name (optional)
 * @returns {function} Express middleware
 */
export function validateWebhookMiddleware(platform = null) {
  return (req, res, next) => {
    const targetPlatform = platform || req.params.platform || 'generic';
    
    try {
      const validated = validateWebhook(req.body, targetPlatform);
      req.validatedWebhook = validated;
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: error.message,
          details: error.errors.map(e => ({
            field: e.path.join('.'),
            message: e.message
          }))
        });
        return;
      }
      next(error);
    }
  };
}

// ==========================================
// Exports
// ==========================================

export default {
  // Schemas
  MemorySchema,
  UserSchema,
  SessionSchema,
  ChatGPTConversationSchema,
  ChatGPTActionSchema,
  ChatGPTMessageSchema,
  ClaudeConversationSchema,
  ClaudeToolSchema,
  PerplexityQuerySchema,
  PerplexitySessionSchema,
  GeminiMessageSchema,
  GeminiContextSchema,
  GenericWebhookSchema,
  AnyWebhookSchema,
  
  // Functions
  validateWebhook,
  safeValidateWebhook,
  extractCommonFields,
  getEventCategory,
  isConversationEvent,
  isActionEvent,
  validateWebhookMiddleware
};
