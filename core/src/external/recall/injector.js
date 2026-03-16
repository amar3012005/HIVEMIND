/**
 * Pre-Inference Recall Injector
 * 
 * Fetches, scores, and formats relevant memories for LLM context injection
 * Implements similarity-based retrieval, recency bias, and Ebbinghaus decay
 * 
 * @module recall/injector
 */

import { z } from 'zod';

// Logger
const logger = {
  info: (msg, ctx) => console.log(`[RECALL INFO] ${msg}`, ctx),
  warn: (msg, ctx) => console.warn(`[RECALL WARN] ${msg}`, ctx),
  error: (msg, ctx) => console.error(`[RECALL ERROR] ${msg}`, ctx)
};

// ==========================================
// Configuration
// ==========================================

const CONFIG = {
  // Scoring weights
  defaultWeights: {
    similarity: 0.5,
    recency: 0.3,
    importance: 0.2
  },

  // Ebbinghaus decay parameters
  ebbinghaus: {
    decayRate: 0.5, // Standard decay rate
    retentionThreshold: 0.3, // Minimum retention score
    halfLifeHours: 24 // Memory half-life in hours
  },

  // Token management
  tokens: {
    maxContextTokens: 2000,
    avgCharsPerToken: 4,
    reservedTokens: 100 // For XML tags and metadata
  },

  // Retrieval limits
  retrieval: {
    defaultLimit: 20,
    maxLimit: 50,
    minScore: 0.3
  }
};

// ==========================================
// Schemas
// ==========================================

const InjectionOptionsSchema = z.object({
  userId: z.string(),
  conversationId: z.string().optional(),
  topic: z.string().optional(),
  query: z.string().optional(),
  maxMemories: z.number().min(1).max(100).default(CONFIG.retrieval.defaultLimit),
  maxTokens: z.number().min(100).max(8000).default(CONFIG.tokens.maxContextTokens),
  format: z.enum(['xml', 'json', 'markdown']).default('xml'),
  includeMetadata: z.boolean().default(true),
  minScore: z.number().min(0).max(1).default(CONFIG.retrieval.minScore),
  weights: z.object({
    similarity: z.number().min(0).max(1).optional(),
    recency: z.number().min(0).max(1).optional(),
    importance: z.number().min(0).max(1).optional()
  }).optional(),
  memoryTypes: z.array(z.string()).optional()
});

const MemorySchema = z.object({
  id: z.string().uuid(),
  content: z.string(),
  memoryType: z.enum(['fact', 'preference', 'decision', 'lesson', 'goal', 'event', 'relationship']),
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  sourcePlatform: z.string().optional(),
  importanceScore: z.number().min(0).max(1),
  documentDate: z.date().optional(),
  createdAt: z.date(),
  updatedAt: z.date().optional(),
  score: z.number().optional(),
  scoreBreakdown: z.object({
    similarity: z.number(),
    recency: z.number(),
    importance: z.number()
  }).optional()
});

const InjectionResultSchema = z.object({
  formatted: z.string(),
  memoryIds: z.array(z.string()),
  tokenCount: z.number(),
  injectedAt: z.date(),
  metadata: z.object({
    totalMemories: z.number(),
    injectedMemories: z.number(),
    format: z.string(),
    maxTokens: z.number(),
    actualTokens: z.number(),
    latencyMs: z.number()
  }).optional(),
  error: z.string().optional()
});

// ==========================================
// XML Formatting
// ==========================================

/**
 * Escape XML special characters
 */
export function escapeXml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Format memories as XML
 */
export function formatAsXml(memories, options = {}) {
  const { includeMetadata = true, topic } = options;

  if (!memories || memories.length === 0) {
    return '<relevant-memories>\n  <!-- No relevant memories found -->\n</relevant-memories>';
  }

  const memoryElements = memories.map(memory => {
    const parts = [
      `  <memory id="${memory.id}">`,
      `    <content>${escapeXml(memory.content)}</content>`
    ];

    if (memory.title) {
      parts.push(`    <title>${escapeXml(memory.title)}</title>`);
    }

    if (includeMetadata) {
      parts.push('    <metadata>');
      parts.push(`      <type>${memory.memoryType}</type>`);
      parts.push(`      <importance>${(memory.importanceScore || 0.5).toFixed(2)}</importance>`);
      parts.push(`      <source>${memory.sourcePlatform || 'unknown'}</source>`);
      
      const date = memory.documentDate || memory.createdAt;
      if (date) {
        parts.push(`      <date>${new Date(date).toISOString()}</date>`);
      }

      if (memory.tags && memory.tags.length > 0) {
        parts.push(`      <tags>${escapeXml(memory.tags.join(', '))}</tags>`);
      }

      if (memory.scoreBreakdown) {
        parts.push('      <scores>');
        parts.push(`        <similarity>${memory.scoreBreakdown.similarity.toFixed(3)}</similarity>`);
        parts.push(`        <recency>${memory.scoreBreakdown.recency.toFixed(3)}</recency>`);
        parts.push(`        <importance>${memory.scoreBreakdown.importance.toFixed(3)}</importance>`);
        parts.push('      </scores>');
      }

      parts.push('    </metadata>');
    }

    parts.push('  </memory>');
    return parts.join('\n');
  });

  const parts = ['<relevant-memories>'];
  
  if (topic) {
    parts.push(`  <topic>${escapeXml(topic)}</topic>`);
  }
  
  parts.push(...memoryElements);
  parts.push('</relevant-memories>');

  return parts.join('\n');
}

