/**
 * Claude Context Injector
 * 
 * Formats and injects relevant memories as XML context for Claude
 * Implements scoring, token management, and graceful degradation
 * 
 * @module integrations/claude/context-injector
 */

import { z } from 'zod';

// Logger placeholder
const logger = {
  info: (msg, ctx) => console.log(`[INFO] ${msg}`, ctx),
  warn: (msg, ctx) => console.warn(`[WARN] ${msg}`, ctx),
  error: (msg, ctx) => console.error(`[ERROR] ${msg}`, ctx)
};

// ==========================================
// Schemas
// ==========================================

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
  score: z.number().optional(),
  scoreBreakdown: z.object({
    similarity: z.number(),
    recency: z.number(),
    importance: z.number()
  }).optional()
});

const InjectionOptionsSchema = z.object({
  userId: z.string(),
  conversationId: z.string().optional(),
  topic: z.string().optional(),
  maxMemories: z.number().min(1).max(50).default(20),
  maxTokens: z.number().min(100).max(4000).default(2000),
  format: z.enum(['xml', 'json', 'markdown']).default('xml'),
  includeMetadata: z.boolean().default(true),
  minScore: z.number().min(0).max(1).default(0.3)
});

// ==========================================
// XML Formatting
// ==========================================

/**
 * Escape XML special characters
 * 
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
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
 * Format a single memory as XML
 * 
 * @param {object} memory - Memory object
 * @param {boolean} includeMetadata - Include metadata section
 * @returns {string} XML string
 */
function formatMemoryAsXml(memory, includeMetadata = true) {
  const parts = [
    '  <memory id="' + memory.id + '">',
    '    <content>' + escapeXml(memory.content) + '</content>'
  ];

  if (memory.title) {
    parts.push('    <title>' + escapeXml(memory.title) + '</title>');
  }

  if (includeMetadata) {
    const metadata = [];
    
    metadata.push('      <type>' + memory.memoryType + '</type>');
    metadata.push('      <importance>' + (memory.importanceScore?.toFixed(2) || '0.50') + '</importance>');
    metadata.push('      <source>' + (memory.sourcePlatform || 'unknown') + '</source>');
    
    const date = memory.documentDate || memory.createdAt;
    if (date) {
      metadata.push('      <date>' + new Date(date).toISOString() + '</date>');
    }
    
    if (memory.tags && memory.tags.length > 0) {
      metadata.push('      <tags>' + escapeXml(memory.tags.join(', ')) + '</tags>');
    }

    if (memory.scoreBreakdown) {
      metadata.push('      <scores>');
      metadata.push('        <similarity>' + memory.scoreBreakdown.similarity.toFixed(3) + '</similarity>');
      metadata.push('        <recency>' + memory.scoreBreakdown.recency.toFixed(3) + '</recency>');
      metadata.push('        <importance>' + memory.scoreBreakdown.importance.toFixed(3) + '</importance>');
      metadata.push('      </scores>');
    }

    parts.push('    <metadata>');
    parts.push(metadata.join('\n'));
    parts.push('    </metadata>');
  }

  parts.push('  </memory>');

  return parts.join('\n');
}

/**
 * Format memories as XML context block
 * 
 * @param {Array} memories - Array of memory objects
 * @param {object} options - Formatting options
 * @returns {string} Complete XML context
 */
export function formatAsXml(memories, options = {}) {
  const { includeMetadata = true, topic } = options;

  if (!memories || memories.length === 0) {
    return '<relevant-memories>\n  <!-- No relevant memories found -->\n</relevant-memories>';
  }

  const memoryXmls = memories.map(m => formatMemoryAsXml(m, includeMetadata));

  const parts = ['<relevant-memories>'];
  
  if (topic) {
    parts.push('  <topic>' + escapeXml(topic) + '</topic>');
  }
  
  parts.push(...memoryXmls);
  parts.push('</relevant-memories>');

  return parts.join('\n');
}

// ==========================================
// JSON Formatting
// ==========================================

/**
 * Format memories as JSON
 * 
 * @param {Array} memories - Array of memory objects
 * @param {boolean} includeMetadata - Include metadata
 * @returns {string} JSON string
 */
