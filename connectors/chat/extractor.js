/**
 * Decision and Lesson Extractor
 * 
 * Uses Groq API to extract decisions and lessons from chat sessions.
 * Identifies explicit choices, preferences, architectural decisions, and learned insights.
 * 
 * @module connectors/chat/extractor
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
  maxMessagesForExtraction: 50,
  minConfidenceThreshold: 0.6
};

const logger = createSafeLogger('Extractor');

// ==========================================
// Input/Output Schemas
// ==========================================

/**
 * Schema for extraction input
 */
const ExtractionInputSchema = z.array(
  z.object({
    role: z.enum(['user', 'assistant', 'system']),
    content: z.string(),
    timestamp: z.string().datetime().optional()
  })
);

/**
 * Schema for a single decision
 */
const DecisionSchema = z.object({
  title: z.string().max(200),
  content: z.string(),
  confidence: z.number().min(0).max(1),
  context: z.string().optional(),
  category: z.enum(['technology', 'architecture', 'preference', 'process', 'other']).optional()
});

/**
 * Schema for a single lesson
 */
const LessonSchema = z.object({
  title: z.string().max(200),
  content: z.string(),
  confidence: z.number().min(0).max(1),
  context: z.string().optional(),
  applicability: z.enum(['general', 'project-specific', 'technology-specific', 'process']).optional()
});

/**
 * Schema for extraction output
 */
const ExtractionOutputSchema = z.object({
  decisions: z.array(DecisionSchema),
  lessons: z.array(LessonSchema)
});

// ==========================================
// Main Extraction Function
// ==========================================

/**
 * Extract decisions and lessons from a chat session
 * 
 * @param {Array} messages - Array of conversation messages
 * @param {Object} options - Extraction options
 * @param {string} options.requestId - Request ID for tracing
 * @param {string} options.platform - Platform where session occurred
 * @returns {Promise<Object>} Extraction result with decisions and lessons arrays
 * 
 * @throws {Error} If Groq API call fails
 * @throws {ZodError} If input validation fails
 * 
 * @example
 * const result = await extractDecisionsAndLessons([
 *   { role: 'user', content: 'Let\'s use TypeScript for the backend' },
 *   { role: 'assistant', content: 'Great choice! TypeScript provides...' }
 * ], { requestId: 'uuid', platform: 'claude' });
 * 
 * console.log(result.decisions); // [{ title: 'Backend Language', content: 'Use TypeScript...', confidence: 0.95 }]
 * console.log(result.lessons); // [{ title: 'Type Safety', content: 'TypeScript catches errors early...', confidence: 0.8 }]
 */
export async function extractDecisionsAndLessons(messages, options = {}) {
  const { requestId = 'unknown', platform = 'unknown' } = options;
  
  // Validate input
  const validatedMessages = ExtractionInputSchema.parse(messages);
  
  // Check API key
  if (!CONFIG.groqApiKey) {
    logger.warn('GROQ_API_KEY not set, skipping extraction');
    return { decisions: [], lessons: [] };
  }
  
  // Truncate messages if too long
  const truncatedMessages = validatedMessages.length > CONFIG.maxMessagesForExtraction
    ? validatedMessages.slice(-CONFIG.maxMessagesForExtraction)
    : validatedMessages;
  
  logger.info(`Processing ${truncatedMessages.length} messages for extraction`, {
    requestId,
    platform
  });
  
  // Build prompt for extraction
  const prompt = buildExtractionPrompt(truncatedMessages, platform);
  
  // Call Groq API with retry logic
  let lastError;
  for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      const response = await callGroqAPI(prompt, {
        requestId,
        attempt,
        temperature: 0.2, // Lower temperature for more precise extraction
        maxTokens: 1500
      });
      
      // Parse the response
      const parsed = parseExtractionResponse(response);
      
      // Filter by confidence threshold
      const filteredDecisions = parsed.decisions.filter(d => d.confidence >= CONFIG.minConfidenceThreshold);
      const filteredLessons = parsed.lessons.filter(l => l.confidence >= CONFIG.minConfidenceThreshold);
      
      logger.info('Extraction complete', {
        requestId,
        decisionsCount: filteredDecisions.length,
        lessonsCount: filteredLessons.length,
        totalDecisions: parsed.decisions.length,
        totalLessons: parsed.lessons.length
      });
      
      return {
        decisions: filteredDecisions,
        lessons: filteredLessons
      };
      
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
  
  logger.warn(`Extraction failed after ${CONFIG.maxRetries + 1} attempts, returning empty`, {
    requestId,
    lastError: lastError.message
  });
  
  return { decisions: [], lessons: [] };
}