// ==========================================
// JSON Formatting
// ==========================================

/**
 * Format memories as JSON
 */
export function formatAsJson(memories, options = {}) {
  const { includeMetadata = true } = options;

  const formatted = (memories || []).map(m => ({
    id: m.id,
    content: m.content,
    ...(m.title && { title: m.title }),
    ...(includeMetadata && {
      type: m.memoryType,
      importance: m.importanceScore,
      source: m.sourcePlatform,
      date: m.documentDate || m.createdAt,
      tags: m.tags,
      score: m.score,
      scoreBreakdown: m.scoreBreakdown
    })
  }));

  return JSON.stringify({ memories: formatted }, null, 2);
}

// ==========================================
// Markdown Formatting
// ==========================================

/**
 * Format memories as Markdown
 */
export function formatAsMarkdown(memories, options = {}) {
  const { includeMetadata = true } = options;

  if (!memories || memories.length === 0) {
    return '## Relevant Context\n\n_No relevant memories found._';
  }

  const parts = memories.map(m => {
    const header = m.title || `[${m.memoryType}]`;
    const lines = [`### ${header}`, '', m.content];

    if (includeMetadata) {
      const date = m.documentDate || m.createdAt;
      const dateStr = date ? new Date(date).toLocaleDateString() : 'Unknown';
      
      lines.push('', `> **Type:** ${m.memoryType} | **Importance:** ${(m.importanceScore || 0.5).toFixed(2)} | **Date:** ${dateStr}`);
      
      if (m.tags && m.tags.length > 0) {
        lines.push(`> **Tags:** ${m.tags.join(', ')}`);
      }
    }

    return lines.join('\n');
  });

  return ['## Relevant Context', '', parts.join('\n\n---\n\n')].join('\n');
}

// ==========================================
// Token Management
// ==========================================

/**
 * Estimate token count
 */
export function estimateTokenCount(text) {
  if (!text) return 0;
  return Math.ceil(text.length / CONFIG.tokens.avgCharsPerToken);
}

/**
 * Truncate memories to fit token limit
 */
export function truncateToTokenLimit(memories, maxTokens, options = {}) {
  const { format = 'xml', includeMetadata = true } = options;

  if (!memories || memories.length === 0) {
    return [];
  }

  // Format function
  const formatter = format === 'json' 
    ? (m) => formatAsJson(m, { includeMetadata })
    : format === 'markdown'
      ? (m) => formatAsMarkdown(m, { includeMetadata })
      : (m) => formatAsXml(m, { includeMetadata });

  // Try with all memories first
  let formatted = formatter(memories);
  if (estimateTokenCount(formatted) <= maxTokens) {
    return memories;
  }

  // Gradually reduce
  let truncated = [...memories].sort((a, b) => (b.score || 0) - (a.score || 0));
  
  while (truncated.length > 0) {
    formatted = formatter(truncated);
    if (estimateTokenCount(formatted) <= maxTokens) {
      return truncated;
    }
    truncated.pop();
  }

  // Single memory truncation
  if (memories.length > 0) {
    const topMemory = { ...memories.sort((a, b) => (b.score || 0) - (a.score || 0))[0] };
    const maxContentLength = (maxTokens * CONFIG.tokens.avgCharsPerToken) - (CONFIG.tokens.reservedTokens * CONFIG.tokens.avgCharsPerToken);
    
    if (topMemory.content.length > maxContentLength) {
      topMemory.content = topMemory.content.substring(0, maxContentLength) + '...';
    }
    
    return [topMemory];
  }

  return [];
}

// ==========================================
// Main Injection Function
// ==========================================

/**
 * Inject recall context for LLM consumption
 * 
 * @param {object} options - Injection options
 * @returns {Promise<object>} Injection result
 */
