/**
 * MCP Tool: save_session
 * 
 * Saves a chat session as a memory entry with automatic summarization.
 * Captures decisions, action items, and key context from conversations.
 * 
 * @module mcp-server/tools/save-session
 */

import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { summarizeSession } from '../../connectors/chat/summarizer.js';
import { extractDecisionsAndLessons } from '../../connectors/chat/extractor.js';

// ==========================================
// Input Validation Schema
// ==========================================

/**
 * Zod schema for save_session tool input
 * Validates all incoming parameters before processing
 */
export const SaveSessionInputSchema = z.object({
  platform: z.enum(['chatgpt', 'claude', 'perplexity', 'gemini', 'mcp', 'other'])
    .describe('Platform where the session occurred'),

  summary: z.string()
    .min(1, 'Summary is required')
    .max(10000, 'Summary must be less than 10000 characters')
    .optional()
    .describe('Optional pre-computed session summary'),

  messages: z.array(
    z.object({
      role: z.enum(['user', 'assistant', 'system']).optional().default('user'),
      content: z.string(),
      timestamp: z.string().datetime().optional()
    })
  )
    .min(1, 'At least one message is required')
    .describe('Array of conversation messages'),

  startTime: z.string().datetime().optional()
    .describe('Session start time (ISO 8601)'),

  endTime: z.string().datetime().optional()
    .describe('Session end time (ISO 8601)'),

  sessionId: z.string().optional()
    .describe('Optional external session ID from platform'),

  userId: z.string().optional()
    .describe('Optional user ID (defaults to environment CURRENT_USER_ID)'),

  orgId: z.string().optional()
    .describe('Optional organization ID'),

  autoSummarize: z.boolean().default(true)
    .describe('Whether to auto-summarize using Groq API'),

  extractDecisions: z.boolean().default(true)
    .describe('Whether to extract decisions and lessons'),

  tags: z.array(z.string()).optional()
    .describe('Optional tags for categorization'),

  importanceScore: z.number().min(0).max(1).default(0.5)
    .describe('Importance score 0-1 (default: 0.5)'),

  title: z.string().optional()
    .describe('Optional title for the session'),

  memoryType: z.string().optional()
    .describe('Optional memory type')
});

// ==========================================
// Tool Definition
// ==========================================

/**
 * save_session tool definition for MCP server
 * 
 * This tool captures complete chat sessions and stores them as memories.
 * It can automatically summarize conversations and extract decisions/lessons.
 * 
 * @example
 * // Basic usage
 * save_session({
 *   platform: 'claude',
 *   messages: [
 *     { role: 'user', content: 'What should I use for backend?', timestamp: '2026-03-12T10:00:00Z' },
 *     { role: 'assistant', content: 'TypeScript is a great choice...', timestamp: '2026-03-12T10:00:05Z' }
 *   ],
 *   startTime: '2026-03-12T10:00:00Z',
 *   endTime: '2026-03-12T10:30:00Z'
 * })
 * 
 * @example
 * // With auto-summarization
 * save_session({
 *   platform: 'chatgpt',
 *   messages: [...],
 *   startTime: '2026-03-12T11:00:00Z',
 *   endTime: '2026-03-12T11:45:00Z',
 *   autoSummarize: true,
 *   extractDecisions: true,
 *   tags: ['backend', 'architecture']
 * })
 */
export const saveSessionTool = {
  name: 'save_session',
  description: `Save a complete chat session as a memory with automatic summarization. 
Captures decisions, action items, and key context from conversations across AI platforms.

Use this when:
- Ending a productive conversation you want to preserve
- Capturing decisions made during a chat session
- Storing action items and next steps from a discussion
- Preserving context for future cross-platform sync

The tool will:
1. Summarize the conversation (if autoSummarize=true)
2. Extract decisions and lessons (if extractDecisions=true)
3. Store as structured memory with platform metadata
4. Sync across all connected platforms via Meta-MCP Bridge`,

  inputSchema: {
    type: 'object',
    properties: {
      platform: {
        type: 'string',
        enum: ['chatgpt', 'claude', 'perplexity', 'gemini', 'mcp', 'other'],
        description: 'Platform where the session occurred (required)'
      },
      summary: {
        type: 'string',
        description: 'Optional pre-computed session summary (1-10000 chars)'
      },
      messages: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            role: { type: 'string', enum: ['user', 'assistant', 'system'] },
            content: { type: 'string' },
            timestamp: { type: 'string', format: 'date-time' }
          },
          required: ['role', 'content']
        },
        description: 'Array of conversation messages (required, min 1)'
      },
      startTime: {
        type: 'string',
        format: 'date-time',
        description: 'Session start time in ISO 8601 format (required)'
      },
      endTime: {
        type: 'string',
        format: 'date-time',
        description: 'Session end time in ISO 8601 format (required)'
      },
      sessionId: {
        type: 'string',
        format: 'uuid',
        description: 'Optional external session ID from platform'
      },
      userId: {
        type: 'string',
        format: 'uuid',
        description: 'Optional user ID (defaults to environment CURRENT_USER_ID)'
      },
      autoSummarize: {
        type: 'boolean',
        default: true,
        description: 'Whether to auto-summarize using Groq API (default: true)'
      },
      extractDecisions: {
        type: 'boolean',
        default: true,
        description: 'Whether to extract decisions and lessons (default: true)'
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional tags for categorization'
      },
      importanceScore: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        default: 0.5,
        description: 'Importance score 0-1 (default: 0.5)'
      }
    },
    required: ['platform', 'messages', 'startTime', 'endTime']
  }
};

