/**
 * Session Summarizer
 * 
 * Uses Groq API to summarize chat sessions and extract key information.
 * Generates concise summaries while preserving important context, decisions, and action items.
 * 
 * @module connectors/chat/summarizer
 */

import { z } from 'zod';
import { createSafeLogger } from '../../mcp-server/safe-logger.js';

// ==========================================
// Configuration
// ==========================================

const CONFIG = {
  groqApiKey: process.env.GROQ_API_KEY,
  groqModel: process.env.GROQ_INFERENCE_MODEL || 'llama-3.3-70b-versatile',
  groqBaseUrl: 'https://api.groq.com/openai/v1',
  timeout: 30000, // 30 seconds
  maxRetries: 2,
  maxSummaryLength: 2000,
  maxMessagesForSummarization: 50
};

const logger = createSafeLogger('Summarizer');

// ==========================================
// Input/Output Schemas
// ==========================================

/**
 * Schema for summarization input
 */
const SummarizationInputSchema = z.array(
  z.object({
    role: z.enum(['user', 'assistant', 'system']),
    content: z.string(),
    timestamp: z.string().datetime().optional()
  })
);

/**
 * Schema for summarization output
 */
const SummarizationOutputSchema = z.object({
  summary: z.string().max(CONFIG.maxSummaryLength),
  keyTopics: z.array(z.string()),
  extracted: z.object({
    decisions: z.array(z.string()).optional(),
    actionItems: z.array(z.string()).optional(),
    questions: z.array(z.string()).optional()
  }).optional()
});

// ==========================================
// Main Summarization Function
// ==========================================

/**
 * Summarize a chat session using Groq API
 * 
 * @param {Array} messages - Array of conversation messages
 * @param {Object} options - Summarization options
 * @param {string} options.requestId - Request ID for tracing
 * @param {string} options.platform - Platform where session occurred
 * @returns {Promise<Object>} Summarization result with summary and extracted content
 * 
 * @throws {Error} If Groq API call fails
 * @throws {ZodError} If input validation fails
 * 
 * @example
 * const result = await summarizeSession([
 *   { role: 'user', content: 'What should I use for backend?' },
 *   { role: 'assistant', content: 'TypeScript is great for backend...' }
 * ], { requestId: 'uuid', platform: 'claude' });
 * 
 * console.log(result.summary); // "Discussion about backend technology choices..."
 * console.log(result.extracted.decisions); // ["Use TypeScript for backend"]
 */
export async function summarizeSession(messages, options = {}) {
  const { requestId = 'unknown', platform = 'unknown' } = options;
  
  // Validate input
  const validatedMessages = SummarizationInputSchema.parse(messages);
  
  // Check API key
  if (!CONFIG.groqApiKey) {
    throw new Error('GROQ_API_KEY environment variable is not set');
  }
  
  // Truncate messages if too long
  const truncatedMessages = validatedMessages.length > CONFIG.maxMessagesForSummarization
    ? validatedMessages.slice(-CONFIG.maxMessagesForSummarization)
    : validatedMessages;
  
  logger.info(`Processing ${truncatedMessages.length} messages for session`, {
    requestId,
    platform
  });
  
  // Build prompt for summarization
  const prompt = buildSummarizationPrompt(truncatedMessages, platform);
  
  // Call Groq API with retry logic
  let lastError;
  for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      const response = await callGroqAPI(prompt, {
        requestId,
        attempt,
        temperature: 0.3, // Lower temperature for more focused summaries
        maxTokens: 1000
      });
      
      // Parse the response
      const parsed = parseSummarizationResponse(response);
      
      logger.info('Summarization complete', {
        requestId,
        summaryLength: parsed.summary.length,
        decisionsCount: parsed.extracted?.decisions?.length || 0,
        actionItemsCount: parsed.extracted?.actionItems?.length || 0
      });
      
      return parsed;
      
    } catch (error) {
      lastError = error;
      logger.warn(`Attempt ${attempt + 1} failed`, {
        requestId,
        error: error.message
      });
      
      if (attempt < CONFIG.maxRetries) {
        // Exponential backoff
        const delay = Math.pow(2, attempt) * 1000;
        await sleep(delay);
      }
    }
  }
  
  throw new Error(`Summarization failed after ${CONFIG.maxRetries + 1} attempts: ${lastError.message}`);
}

// ==========================================
// Prompt Building
// ==========================================

/**
 * Build the summarization prompt for Groq API
 * 
 * @param {Array} messages - Conversation messages
 * @param {string} platform - Platform identifier
 * @returns {Array} Messages array for Groq API
 */
function buildSummarizationPrompt(messages, platform) {
  // Format messages for the prompt
  const conversationText = messages.map(msg => {
    const role = msg.role === 'assistant' ? 'Assistant' : msg.role === 'user' ? 'User' : 'System';
    const timestamp = msg.timestamp ? ` [${new Date(msg.timestamp).toLocaleTimeString()}]` : '';
    return `${role}${timestamp}: ${msg.content}`;
  }).join('\n\n');
  
  return [
    {
      role: 'system',
      content: `You are an expert conversation analyst specializing in extracting key information from AI chat sessions. Your task is to create concise, actionable summaries that preserve important context, decisions, and insights.

**Your Output Format (JSON):**
{
  "summary": "A concise 2-4 paragraph summary of the entire conversation, capturing the main topics, flow, and outcomes. Focus on what matters for future context.",
  "keyTopics": ["topic1", "topic2", "topic3"],
  "extracted": {
    "decisions": ["Decision 1", "Decision 2"],
    "actionItems": ["Action item 1", "Action item 2"],
    "questions": ["Unresolved question 1", "Unresolved question 2"]
  }
}

**Guidelines:**
- Summary should be 150-300 words, focused on substance over pleasantries
- Extract ALL explicit decisions made (technology choices, architectural decisions, preferences stated)
- Capture action items and next steps mentioned
- Note any unresolved questions or open threads
- Preserve technical details, code preferences, and user preferences
- Ignore small talk and filler content
- Write in third person, objective tone
- Platform: ${platform}`
    },
    {
      role: 'user',
      content: `Please analyze this conversation and provide a structured summary:

${conversationText}

---

Provide your analysis in valid JSON format only, no markdown or additional text.`
    }
  ];
}