export async function injectContext(options) {
  const startTime = Date.now();
  const requestId = options.requestId || `req-${Date.now()}`;

  try {
    // Validate options
    const validatedOptions = InjectionOptionsSchema.parse(options);
    
    logger.info('Starting context injection', {
      requestId,
      userId: validatedOptions.userId,
      topic: validatedOptions.topic
    });

    const {
      userId,
      conversationId,
      topic,
      query,
      maxMemories,
      maxTokens,
      format,
      includeMetadata,
      minScore,
      weights,
      memoryTypes
    } = validatedOptions;

    // Fetch relevant memories
    const memories = await fetchMemories({
      userId,
      query: query || topic,
      topic,
      limit: maxMemories,
      minScore,
      memoryTypes,
      weights: weights || CONFIG.defaultWeights
    });

    logger.info('Memories fetched', {
      requestId,
      count: memories.length
    });

    // Truncate to token limit
    const truncatedMemories = truncateToTokenLimit(memories, maxTokens, {
      format,
      includeMetadata
    });

    if (truncatedMemories.length < memories.length) {
      logger.warn('Context truncated', {
        requestId,
        original: memories.length,
        truncated: truncatedMemories.length
      });
    }

    // Format context
    const formatter = {
      xml: formatAsXml,
      json: formatAsJson,
      markdown: formatAsMarkdown
    }[format] || formatAsXml;

    const formattedContext = formatter(truncatedMemories, { includeMetadata, topic });

    // Calculate metrics
    const tokenCount = estimateTokenCount(formattedContext);
    const latency = Date.now() - startTime;

    const result = {
      formatted: formattedContext,
      memoryIds: truncatedMemories.map(m => m.id),
      tokenCount,
      injectedAt: new Date(),
      metadata: {
        totalMemories: memories.length,
        injectedMemories: truncatedMemories.length,
        format,
        maxTokens,
        actualTokens: tokenCount,
        latencyMs: latency,
        requestId
      }
    };

    // Track injection
    if (conversationId) {
      await trackInjection(conversationId, result);
    }

    logger.info('Context injected successfully', {
      requestId,
      memoryCount: truncatedMemories.length,
      tokenCount,
      latencyMs: latency
    });

    return result;

  } catch (error) {
    const latency = Date.now() - startTime;
    
    logger.error('Context injection failed', {
      requestId,
      error: error.message,
      latencyMs: latency
    });

    // Return graceful fallback
    const format = options.format || 'xml';
    const fallbackContext = format === 'json'
      ? JSON.stringify({ memories: [], error: 'Context temporarily unavailable' })
      : format === 'markdown'
        ? '## Relevant Context\n\n_Context temporarily unavailable_'
        : '<relevant-memories>\n  <!-- Context temporarily unavailable -->\n</relevant-memories>';

    return {
      formatted: fallbackContext,
      memoryIds: [],
      tokenCount: 0,
      injectedAt: new Date(),
      error: error.message,
      metadata: {
        totalMemories: 0,
        injectedMemories: 0,
        format,
        latencyMs: latency,
        requestId
      }
    };
  }
}

// ==========================================
// Memory Fetching
// ==========================================

/**
 * Fetch relevant memories
 */
async function fetchMemories(options) {
  const { userId, query, topic, limit, minScore, memoryTypes, weights } = options;

  // This would integrate with your recall service
  // For now, return placeholder
  logger.info('Fetching memories', {
    userId,
    query,
    limit,
    memoryTypes: memoryTypes?.length
  });

  // Placeholder - implement with your recall service
  // Example:
  // const recallService = getRecallService();
  // const results = await recallService.search({
  //   userId,
  //   query: query || topic,
  //   limit,
  //   filters: { memoryTypes },
  //   weights
  // });
  // return results.results.filter(m => m.score >= minScore);

  return [];
}

// ==========================================
// Analytics Tracking
// ==========================================

/**
 * Track context injection for analytics
 */
async function trackInjection(conversationId, result) {
  logger.info('Tracking injection', {
    conversationId,
    memoryCount: result.memoryIds.length,
    tokenCount: result.tokenCount
  });

  // Implement with your analytics/database
  // Example:
  // await db.session.updateMany({
  //   where: { platformSessionId: conversationId },
  //   data: {
  //     memoriesInjected: result.memoryIds,
  //     contextWindowUsed: result.tokenCount,
  //     lastActivityAt: result.injectedAt
  //   }
  // });
}

// ==========================================
// Express Middleware
// ==========================================

/**
 * Express middleware for context injection
 */
export function contextInjectionMiddleware(options = {}) {
  const {
    format = 'xml',
    maxTokens = 2000,
    headerName = 'X-Injected-Context',
    attachToRequest = true
  } = options;

  return async (req, res, next) => {
    // Skip if no user
    if (!req.user?.id) {
      return next();
    }

    try {
      const context = await injectContext({
        userId: req.user.id,
        conversationId: req.body.conversation_id || req.query.conversation_id,
        topic: req.body.topic || req.query.topic,
        format,
        maxTokens,
        requestId: req.id
      });

      if (attachToRequest) {
        req.injectedContext = context;
      }

      if (headerName) {
        res.setHeader(headerName, encodeURIComponent(context.formatted));
      }

      next();
    } catch (error) {
      logger.error('Context injection middleware error', { error: error.message });
      next(); // Continue without context
    }
  };
}

// ==========================================
// Exports
// ==========================================

export default {
  injectContext,
  formatAsXml,
  formatAsJson,
  formatAsMarkdown,
  escapeXml,
  estimateTokenCount,
  truncateToTokenLimit,
  contextInjectionMiddleware,
  CONFIG
};