// ==========================================
// Tool Handler
// ==========================================

/**
 * Handle save_session tool invocation
 * 
 * @param {Object} args - Tool arguments (validated against SaveSessionInputSchema)
 * @param {string} requestId - Unique request ID for tracing
 * @param {Function} apiCall - API call function to HIVE-MIND backend
 * @param {Object} logger - Logger instance with info/warn/error methods
 * @returns {Promise<Object>} Tool execution result with content array
 * 
 * @throws {ZodError} If input validation fails
 * @throws {Error} If API call fails or summarization fails
 */
export async function handleSaveSession(args, requestId, apiCall, logger) {
  // Validate input
  const validatedInput = SaveSessionInputSchema.parse(args);
  const {
    platform,
    summary: preSummary,
    messages,
    startTime,
    endTime,
    sessionId,
    userId,
    autoSummarize,
    extractDecisions,
    tags,
    importanceScore
  } = validatedInput;

  logger.info('save_session: Starting session save', {
    requestId,
    platform,
    messageCount: messages.length,
    autoSummarize,
    extractDecisions
  });

  try {
    // Step 1: Generate summary if not provided and autoSummarize is enabled
    let sessionSummary = preSummary;
    let extractedContent = null;

    if (!sessionSummary && autoSummarize) {
      logger.info('save_session: Auto-summarizing session', { requestId });
      
      try {
        const summaryResult = await summarizeSession(messages, {
          requestId,
          platform
        });
        
        sessionSummary = summaryResult.summary;
        extractedContent = summaryResult.extracted;
        
        logger.info('save_session: Summarization complete', {
          requestId,
          summaryLength: sessionSummary.length
        });
      } catch (summarizationError) {
        logger.warn('save_session: Auto-summarization failed, using fallback', {
          requestId,
          error: summarizationError.message
        });
        
        // Fallback: Use first message as summary
        sessionSummary = `Session on ${platform}: ${messages[0]?.content?.substring(0, 200)}...`;
      }
    } else if (!sessionSummary) {
      // Fallback when autoSummarize is disabled
      sessionSummary = `Session on ${platform} from ${startTime} to ${endTime}`;
    }

    // Step 2: Extract decisions and lessons if enabled
    let decisions = [];
    let lessons = [];

    if (extractDecisions && messages.length > 1) {
      logger.info('save_session: Extracting decisions and lessons', { requestId });
      
      try {
        const extracted = await extractDecisionsAndLessons(messages, {
          requestId,
          platform
        });
        
        decisions = extracted.decisions || [];
        lessons = extracted.lessons || [];
        
        logger.info('save_session: Extraction complete', {
          requestId,
          decisionsCount: decisions.length,
          lessonsCount: lessons.length
        });
      } catch (extractionError) {
        logger.warn('save_session: Decision extraction failed', {
          requestId,
          error: extractionError.message
        });
        // Continue without extracted content
      }
    }

    // Step 3: Build memory content
    const memoryContent = buildSessionMemoryContent({
      summary: sessionSummary,
      messages,
      decisions,
      lessons,
      platform,
      startTime,
      endTime,
      sessionId
    });

    // Step 4: Store session as memory (simplified - direct to API)
    logger.info('save_session: Storing session memory', { requestId });

    const sessionPayload = {
      content: memoryContent,
      title: validatedInput.title || `${platform} session ${startTime.slice(0, 10)}`,
      memory_type: validatedInput.memoryType || 'event',
      tags: [
        ...(tags || []),
        'session',
        platform,
        ...(decisions.length > 0 ? ['has-decisions'] : []),
        ...(lessons.length > 0 ? ['has-lessons'] : [])
      ],
      project: 'session-memory',
      source_platform: platform,
      source_session_id: sessionId || requestId,
      metadata: {
        platform,
        session_start: startTime,
        session_end: endTime,
        message_count: messages.length,
        importance_score: importanceScore,
        auto_summarized: autoSummarize
      }
    };

    const memory = await apiCall('POST', '/api/memories', sessionPayload);
    const memoryId = memory.memory?.id || memory.id;

    logger.info('save_session: Memory stored successfully', {
      requestId,
      memoryId
    });

    // Step 5: Store individual decisions as separate memories
    if (decisions.length > 0) {
      logger.info('save_session: Storing decision memories', {
        requestId,
        count: decisions.length
      });

      for (const decision of decisions) {
        try {
          await apiCall('POST', '/api/memories', {
            content: decision.content,
            title: `Decision from ${platform} session`,
            memory_type: 'decision',
            tags: [...(tags || []), 'decision', 'auto-extracted', platform],
            project: 'session-memory',
            source_platform: platform,
            source_session_id: sessionId || requestId,
            relationship: {
              type: 'Extends',
              target_id: memoryId,
              confidence: 1.0
            },
            metadata: {
              parent_session_memory_id: memoryId,
              extracted_from: 'session',
              platform
            }
          });
        } catch (decisionError) {
          logger.warn('save_session: Failed to store decision', {
            requestId,
            error: decisionError.message
          });
        }
      }
    }

    // Step 6: Store individual lessons as separate memories
    if (lessons.length > 0) {
      logger.info('save_session: Storing lesson memories', {
        requestId,
        count: lessons.length
      });

      for (const lesson of lessons) {
        try {
          await apiCall('POST', '/api/memories', {
            content: lesson.content,
            title: `Lesson from ${platform} session`,
            memory_type: 'lesson',
            tags: [...(tags || []), 'lesson', 'auto-extracted', platform],
            project: 'session-memory',
            source_platform: platform,
            source_session_id: sessionId || requestId,
            relationship: {
              type: 'Extends',
              target_id: memoryId,
              confidence: 1.0
            },
            metadata: {
              parent_session_memory_id: memoryId,
              extracted_from: 'session',
              platform
            }
          });
        } catch (lessonError) {
          logger.warn('save_session: Failed to store lesson', {
            requestId,
            error: lessonError.message
          });
        }
      }
    }

    // Return success response
    return {
      content: [
        {
          type: 'text',
          text: buildSuccessResponse({
            memoryId,
            summary: sessionSummary,
            decisionsCount: decisions.length,
            lessonsCount: lessons.length,
            platform,
            startTime,
            endTime
          })
        }
      ],
      metadata: {
        memoryId,
        decisionsCount: decisions.length,
        lessonsCount: lessons.length,
        autoSummarized: autoSummarize
      }
    };

  } catch (error) {
    logger.error('save_session: Tool execution failed', {
      requestId,
      error: error.message,
      stack: error.stack
    });

    throw error;
  }
}