// ==========================================
// Groq API Integration
// ==========================================

/**
 * Call Groq API for chat completion
 * 
 * @param {Array} messages - Messages for chat completion
 * @param {Object} options - API options
 * @param {string} options.requestId - Request ID for tracing
 * @param {number} options.attempt - Retry attempt number
 * @param {number} options.temperature - Temperature for generation
 * @param {number} options.maxTokens - Maximum tokens to generate
 * @returns {Promise<string>} Generated text
 * 
 * @throws {Error} If API call fails
 */
async function callGroqAPI(messages, options = {}) {
  const {
    requestId,
    attempt = 0,
    temperature = 0.3,
    maxTokens = 1000
  } = options;
  
  const url = `${CONFIG.groqBaseUrl}/chat/completions`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CONFIG.groqApiKey}`,
      'User-Agent': 'HIVE-MIND-Summarizer/1.0.0'
    },
    body: JSON.stringify({
      model: CONFIG.groqModel,
      messages,
      temperature,
      max_tokens: maxTokens,
      top_p: 0.95,
      frequency_penalty: 0.1,
      presence_penalty: 0.1,
      stream: false,
      stop: ['</json>', '```']
    }),
    signal: AbortSignal.timeout(CONFIG.timeout)
  });
  
  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'Unknown error');
    throw new Error(`Groq API error (${response.status}): ${errorBody}`);
  }
  
  const data = await response.json();
  
  if (!data.choices || !data.choices[0]?.message?.content) {
    throw new Error('Invalid response from Groq API');
  }
  
  return data.choices[0].message.content;
}

// ==========================================
// Response Parsing
// ==========================================

/**
 * Parse the summarization response from Groq API
 * 
 * @param {string} response - Raw response text
 * @returns {Object} Parsed and validated result
 * 
 * @throws {Error} If response cannot be parsed
 */
function parseSummarizationResponse(response) {
  // Clean up the response (remove markdown code blocks if present)
  let cleanedResponse = response.trim();
  
  // Remove markdown code blocks
  if (cleanedResponse.startsWith('```json')) {
    cleanedResponse = cleanedResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  } else if (cleanedResponse.startsWith('```')) {
    cleanedResponse = cleanedResponse.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }
  
  // Try to extract JSON if wrapped in text
  const jsonMatch = cleanedResponse.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    cleanedResponse = jsonMatch[0];
  }
  
  // Parse JSON
  let parsed;
  try {
    parsed = JSON.parse(cleanedResponse);
  } catch (parseError) {
    logger.warn('JSON parse failed, using fallback extraction', {
      error: parseError.message
    });
    return createFallbackSummary(response);
  }
  
  // Validate output schema
  const validated = SummarizationOutputSchema.safeParse(parsed);
  
  if (!validated.success) {
    logger.warn('Output validation failed, using raw parsed data');
    // Return with defaults for missing fields
    return {
      summary: parsed.summary || 'Session summary not available.',
      keyTopics: parsed.keyTopics || [],
      extracted: {
        decisions: parsed.extracted?.decisions || [],
        actionItems: parsed.extracted?.actionItems || [],
        questions: parsed.extracted?.questions || []
      }
    };
  }
  
  return validated.data;
}

/**
 * Create a fallback summary when JSON parsing fails
 * 
 * @param {string} response - Raw response text
 * @returns {Object} Fallback summary object
 */
function createFallbackSummary(response) {
  // Extract what we can from the text
  const lines = response.split('\n').filter(line => line.trim().length > 0);
  
  return {
    summary: response.substring(0, CONFIG.maxSummaryLength),
    keyTopics: [],
    extracted: {
      decisions: [],
      actionItems: [],
      questions: []
    }
  };
}

// ==========================================
// Utility Functions
// ==========================================

/**
 * Sleep for a specified duration
 * 
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate token estimate for messages
 * 
 * @param {Array} messages - Array of messages
 * @returns {number} Estimated token count
 */
export function estimateTokenCount(messages) {
  const totalChars = messages.reduce((sum, msg) => {
    return sum + (msg.content?.length || 0);
  }, 0);
  
  // Rough estimate: 1 token ≈ 4 characters
  return Math.ceil(totalChars / 4);
}

/**
 * Check if Groq API is available
 * 
 * @returns {boolean} True if API key is configured
 */
export function isGroqAvailable() {
  return !!CONFIG.groqApiKey;
}

/**
 * Get summarizer configuration
 * 
 * @returns {Object} Current configuration
 */
export function getSummarizerConfig() {
  return {
    model: CONFIG.groqModel,
    timeout: CONFIG.timeout,
    maxRetries: CONFIG.maxRetries,
    maxSummaryLength: CONFIG.maxSummaryLength,
    maxMessagesForSummarization: CONFIG.maxMessagesForSummarization,
    isAvailable: isGroqAvailable()
  };
}

export default {
  summarizeSession,
  estimateTokenCount,
  isGroqAvailable,
  getSummarizerConfig
};