// ==========================================
// Prompt Building
// ==========================================

/**
 * Build the extraction prompt for Groq API
 * 
 * @param {Array} messages - Conversation messages
 * @param {string} platform - Platform identifier
 * @returns {Array} Messages array for Groq API
 */
function buildExtractionPrompt(messages, platform) {
  // Format messages for the prompt
  const conversationText = messages.map(msg => {
    const role = msg.role === 'assistant' ? 'Assistant' : msg.role === 'user' ? 'User' : 'System';
    const timestamp = msg.timestamp ? ` [${new Date(msg.timestamp).toLocaleTimeString()}]` : '';
    return `${role}${timestamp}: ${msg.content}`;
  }).join('\n\n');
  
  return [
    {
      role: 'system',
      content: `You are an expert analyst specializing in extracting decisions and lessons from conversations. Your task is to identify explicit choices, preferences, and insights that should be remembered for future context.

**What to Extract:**

DECISIONS (choices made during the conversation):
- Technology choices (languages, frameworks, tools)
- Architecture decisions (patterns, structures, approaches)
- Stated preferences (likes, dislikes, requirements)
- Process decisions (workflows, methodologies)
- Any explicit "let's use X" or "I prefer Y" statements

LESSONS (insights and learnings):
- General principles discovered
- Best practices identified
- Warnings or caveats learned
- "I learned that..." moments
- Insights about how things work

**Your Output Format (JSON):**
{
  "decisions": [
    {
      "title": "Short descriptive title (e.g., 'Backend Language Choice')",
      "content": "Clear statement of the decision (e.g., 'Use TypeScript for backend development')",
      "confidence": 0.95,
      "context": "Optional: brief context about why this was decided",
      "category": "technology|architecture|preference|process|other"
    }
  ],
  "lessons": [
    {
      "title": "Short descriptive title",
      "content": "Clear statement of the lesson learned",
      "confidence": 0.85,
      "context": "Optional: brief context",
      "applicability": "general|project-specific|technology-specific|process"
    }
  ]
}

**Confidence Scoring:**
- 0.9-1.0: Explicit, unambiguous statement ("We will use TypeScript")
- 0.7-0.9: Strong implication ("TypeScript would be best for this")
- 0.6-0.7: Reasonable inference ("Sounds like TypeScript is the way to go")
- Below 0.6: Don't include (too uncertain)

**Guidelines:**
- Only extract explicit or strongly implied decisions/lessons
- Don't extract suggestions or options that weren't chosen
- Prefer direct quotes when possible
- Be conservative - better to miss than to extract incorrectly
- Platform: ${platform}`
    },
    {
      role: 'user',
      content: `Please analyze this conversation and extract all decisions and lessons:

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
    temperature = 0.2,
    maxTokens = 1500
  } = options;
  
  const url = `${CONFIG.groqBaseUrl}/chat/completions`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CONFIG.groqApiKey}`,
      'User-Agent': 'HIVE-MIND-Extractor/1.0.0'
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
 * Parse the extraction response from Groq API
 * 
 * @param {string} response - Raw response text
 * @returns {Object} Parsed and validated result
 * 
 * @throws {Error} If response cannot be parsed
 */
function parseExtractionResponse(response) {
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
    logger.warn('JSON parse failed, returning empty', {
      error: parseError.message
    });
    return { decisions: [], lessons: [] };
  }
  
  // Validate and transform output schema
  const result = {
    decisions: [],
    lessons: []
  };
  
  // Parse decisions
  if (Array.isArray(parsed.decisions)) {
    for (const decision of parsed.decisions) {
      const validated = DecisionSchema.safeParse(decision);
      if (validated.success) {
        result.decisions.push(validated.data);
      } else {
        // Try to create a minimal valid decision
        if (decision.content) {
          result.decisions.push({
            title: decision.title || 'Decision',
            content: decision.content,
            confidence: decision.confidence || 0.7,
            context: decision.context,
            category: decision.category || 'other'
          });
        }
      }
    }
  }
  
  // Parse lessons
  if (Array.isArray(parsed.lessons)) {
    for (const lesson of parsed.lessons) {
      const validated = LessonSchema.safeParse(lesson);
      if (validated.success) {
        result.lessons.push(validated.data);
      } else {
        // Try to create a minimal valid lesson
        if (lesson.content) {
          result.lessons.push({
            title: lesson.title || 'Lesson Learned',
            content: lesson.content,
            confidence: lesson.confidence || 0.7,
            context: lesson.context,
            applicability: lesson.applicability || 'general'
          });
        }
      }
    }
  }
  
  return result;
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
 * Check if Groq API is available
 * 
 * @returns {boolean} True if API key is configured
 */
export function isGroqAvailable() {
  return !!CONFIG.groqApiKey;
}

/**
 * Get extractor configuration
 * 
 * @returns {Object} Current configuration
 */
export function getExtractorConfig() {
  return {
    model: CONFIG.groqModel,
    timeout: CONFIG.timeout,
    maxRetries: CONFIG.maxRetries,
    minConfidenceThreshold: CONFIG.minConfidenceThreshold,
    maxMessagesForExtraction: CONFIG.maxMessagesForExtraction,
    isAvailable: isGroqAvailable()
  };
}

/**
 * Manually extract decisions from text using pattern matching
 * Fallback when Groq API is unavailable
 * 
 * @param {Array} messages - Conversation messages
 * @returns {Object} Extracted decisions and lessons
 */
export function extractWithPatterns(messages) {
  const decisions = [];
  const lessons = [];
  
  // Decision patterns
  const decisionPatterns = [
    /let's use\s+(.+)/i,
    /we (should|will|'ll) use\s+(.+)/i,
    /i (prefer|like|want)\s+(.+)/i,
    /we (decided|chose|selected)\s+(.+)/i,
    /(go with|stick with|use)\s+(.+)/i,
    /our (stack|approach|choice) (is|will be)\s+(.+)/i
  ];
  
  // Lesson patterns
  const lessonPatterns = [
    /i learned (that|:)\s*(.+)/i,
    /it turns out (that|:)\s*(.+)/i,
    /the key (insight|takeaway|lesson) (is|was)\s+(.+)/i,
    /important (to know|note|remember) (that|:)\s*(.+)/i,
    /best practice (is|:)\s+(.+)/i
  ];
  
  for (const msg of messages) {
    const content = msg.content;
    
    // Check for decisions
    for (const pattern of decisionPatterns) {
      const match = content.match(pattern);
      if (match) {
        decisions.push({
          title: 'Extracted Decision',
          content: match[0],
          confidence: 0.65, // Lower confidence for pattern matching
          category: 'other'
        });
        break;
      }
    }
    
    // Check for lessons
    for (const pattern of lessonPatterns) {
      const match = content.match(pattern);
      if (match) {
        lessons.push({
          title: 'Extracted Lesson',
          content: match[0],
          confidence: 0.65,
          applicability: 'general'
        });
        break;
      }
    }
  }
  
  return { decisions, lessons };
}

export default {
  extractDecisionsAndLessons,
  extractWithPatterns,
  isGroqAvailable,
  getExtractorConfig
};