async function waitForIngestCompletion(jobId, apiCall, logger, requestId, maxAttempts = 20, intervalMs = 500) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const status = await apiCall('GET', `/api/ingest/status?job_id=${jobId}`);

    if (status.status === 'completed' || status.status === 'Done') {
      return status.result || {};
    }

    if (status.status === 'failed' || status.failedReason) {
      throw new Error(`Session ingest failed: ${status.failedReason || 'unknown error'}`);
    }

    logger.info('save_session: Waiting for ingest completion', {
      requestId,
      jobId,
      attempt,
      stage: status.stage || status.status
    });

    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Session ingest timed out for job ${jobId}`);
}

async function resolveSessionMemoryId({ apiCall, summary, platform, tags }) {
  const search = await apiCall('POST', '/api/memories/search', {
    query: summary,
    project: 'session-memory',
    tags: [
      ...(tags || []),
      'session',
      platform
    ],
    source_platform: 'session',
    n_results: 1
  });

  return search.results?.[0]?.id || null;
}

// ==========================================
// Helper Functions
// ==========================================

/**
 * Build structured memory content from session data
 * 
 * @param {Object} params - Session data
 * @returns {string} Formatted memory content
 */
function buildSessionMemoryContent({
  summary,
  messages,
  decisions,
  lessons,
  platform,
  startTime,
  endTime,
  sessionId
}) {
  const lines = [
    `## Session Summary`,
    '',
    summary,
    '',
    '### Session Details',
    '',
    `- **Platform:** ${platform}`,
    `- **Start Time:** ${new Date(startTime).toLocaleString()}`,
    `- **End Time:** ${new Date(endTime).toLocaleString()}`,
    `- **Duration:** ${formatDuration(startTime, endTime)}`,
    `- **Message Count:** ${messages.length}`,
    sessionId ? `- **Session ID:** ${sessionId}` : null,
    '',
  ].filter(Boolean);

  if (decisions.length > 0) {
    lines.push('### Decisions Made', '');
    decisions.forEach((decision, index) => {
      lines.push(`${index + 1}. ${decision.content}`);
    });
    lines.push('');
  }

  if (lessons.length > 0) {
    lines.push('### Lessons Learned', '');
    lessons.forEach((lesson, index) => {
      lines.push(`${index + 1}. ${lesson.content}`);
    });
    lines.push('');
  }

  // Include key messages (first and last 3)
  if (messages.length > 6) {
    lines.push(
      '### Key Messages',
      '',
      '**Opening:**',
      `> ${messages[0]?.role}: ${messages[0]?.content?.substring(0, 200)}`,
      '',
      '**Closing:**',
      `> ${messages[messages.length - 1]?.role}: ${messages[messages.length - 1]?.content?.substring(0, 200)}`
    );
  }

  return lines.join('\n');
}

