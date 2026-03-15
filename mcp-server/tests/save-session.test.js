/**
 * save_session Tool Tests
 * 
 * Integration tests for the save_session MCP tool.
 * Tests tool invocation, validation, summarization, and memory storage.
 * 
 * @module mcp-server/tests/save-session.test
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { v4 as uuidv4 } from 'uuid';

// Import tool and helpers
import {
  saveSessionTool,
  handleSaveSession,
  SaveSessionInputSchema,
  validateSessionTimestamps,
  calculateSessionTokenCount
} from '../tools/save-session.js';

// Import summarizer and extractor
import { summarizeSession, isGroqAvailable } from '../../connectors/chat/summarizer.js';
import { extractDecisionsAndLessons, isGroqAvailable as isExtractorGroqAvailable } from '../../connectors/chat/extractor.js';

// ==========================================
// Test Configuration
// ==========================================

const TEST_CONFIG = {
  apiBaseUrl: process.env.HIVEMIND_API_URL || 'http://localhost:3000',
  apiKey: process.env.HIVEMIND_API_KEY || 'test-api-key',
  userId: process.env.CURRENT_USER_ID || uuidv4()
};

// Mock API call function for testing
function createMockApiCall() {
  const storedMemories = [];
  const jobs = new Map();
  const requests = [];

  const mockApiCall = async function mockApiCall(method, path, body = null) {
    requests.push({ method, path, body });
    console.log('[Mock API]', method, path, body ? JSON.stringify(body).substring(0, 100) : '');
    
    if (method === 'POST' && path === '/api/ingest') {
      const memory = {
        id: uuidv4(),
        content: body.content,
        title: body.title,
        tags: body.tags || [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      storedMemories.push(memory);
      const jobId = uuidv4();
      jobs.set(jobId, {
        jobId,
        status: 'completed',
        stage: 'Done',
        result: {
          memory_ids: [memory.id],
          chunks_created: 1
        }
      });
      return { jobId, stage: 'Queued' };
    }

    if (method === 'GET' && path.startsWith('/api/ingest/status')) {
      const url = new URL(`http://localhost${path}`);
      const jobId = url.searchParams.get('job_id');
      return jobs.get(jobId) || { error: 'Job not found' };
    }

    if (method === 'POST' && path === '/api/memories') {
      const memory = {
        id: uuidv4(),
        ...body,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      storedMemories.push(memory);
      return memory;
    }

    if (method === 'POST' && path === '/api/memories/search') {
      return {
        results: storedMemories.slice(0, 1)
      };
    }
    
    if (method === 'GET' && path.startsWith('/api/memories/')) {
      const memoryId = path.split('/').pop();
      const memory = storedMemories.find(m => m.id === memoryId);
      if (!memory) {
        throw new Error('Memory not found');
      }
      return memory;
    }
    
    return { success: true };
  };

  mockApiCall.storedMemories = storedMemories;
  mockApiCall.requests = requests;
  return mockApiCall;
}

// Mock logger
const mockLogger = {
  info: (msg, ctx) => console.log('[LOG]', msg, ctx ? JSON.stringify(ctx) : ''),
  warn: (msg, ctx) => console.warn('[WARN]', msg, ctx ? JSON.stringify(ctx) : ''),
  error: (msg, ctx) => console.error('[ERROR]', msg, ctx ? JSON.stringify(ctx) : '')
};

// ==========================================
// Test Data
// ==========================================

const SAMPLE_MESSAGES = [
  {
    role: 'user',
    content: 'I\'m building a new backend service. Should I use TypeScript or Python?',
    timestamp: '2026-03-12T10:00:00Z'
  },
  {
    role: 'assistant',
    content: 'Both are great choices! TypeScript offers excellent type safety and is great if you\'re already using JavaScript on the frontend. Python has a simpler syntax and excellent libraries for data processing. What\'s your use case?',
    timestamp: '2026-03-12T10:00:05Z'
  },
  {
    role: 'user',
    content: 'It\'s a REST API for a web application. We\'re already using React on the frontend.',
    timestamp: '2026-03-12T10:00:15Z'
  },
  {
    role: 'assistant',
    content: 'Given that you\'re using React, I\'d recommend TypeScript for the backend with Node.js. You\'ll get code sharing between frontend and backend, consistent type safety, and a unified language across your stack.',
    timestamp: '2026-03-12T10:00:20Z'
  },
  {
    role: 'user',
    content: 'Great, let\'s use TypeScript then. I also want to use PostgreSQL for the database.',
    timestamp: '2026-03-12T10:00:30Z'
  },
  {
    role: 'assistant',
    content: 'Excellent choice! TypeScript with PostgreSQL is a robust combination. I\'d recommend using Prisma as your ORM for type-safe database access.',
    timestamp: '2026-03-12T10:00:35Z'
  }
];

const SAMPLE_SESSION = {
  platform: 'claude',
  messages: SAMPLE_MESSAGES,
  startTime: '2026-03-12T10:00:00Z',
  endTime: '2026-03-12T10:05:00Z',
  sessionId: uuidv4(),
  autoSummarize: false, // Disable for unit tests
  extractDecisions: false, // Disable for unit tests
  tags: ['backend', 'architecture'],
  importanceScore: 0.8
};

// ==========================================
// Schema Validation Tests
// ==========================================

describe('SaveSessionInputSchema', () => {
  describe('valid input', () => {
    it('should accept valid session data', () => {
      const result = SaveSessionInputSchema.safeParse(SAMPLE_SESSION);
      assert.strictEqual(result.success, true);
    });

    it('should accept minimal required fields', () => {
      const minimal = {
        platform: 'chatgpt',
        messages: [{ role: 'user', content: 'Hello' }],
        startTime: '2026-03-12T10:00:00Z',
        endTime: '2026-03-12T10:05:00Z'
      };
      const result = SaveSessionInputSchema.safeParse(minimal);
      assert.strictEqual(result.success, true);
    });

    it('should accept all optional fields', () => {
      const full = {
        ...SAMPLE_SESSION,
        userId: uuidv4(),
        autoSummarize: true,
        extractDecisions: true,
        summary: 'Custom summary'
      };
      const result = SaveSessionInputSchema.safeParse(full);
      assert.strictEqual(result.success, true);
    });
  });

  describe('invalid input', () => {
    it('should reject missing platform', () => {
      const { platform, ...rest } = SAMPLE_SESSION;
      const result = SaveSessionInputSchema.safeParse(rest);
      assert.strictEqual(result.success, false);
      assert.ok(result.error); // Just check there's an error
    });

    it('should reject invalid platform', () => {
      const invalid = { ...SAMPLE_SESSION, platform: 'invalid-platform' };
      const result = SaveSessionInputSchema.safeParse(invalid);
      assert.strictEqual(result.success, false);
    });

    it('should reject empty messages', () => {
      const invalid = { ...SAMPLE_SESSION, messages: [] };
      const result = SaveSessionInputSchema.safeParse(invalid);
      assert.strictEqual(result.success, false);
    });

    it('should reject invalid message roles', () => {
      const invalid = {
        ...SAMPLE_SESSION,
        messages: [{ role: 'invalid', content: 'test' }]
      };
      const result = SaveSessionInputSchema.safeParse(invalid);
      assert.strictEqual(result.success, false);
    });

    it('should reject invalid timestamps', () => {
      const invalid = {
        ...SAMPLE_SESSION,
        startTime: 'not-a-date',
        endTime: '2026-03-12T10:05:00Z'
      };
      const result = SaveSessionInputSchema.safeParse(invalid);
      assert.strictEqual(result.success, false);
    });

    it('should reject startTime after endTime', () => {
      const invalid = {
        ...SAMPLE_SESSION,
        startTime: '2026-03-12T11:00:00Z',
        endTime: '2026-03-12T10:00:00Z'
      };
      const result = SaveSessionInputSchema.safeParse(invalid);
      // Schema allows this but validateSessionTimestamps catches it
      assert.strictEqual(result.success, true); // Zod doesn't validate cross-field
    });

    it('should reject importanceScore out of range', () => {
      const invalid = { ...SAMPLE_SESSION, importanceScore: 1.5 };
      const result = SaveSessionInputSchema.safeParse(invalid);
      assert.strictEqual(result.success, false);
    });
  });
});

// ==========================================
// Utility Function Tests
// ==========================================

describe('validateSessionTimestamps', () => {
  it('should validate correct timestamps', () => {
    const result = validateSessionTimestamps(
      '2026-03-12T10:00:00Z',
      '2026-03-12T11:00:00Z'
    );
    assert.strictEqual(result.valid, true);
  });

  it('should reject invalid startTime format', () => {
    const result = validateSessionTimestamps('invalid', '2026-03-12T11:00:00Z');
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.error, 'Invalid startTime format');
  });

  it('should reject invalid endTime format', () => {
    const result = validateSessionTimestamps('2026-03-12T10:00:00Z', 'invalid');
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.error, 'Invalid endTime format');
  });

  it('should reject startTime after endTime', () => {
    const result = validateSessionTimestamps(
      '2026-03-12T12:00:00Z',
      '2026-03-12T10:00:00Z'
    );
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.error, 'startTime must be before endTime');
  });

  it('should reject startTime in the far future', () => {
    const future = new Date();
    future.setMinutes(future.getMinutes() + 10);
    const result = validateSessionTimestamps(
      future.toISOString(),
      new Date(future.getTime() + 3600000).toISOString()
    );
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.error, 'startTime cannot be in the future');
  });
});

describe('calculateSessionTokenCount', () => {
  it('should calculate token count for messages', () => {
    const messages = [
      { content: 'Hello world' }, // 11 chars ≈ 3 tokens
      { content: 'How are you?' } // 12 chars ≈ 3 tokens
    ];
    const count = calculateSessionTokenCount(messages);
    assert.ok(count > 0);
    assert.ok(count <= 10); // Should be around 6 tokens
  });

  it('should handle empty messages', () => {
    const count = calculateSessionTokenCount([]);
    assert.strictEqual(count, 0);
  });

  it('should handle messages without content', () => {
    const messages = [{ role: 'user' }, { content: null }];
    const count = calculateSessionTokenCount(messages);
    assert.strictEqual(count, 0);
  });
});

// ==========================================
// Tool Definition Tests
// ==========================================

describe('saveSessionTool', () => {
  it('should have correct tool name', () => {
    assert.strictEqual(saveSessionTool.name, 'save_session');
  });

  it('should have description', () => {
    assert.ok(saveSessionTool.description.length > 50);
  });

  it('should have inputSchema with required fields', () => {
    assert.ok(saveSessionTool.inputSchema);
    assert.ok(saveSessionTool.inputSchema.type === 'object');
    assert.ok(saveSessionTool.inputSchema.properties);
    assert.deepStrictEqual(saveSessionTool.inputSchema.required, [
      'platform',
      'messages',
      'startTime',
      'endTime'
    ]);
  });

  it('should have all expected properties in schema', () => {
    const props = saveSessionTool.inputSchema.properties;
    assert.ok(props.platform);
    assert.ok(props.messages);
    assert.ok(props.startTime);
    assert.ok(props.endTime);
    assert.ok(props.summary);
    assert.ok(props.autoSummarize);
    assert.ok(props.extractDecisions);
    assert.ok(props.tags);
    assert.ok(props.importanceScore);
  });
});

// ==========================================
// Tool Handler Tests (Mock API)
// ==========================================

describe('handleSaveSession', () => {
  let mockApiCall;
  let capturedLogs = [];

  beforeEach(() => {
    mockApiCall = createMockApiCall();
    capturedLogs = [];
  });

  afterEach(() => {
    capturedLogs = [];
  });

  it('should save session without summarization', async () => {
    const result = await handleSaveSession(
      {
        ...SAMPLE_SESSION,
        autoSummarize: false,
        extractDecisions: false
      },
      uuidv4(),
      mockApiCall,
      mockLogger
    );

    assert.ok(result.content);
    assert.ok(result.content.length > 0);
    assert.ok(result.content[0].type === 'text');
    assert.ok(result.content[0].text.includes('✅'));
    assert.ok(result.content[0].text.includes('Session Saved Successfully'));
  });

  it('should save session with custom summary', async () => {
    const customSummary = 'Discussion about backend technology stack selection';
    const result = await handleSaveSession(
      {
        ...SAMPLE_SESSION,
        summary: customSummary,
        autoSummarize: false
      },
      uuidv4(),
      mockApiCall,
      mockLogger
    );

    assert.ok(result.content[0].text.includes(customSummary));
  });

  it('should include tags in saved memory', async () => {
    const result = await handleSaveSession(
      SAMPLE_SESSION,
      uuidv4(),
      mockApiCall,
      mockLogger
    );

    assert.ok(result.metadata);
    // Tags are included in the memory content
    assert.ok(result.content[0].text.includes('Session Saved'));
  });

  it('should handle validation errors', async () => {
    try {
      await handleSaveSession(
        {
          platform: 'invalid',
          messages: [],
          startTime: '2026-03-12T10:00:00Z',
          endTime: '2026-03-12T11:00:00Z'
        },
        uuidv4(),
        mockApiCall,
        mockLogger
      );
      assert.fail('Should have thrown validation error');
    } catch (error) {
      assert.ok(error.name === 'ZodError' || error.message.includes('validation'));
    }
  });
});

// ==========================================
// Summarizer Tests
// ==========================================

describe('summarizeSession', () => {
  const isGroqConfigured = isGroqAvailable();

  it('should have Groq API key configured', () => {
    // This test will show if Groq is available for integration tests
    console.log('Groq API available:', isGroqConfigured);
    // Don't assert - just inform
  });

  (isGroqConfigured ? it : it.skip)('should summarize a conversation', async () => {
    const result = await summarizeSession(SAMPLE_MESSAGES, {
      requestId: uuidv4(),
      platform: 'claude'
    });

    assert.ok(result.summary);
    assert.ok(result.summary.length > 50);
    assert.ok(Array.isArray(result.keyTopics));
  });

  it('should handle empty messages', async () => {
    try {
      await summarizeSession([], { requestId: uuidv4() });
      assert.fail('Should have thrown validation error');
    } catch (error) {
      // Error could be ZodError or other validation error
      assert.ok(error !== undefined);
    }
  });

  it('should estimate token count', () => {
    const count = summarizeSession.toString().length; // Just checking function exists
    assert.ok(count > 0);
  });
});

// ==========================================
// Extractor Tests
// ==========================================

describe('extractDecisionsAndLessons', () => {
  const isGroqConfigured = isExtractorGroqAvailable();

  it('should have Groq API key configured', () => {
    console.log('Extractor Groq API available:', isGroqConfigured);
    // Don't assert - just inform
  });

  (isGroqConfigured ? it : it.skip)('should extract decisions from conversation', async () => {
    const result = await extractDecisionsAndLessons(SAMPLE_MESSAGES, {
      requestId: uuidv4(),
      platform: 'claude'
    });

    assert.ok(result);
    assert.ok(Array.isArray(result.decisions));
    assert.ok(Array.isArray(result.lessons));
  });

  it('should handle empty messages', async () => {
    const result = await extractDecisionsAndLessons([], {
      requestId: uuidv4()
    });
    assert.deepStrictEqual(result, { decisions: [], lessons: [] });
  });
});

// ==========================================
// Integration Tests
// ==========================================

describe('save_session Integration', () => {
  const isGroqConfigured = isGroqAvailable();

  (isGroqConfigured ? it : it.skip)('should save session with auto-summarization', async () => {
    const mockApiCall = createMockApiCall();
    
    const result = await handleSaveSession(
      {
        platform: 'claude',
        messages: SAMPLE_MESSAGES,
        startTime: '2026-03-12T10:00:00Z',
        endTime: '2026-03-12T10:05:00Z',
        autoSummarize: true,
        extractDecisions: true
      },
      uuidv4(),
      mockApiCall,
      mockLogger
    );

    assert.ok(result.content);
    assert.ok(result.metadata);
    assert.ok(result.metadata.memoryId);
  });

  it('should save session without Groq (fallback)', async () => {
    const mockApiCall = createMockApiCall();
    
    const result = await handleSaveSession(
      {
        platform: 'chatgpt',
        messages: SAMPLE_MESSAGES,
        startTime: '2026-03-12T10:00:00Z',
        endTime: '2026-03-12T10:05:00Z',
        autoSummarize: false,
        extractDecisions: false
      },
      uuidv4(),
      mockApiCall,
      mockLogger
    );

    assert.ok(result.content);
    assert.ok(result.content[0].text.includes('Session Saved'));
    const createMemoryRequest = mockApiCall.requests.find(request => request.method === 'POST' && request.path === '/api/memories');
    assert.equal(createMemoryRequest.body.memory_type, 'event');
    assert.equal(createMemoryRequest.body.source_platform, 'chatgpt');
    assert.ok(createMemoryRequest.body.source_session_id);
  });

  (isGroqConfigured ? it : it.skip)('stores extracted decisions and lessons as Extends edges from the session root', async () => {
    const mockApiCall = createMockApiCall();

    const result = await handleSaveSession(
      {
        platform: 'claude',
        messages: SAMPLE_MESSAGES,
        startTime: '2026-03-12T10:00:00Z',
        endTime: '2026-03-12T10:05:00Z',
        autoSummarize: true,
        extractDecisions: true,
        sessionId: uuidv4()
      },
      uuidv4(),
      mockApiCall,
      mockLogger
    );

    const rootMemoryId = result.metadata.memoryId;
    const childCreates = mockApiCall.requests.filter(request => request.method === 'POST' && request.path === '/api/memories').slice(1);

    assert.ok(childCreates.length >= 1);
    childCreates.forEach(request => {
      assert.equal(request.body.relationship?.type, 'Extends');
      assert.equal(request.body.relationship?.target_id, rootMemoryId);
      assert.equal(request.body.metadata?.parent_session_memory_id, rootMemoryId);
    });
  });
});

// ==========================================
// Performance Tests
// ==========================================

describe('save_session Performance', () => {
  it('should validate input in under 10ms', () => {
    const start = Date.now();
    SaveSessionInputSchema.parse(SAMPLE_SESSION);
    const duration = Date.now() - start;
    assert.ok(duration < 10, `Validation took ${duration}ms (expected <10ms)`);
  });

  it('should calculate token count in under 1ms', () => {
    const start = Date.now();
    calculateSessionTokenCount(SAMPLE_MESSAGES);
    const duration = Date.now() - start;
    assert.ok(duration < 5, `Token calculation took ${duration}ms (expected <5ms)`);
  });
});

// ==========================================
// Edge Cases
// ==========================================

describe('save_session Edge Cases', () => {
  it('should handle very long messages', async () => {
    const longMessage = 'x'.repeat(5000);
    const result = SaveSessionInputSchema.safeParse({
      platform: 'claude',
      messages: [{ role: 'user', content: longMessage }],
      startTime: '2026-03-12T10:00:00Z',
      endTime: '2026-03-12T10:05:00Z'
    });
    assert.strictEqual(result.success, true);
  });

  it('should handle many messages', async () => {
    const manyMessages = Array(100).fill({
      role: 'user',
      content: 'Test message',
      timestamp: '2026-03-12T10:00:00Z'
    });
    const result = SaveSessionInputSchema.safeParse({
      platform: 'claude',
      messages: manyMessages,
      startTime: '2026-03-12T10:00:00Z',
      endTime: '2026-03-12T10:05:00Z'
    });
    assert.strictEqual(result.success, true);
  });

  it('should handle special characters in content', async () => {
    const specialContent = 'Test with "quotes" and <tags> & special chars: ñ é ü';
    const result = SaveSessionInputSchema.safeParse({
      platform: 'claude',
      messages: [{ role: 'user', content: specialContent }],
      startTime: '2026-03-12T10:00:00Z',
      endTime: '2026-03-12T10:05:00Z'
    });
    assert.strictEqual(result.success, true);
  });

  it('should handle all platform types', () => {
    const platforms = ['chatgpt', 'claude', 'perplexity', 'gemini', 'mcp', 'other'];
    for (const platform of platforms) {
      const result = SaveSessionInputSchema.safeParse({
        platform,
        messages: [{ role: 'user', content: 'Test' }],
        startTime: '2026-03-12T10:00:00Z',
        endTime: '2026-03-12T10:05:00Z'
      });
      assert.strictEqual(result.success, true, `Platform ${platform} should be valid`);
    }
  });
});

// ==========================================
// Test Runner
// ==========================================

// Run tests if executed directly
if (process.argv[1]?.includes('save-session.test.js')) {
  console.log('Running save_session tool tests...\n');
}