export function formatAsJson(memories, includeMetadata = true) {
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
 * 
 * @param {Array} memories - Array of memory objects
 * @param {boolean} includeMetadata - Include metadata
 * @returns {string} Markdown string
 */
export function formatAsMarkdown(memories, includeMetadata = true) {
  if (!memories || memories.length === 0) {
    return '## Relevant Context\n\n_No relevant memories found._';
  }

  const parts = memories.map(m => {
    const header = m.title || `[${m.memoryType}]`;
    const lines = [`### ${header}`, '', m.content];

    if (includeMetadata) {
      const date = m.documentDate || m.createdAt;
      const dateStr = date ? new Date(date).toLocaleDateString() : 'Unknown';
      
      lines.push('', `> **Type:** ${m.memoryType} | **Importance:** ${m.importanceScore?.toFixed(2)} | **Date:** ${dateStr}`);
      
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
 * Estimate token count for text
 * Rough approximation: 1 token ≈ 4 characters
 * 
 * @param {string} text - Text to count
 * @returns {number} Estimated token count
 */
export function estimateTokenCount(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Truncate memories to fit within token limit
 * 
 * @param {Array} memories - Array of memories
 * @param {number} maxTokens - Maximum token count
 * @param {object} options - Truncation options
 * @returns {Array} Truncated memories array
 */
export function truncateToTokenLimit(memories, maxTokens, options = {}) {
  const { format = 'xml', includeMetadata = true } = options;
  
  if (!memories || memories.length === 0) {
    return [];
  }

  // Format all memories first
  let formatted = '';
  const formatter = format === 'json' ? formatAsJson : format === 'markdown' ? formatAsMarkdown : formatAsXml;
  
  // Try with all memories
  formatted = formatter(memories, includeMetadata);
  
  if (estimateTokenCount(formatted) <= maxTokens) {
    return memories;
  }

  // Gradually reduce memories
  let truncated = [...memories];
  while (truncated.length > 0) {
    formatted = formatter(truncated, includeMetadata);
    if (estimateTokenCount(formatted) <= maxTokens) {
      return truncated;
    }
    // Remove lowest scoring memory
    truncated.sort((a, b) => (b.score || 0) - (a.score || 0));
    truncated.pop();
  }

  // If even one memory is too long, truncate content
  if (memories.length > 0) {
    const topMemory = { ...memories[0] };
    const maxContentLength = (maxTokens * 4) - 200; // Reserve space for XML tags
    
    if (topMemory.content.length > maxContentLength) {
      topMemory.content = topMemory.content.substring(0, maxContentLength) + '...';
    }
    
    return [topMemory];
  }

  return [];
}

// ==========================================
// Context Injection
// ==========================================

/**
 * Inject recall context for LLM consumption
 * 
 * @param {object} options - Injection options
 * @returns {Promise<object>} Injection result
 */
export async function injectContext(options) {
  const validatedOptions = InjectionOptionsSchema.parse(options);
  const startTime = Date.now();

  const {
    userId,
    conversationId,
    topic,
    maxMemories,
    maxTokens,
    format,
    includeMetadata,
    minScore
  } = validatedOptions;

  try {
    // Fetch relevant memories (implement with your recall service)
    const memories = await fetchRelevantMemories({
      userId,
      topic,
      limit: maxMemories,
      minScore
    });

    logger.info('Fetched memories for context', {
      userId,
      count: memories.length,
      topic
    });

    // Truncate to token limit
    const truncatedMemories = truncateToTokenLimit(memories, maxTokens, {
      format,
      includeMetadata
    });

    if (truncatedMemories.length < memories.length) {
      logger.warn('Context truncated due to token limit', {
        original: memories.length,
        truncated: truncatedMemories.length,
        maxTokens
      });
    }

    // Format context
    const formatter = format === 'json' ? formatAsJson : format === 'markdown' ? formatAsMarkdown : formatAsXml;
    const formattedContext = formatter(truncatedMemories, { includeMetadata, topic });

    // Calculate token count
    const tokenCount = estimateTokenCount(formattedContext);

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
        actualTokens: tokenCount
      }
    };

    // Track injection for analytics
    if (conversationId) {
      await trackInjection(conversationId, result);
    }

    const latency = Date.now() - startTime;
    logger.info('Context injected', {
      userId,
      conversationId,
      memoryCount: truncatedMemories.length,
      tokenCount,
      latencyMs: latency
    });

    return result;

  } catch (error) {
    logger.error('Context injection failed', {
      userId,
      error: error.message,
      stack: error.stack
    });

    // Return empty but valid context on error
    return {
      formatted: format === 'json' 
        ? JSON.stringify({ memories: [], error: 'Context unavailable' })
        : format === 'markdown'
          ? '## Relevant Context\n\n_Context temporarily unavailable_'
          : '<relevant-memories>\n  <!-- Context temporarily unavailable -->\n</relevant-memories>',
      memoryIds: [],
      tokenCount: 0,
      injectedAt: new Date(),
      error: error.message
    };
  }
}

// ==========================================
// Middleware for Express
// ==========================================

/**
 * Express middleware to inject context into requests
 * 
 * @param {object} options - Middleware options
 * @returns {function} Express middleware
 */
export function contextInjectionMiddleware(options = {}) {
  const {
    format = 'xml',
    maxTokens = 2000,
    headerName = 'X-Injected-Context'
  } = options;

  return async (req, res, next) => {
    // Skip if no user authenticated
    if (!req.user?.id) {
      return next();
    }

    try {
      const context = await injectContext({
        userId: req.user.id,
        conversationId: req.body.conversation_id || req.query.conversation_id,
        topic: req.body.topic || req.query.topic,
        format,
        maxTokens
      });

      // Attach to request object
      req.injectedContext = context;

      // Optionally add header for downstream services
      if (headerName) {
        res.setHeader(headerName, encodeURIComponent(context.formatted));
      }

      next();
    } catch (error) {
      logger.error('Context injection middleware error', { error: error.message });
      // Continue without context
      next();
    }
  };
}

// ==========================================
// Placeholder Functions (Implement based on your data layer)
// ==========================================

async function fetchRelevantMemories({ userId, topic, limit, minScore }) {
  // Implement with your recall service
  // Example:
  // const recallService = getRecallService();
  // const results = await recallService.search({ userId, query: topic, limit });
  // return results.results.filter(m => m.score >= minScore);
  
  console.log(`Fetching memories for user ${userId}, topic: ${topic}`);
  return [];
}

async function trackInjection(conversationId, result) {
  // Implement with your database/analytics
  console.log(`Tracking injection for ${conversationId}: ${result.memoryIds.length} memories`);
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
  contextInjectionMiddleware
};