/**
 * Format duration between two ISO timestamps
 * 
 * @param {string} startTime - Start time (ISO 8601)
 * @param {string} endTime - End time (ISO 8601)
 * @returns {string} Formatted duration string
 */
function formatDuration(startTime, endTime) {
  const start = new Date(startTime);
  const end = new Date(endTime);
  const diffMs = end - start;
  
  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  
  if (hours > 0) {
    return `${hours}h ${remainingMinutes}m`;
  }
  return `${minutes}m`;
}

/**
 * Build success response for tool output
 * 
 * @param {Object} params - Result data
 * @returns {string} Formatted success message
 */
function buildSuccessResponse({
  memoryId,
  summary,
  decisionsCount,
  lessonsCount,
  platform,
  startTime,
  endTime
}) {
  const duration = formatDuration(startTime, endTime);
  
  return [
    `✅ **Session Saved Successfully!**`,
    '',
    `**Memory ID:** \`${memoryId}\``,
    `**Platform:** ${platform}`,
    `**Duration:** ${duration}`,
    `**Time:** ${new Date(startTime).toLocaleString()} - ${new Date(endTime).toLocaleString()}`,
    '',
    '### Summary',
    summary.substring(0, 500) + (summary.length > 500 ? '...' : ''),
    '',
    decisionsCount > 0 ? `**Decisions Captured:** ${decisionsCount}` : null,
    lessonsCount > 0 ? `**Lessons Captured:** ${lessonsCount}` : null,
    '',
    '_Session context will sync across all connected platforms via Meta-MCP Bridge._'
  ].filter(Boolean).join('\n');
}

/**
 * Validate session timestamps
 * Ensures startTime is before endTime and both are valid
 * 
 * @param {string} startTime - Start time (ISO 8601)
 * @param {string} endTime - End time (ISO 8601)
 * @returns {Object} Validation result
 */
export function validateSessionTimestamps(startTime, endTime) {
  const start = new Date(startTime);
  const end = new Date(endTime);
  
  if (isNaN(start.getTime())) {
    return { valid: false, error: 'Invalid startTime format' };
  }
  
  if (isNaN(end.getTime())) {
    return { valid: false, error: 'Invalid endTime format' };
  }
  
  if (start >= end) {
    return { valid: false, error: 'startTime must be before endTime' };
  }
  
  const now = new Date();
  const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);
  
  if (start > fiveMinutesFromNow) {
    return { valid: false, error: 'startTime cannot be in the future' };
  }
  
  return { valid: true };
}

/**
 * Calculate approximate token count for session
 * Used for context window management
 * 
 * @param {Array} messages - Array of message objects
 * @returns {number} Approximate token count
 */
export function calculateSessionTokenCount(messages) {
  const totalChars = messages.reduce((sum, msg) => {
    return sum + (msg.content?.length || 0);
  }, 0);
  
  // Rough estimate: 1 token ≈ 4 characters
  return Math.ceil(totalChars / 4);
}

export default saveSessionTool;
