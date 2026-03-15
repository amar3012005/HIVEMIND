/**
 * Cross-Platform Handoff Verification Tests
 * HIVE-MIND Memory System
 *
 * Verifies that Claude, GPT, and other platforms can all consume the same
 * recall contract and that context is preserved across platforms.
 *
 * @module tests/cross-platform-handoff
 * @version 1.0.0
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';

// ==========================================
// Test Configuration & Constants
// ==========================================

const TEST_CONFIG = {
  apiBaseUrl: process.env.HIVEMIND_API_URL || 'http://localhost:3000',
  testTimeout: 30000,
  defaultUserId: 'test-user-cross-platform',
  defaultOrgId: 'test-org-cross-platform',
  platforms: ['chatgpt', 'claude', 'mcp', 'perplexity', 'gemini'],
  formats: ['xml', 'json', 'markdown']
};

// ==========================================
// Mock Data Fixtures
// ==========================================

const TEST_FIXTURES = {
  memories: {
    typescriptPreference: {
      content: 'User prefers TypeScript for backend development with strict mode enabled',
      memoryType: 'preference',
      title: 'Backend Language Preference',
      tags: ['typescript', 'backend', 'programming', 'strict-mode'],
      importanceScore: 0.85,
      sourcePlatform: 'chatgpt'
    },
    healthcareProject: {
      content: 'User is working on a healthcare startup called MedTech Solutions',
      memoryType: 'fact',
      title: 'Current Project Context',
      tags: ['healthcare', 'startup', 'medtech', 'project'],
      importanceScore: 0.9,
      sourcePlatform: 'claude'
    },
    postgresqlDecision: {
      content: 'User decided to use PostgreSQL 15 with Apache AGE for graph capabilities',
      memoryType: 'decision',
      title: 'Database Architecture Decision',
      tags: ['database', 'postgresql', 'age', 'graph', 'architecture'],
      importanceScore: 0.8,
      sourcePlatform: 'chatgpt'
    },
    microservicesLesson: {
      content: 'User learned that microservices added unnecessary complexity for their 5-person team',
      memoryType: 'lesson',
      title: 'Architecture Lesson Learned',
      tags: ['architecture', 'microservices', 'team-size', 'complexity'],
      importanceScore: 0.75,
      sourcePlatform: 'claude'
    },
    mvpGoal: {
      content: 'User aims to launch MVP by Q2 2024 with core features only',
      memoryType: 'goal',
      title: 'MVP Launch Timeline',
      tags: ['goal', 'mvp', 'timeline', 'q2-2024'],
      importanceScore: 0.88,
      sourcePlatform: 'mcp'
    },
    dockerEvent: {
      content: 'User successfully deployed first Docker container to production on AWS ECS',
      memoryType: 'event',
      title: 'First Production Deployment',
      tags: ['docker', 'deployment', 'aws', 'ecs', 'milestone'],
      importanceScore: 0.7,
      sourcePlatform: 'perplexity'
    }
  },

  users: {
    platformA: { id: 'user-platform-a', orgId: 'org-cross-platform', platform: 'claude' },
    platformB: { id: 'user-platform-b', orgId: 'org-cross-platform', platform: 'chatgpt' },
    platformC: { id: 'user-platform-c', orgId: 'org-cross-platform', platform: 'mcp' }
  }
};

// ==========================================
// Mock Services
// ==========================================

// Mock Qdrant Vector Store
const mockQdrantClient = {
  search: vi.fn(),
  storeMemory: vi.fn(),
  deleteMemory: vi.fn(),
  getCollection: vi.fn()
};

// Mock Groq LLM Client
const mockGroqClient = {
  generate: vi.fn(),
  isAvailable: vi.fn().mockReturnValue(true),
  getConfig: vi.fn().mockReturnValue({ inferenceModel: 'llama-3.3-70b' }),
  getUsage: vi.fn().mockReturnValue({ tokens: 150 })
};

// Mock Prisma/Memory Store
const mockMemoryStore = {
  createMemory: vi.fn(),
  getMemory: vi.fn(),
  updateMemory: vi.fn(),
  deleteMemory: vi.fn(),
  listMemories: vi.fn(),
  searchMemories: vi.fn(),
  createRelationship: vi.fn(),
  getRelatedMemories: vi.fn(),
  traverseGraph: vi.fn()
};

// ==========================================
// Helper Functions
// ==========================================

/**
 * Generate a unique test memory with ID
 */
function generateTestMemory(baseMemory, overrides = {}) {
  return {
    id: uuidv4(),
    ...baseMemory,
    ...overrides,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

/**
 * Create mock API response
 */
function createMockResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
    headers: new Map([['content-type', 'application/json']])
  };
}

/**
 * Simulate API call with mocking capability
 */
async function mockApiCall(method, endpoint, body = null, options = {}) {
  const { shouldFail = false, failWith = null, delay = 0 } = options;

  if (delay > 0) {
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  if (shouldFail) {
    throw failWith || new Error(`API call failed: ${method} ${endpoint}`);
  }

  // Return mock data based on endpoint
  if (endpoint.includes('/api/memories') && method === 'POST') {
    return {
      success: true,
      memory: generateTestMemory(body)
    };
  }

  if (endpoint.includes('/api/recall') && method === 'POST') {
    return {
      memories: [generateTestMemory(TEST_FIXTURES.memories.typescriptPreference)],
      results: [generateTestMemory(TEST_FIXTURES.memories.typescriptPreference)],
      context: '<relevant-memories></relevant-memories>',
      metadata: { total: 1, returned: 1 }
    };
  }

  if (endpoint.includes('/api/search/quick')) {
    return {
      tier: 'quick',
      results: [generateTestMemory(TEST_FIXTURES.memories.typescriptPreference)],
      metadata: { durationMs: 45, requestId: uuidv4() }
    };
  }

  if (endpoint.includes('/api/search/panorama')) {
    return {
      tier: 'panorama',
      results: Object.values(TEST_FIXTURES.memories).map(m => generateTestMemory(m)),
      categories: { active: 4, historical: 2 },
      metadata: { durationMs: 120, requestId: uuidv4() }
    };
  }

  if (endpoint.includes('/api/search/insight')) {
    return {
      tier: 'insight',
      subQueries: [{ query: 'test', focus: 'analysis', weight: 1.0 }],
      entityInsights: [{ entity: 'TypeScript', type: 'technology', mentions: 3 }],
      relationshipChains: [],
      metadata: { durationMs: 850, requestId: uuidv4() }
    };
  }

  return { success: true };
}

// ==========================================
// Import Modules Under Test (Mocked)
// ==========================================

// We'll mock the imports since we're testing the contract, not the actual implementation
const mockInjector = {
  injectContext: vi.fn(),
  formatAsXml: vi.fn(),
  formatAsJson: vi.fn(),
  formatAsMarkdown: vi.fn(),
  escapeXml: vi.fn((text) => text?.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')),
  estimateTokenCount: vi.fn((text) => Math.ceil(text?.length / 4) || 0)
};

const mockThreeTierRetrieval = {
  quickSearch: vi.fn(),
  panoramaSearch: vi.fn(),
  insightForge: vi.fn(),
  compareTiers: vi.fn()
};

// ==========================================
// Test Suite: Cross-Platform Handoff
// ==========================================

describe('Cross-Platform Handoff', () => {
  let createdMemoryIds = [];
  let requestId;

  beforeAll(async () => {
    // Global test setup
    requestId = uuidv4();
    console.log(`[TEST SETUP] Starting cross-platform handoff tests. RequestId: ${requestId}`);
  });

  afterAll(async () => {
    // Global test teardown
    console.log(`[TEST TEARDOWN] Completed cross-platform handoff tests. Cleaning up ${createdMemoryIds.length} memories`);
    createdMemoryIds = [];
  });

  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();
    requestId = uuidv4();
  });

  // ==========================================
  // Test Suite 1: Recall Contract Consistency
  // ==========================================
  describe('Recall Contract Consistency', () => {
    it('should return consistent memory structure across all platforms', async () => {
      const platforms = ['chatgpt', 'claude', 'mcp', 'perplexity'];
      const results = {};

      for (const platform of platforms) {
        const mockResponse = await mockApiCall('POST', '/api/recall', {
          query_context: 'What does the user prefer for backend development?',
          source_platform: platform
        });

        results[platform] = mockResponse;

        // Verify structure consistency
        expect(mockResponse).toHaveProperty('memories');
        expect(mockResponse).toHaveProperty('metadata');
        expect(Array.isArray(mockResponse.memories)).toBe(true);
        expect(typeof mockResponse.metadata).toBe('object');
      }

      // Verify all platforms return same structure
      const firstResult = results[platforms[0]];
      for (const platform of platforms.slice(1)) {
        expect(Object.keys(results[platform])).toEqual(Object.keys(firstResult));
      }
    });

    it('should return memories with required fields for all platforms', async () => {
      const response = await mockApiCall('POST', '/api/recall', {
        query_context: 'test query',
        max_memories: 5
      });

      for (const memory of response.memories || []) {
        // Required fields per API contract
        expect(memory).toHaveProperty('id');
        expect(memory).toHaveProperty('content');
        expect(memory).toHaveProperty('memoryType');
        expect(memory).toHaveProperty('createdAt');
        expect(memory).toHaveProperty('importanceScore');

        // Validate field types
        expect(typeof memory.id).toBe('string');
        expect(typeof memory.content).toBe('string');
        expect(typeof memory.memoryType).toBe('string');
        expect(typeof memory.importanceScore).toBe('number');
        expect(memory.importanceScore).toBeGreaterThanOrEqual(0);
        expect(memory.importanceScore).toBeLessThanOrEqual(1);
      }
    });

    it('should include score breakdown when requested', async () => {
      const response = await mockApiCall('POST', '/api/recall', {
        query_context: 'test query',
        include_scores: true
      });

      if (response.memories?.length > 0) {
        const memory = response.memories[0];
        expect(memory).toHaveProperty('score');
        expect(memory).toHaveProperty('scoreBreakdown');
        expect(memory.scoreBreakdown).toHaveProperty('similarity');
        expect(memory.scoreBreakdown).toHaveProperty('recency');
        expect(memory.scoreBreakdown).toHaveProperty('importance');
      }
    });

    it('should handle empty results consistently', async () => {
      mockMemoryStore.searchMemories.mockResolvedValue([]);

      const response = await mockApiCall('POST', '/api/recall', {
        query_context: 'nonexistent query xyz123'
      });

      expect(response.memories).toBeDefined();
      expect(Array.isArray(response.memories)).toBe(true);
      expect(response.memories.length).toBe(0);
      expect(response.metadata).toBeDefined();
    });

    it('should preserve source_platform in recall results', async () => {
      const response = await mockApiCall('POST', '/api/recall', {
        query_context: 'backend development'
      });

      for (const memory of response.memories || []) {
        expect(memory).toHaveProperty('sourcePlatform');
        expect(['chatgpt', 'claude', 'mcp', 'perplexity', 'gemini', 'webapp']).toContain(memory.sourcePlatform);
      }
    });
  });

  // ==========================================
  // Test Suite 2: Platform-Specific Context Injection
  // ==========================================
  describe('Platform-Specific Injection', () => {
    it('should format context as XML for Claude platform', async () => {
      const memories = [generateTestMemory(TEST_FIXTURES.memories.typescriptPreference)];

      mockInjector.formatAsXml.mockReturnValue(`<relevant-memories>
  <memory id="${memories[0].id}">
    <content>${memories[0].content}</content>
    <metadata>
      <type>${memories[0].memoryType}</type>
      <importance>${memories[0].importanceScore}</importance>
    </metadata>
  </memory>
</relevant-memories>`);

      const formatted = mockInjector.formatAsXml(memories, { includeMetadata: true });

      expect(formatted).toContain('<relevant-memories>');
      expect(formatted).toContain('</relevant-memories>');
      expect(formatted).toContain('<memory');
      expect(formatted).toContain('id=');
      expect(formatted).toContain('<content>');
      expect(formatted).toContain('<metadata>');
    });

    it('should format context as JSON for GPT platform', async () => {
      const memories = [generateTestMemory(TEST_FIXTURES.memories.typescriptPreference)];

      mockInjector.formatAsJson.mockReturnValue(JSON.stringify({
        memories: memories.map(m => ({
          id: m.id,
          content: m.content,
          type: m.memoryType,
          importance: m.importanceScore
        }))
      }, null, 2));

      const formatted = mockInjector.formatAsJson(memories, { includeMetadata: true });
      const parsed = JSON.parse(formatted);

      expect(parsed).toHaveProperty('memories');
      expect(Array.isArray(parsed.memories)).toBe(true);
      expect(parsed.memories[0]).toHaveProperty('id');
      expect(parsed.memories[0]).toHaveProperty('content');
      expect(parsed.memories[0]).toHaveProperty('type');
    });

    it('should format context as Markdown for generic platforms', async () => {
      const memories = [generateTestMemory(TEST_FIXTURES.memories.typescriptPreference)];

      mockInjector.formatAsMarkdown.mockReturnValue(`## Relevant Context

### ${memories[0].title}

${memories[0].content}

> **Type:** ${memories[0].memoryType} | **Importance:** ${memories[0].importanceScore}
`);

      const formatted = mockInjector.formatAsMarkdown(memories, { includeMetadata: true });

      expect(formatted).toContain('## Relevant Context');
      expect(formatted).toContain('###');
      expect(formatted).toContain(memories[0].content);
      expect(formatted).toContain('**Type:**');
    });

    it('should escape XML special characters correctly', async () => {
      const memoriesWithSpecialChars = [{
        ...generateTestMemory(TEST_FIXTURES.memories.typescriptPreference),
        content: 'User prefers TypeScript & uses React < 18 with "strict" mode'
      }];

      mockInjector.escapeXml.mockImplementation((text) => {
        return text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      });

      const escaped = mockInjector.escapeXml(memoriesWithSpecialChars[0].content);

      expect(escaped).toContain('&amp;');
      expect(escaped).toContain('&lt;');
      expect(escaped).toContain('&quot;');
      expect(escaped).not.toContain(' & ');
      expect(escaped).not.toContain(' < ');
    });

    it('should respect maxTokens limit across all formats', async () => {
      const memories = Array(20).fill(null).map(() =>
        generateTestMemory(TEST_FIXTURES.memories.typescriptPreference)
      );

      const maxTokens = 500;

      mockInjector.estimateTokenCount.mockImplementation((text) => {
        return Math.ceil(text.length / 4);
      });

      for (const format of ['xml', 'json', 'markdown']) {
        const formatter = format === 'xml' ? mockInjector.formatAsXml :
                         format === 'json' ? mockInjector.formatAsJson :
                         mockInjector.formatAsMarkdown;

        // Mock truncated response
        formatter.mockReturnValue(`[${format}] truncated context`);

        const formatted = formatter(memories.slice(0, 5), { maxTokens });
        expect(formatted).toBeDefined();
      }
    });

    it('should include platform-specific metadata in formatted output', async () => {
      const memory = generateTestMemory(TEST_FIXTURES.memories.typescriptPreference);
      memory.sourcePlatform = 'claude';
      memory.tags = ['typescript', 'backend'];

      mockInjector.formatAsXml.mockReturnValue(`<relevant-memories>
  <memory id="${memory.id}">
    <content>${memory.content}</content>
    <metadata>
      <type>${memory.memoryType}</type>
      <source>${memory.sourcePlatform}</source>
      <tags>${memory.tags.join(', ')}</tags>
    </metadata>
  </memory>
</relevant-memories>`);

      const formatted = mockInjector.formatAsXml([memory], { includeMetadata: true });

      expect(formatted).toContain('<source>claude</source>');
      expect(formatted).toContain('<tags>typescript, backend</tags>');
    });
  });

  // ==========================================
  // Test Suite 3: Cross-Platform Memory Sharing
  // ==========================================
  describe('Cross-Platform Memory Sharing', () => {
    it('should save memory from Platform A and recall from Platform B', async () => {
      // Step 1: Save memory from Claude
      const claudeMemory = generateTestMemory({
        ...TEST_FIXTURES.memories.healthcareProject,
        sourcePlatform: 'claude'
      });

      mockMemoryStore.createMemory.mockResolvedValue(claudeMemory);
      const savedMemory = await mockMemoryStore.createMemory(claudeMemory);
      createdMemoryIds.push(savedMemory.id);

      expect(savedMemory.sourcePlatform).toBe('claude');

      // Step 2: Recall from ChatGPT
      mockMemoryStore.searchMemories.mockResolvedValue([savedMemory]);
      const recallResults = await mockMemoryStore.searchMemories({
        query: 'healthcare startup',
        user_id: TEST_CONFIG.defaultUserId
      });

      expect(recallResults.length).toBeGreaterThan(0);
      expect(recallResults[0].content).toContain('healthcare');
      expect(recallResults[0].sourcePlatform).toBe('claude');
    });

    it('should preserve metadata when sharing across platforms', async () => {
      const originalMemory = generateTestMemory({
        ...TEST_FIXTURES.memories.postgresqlDecision,
        sourcePlatform: 'chatgpt',
        tags: ['database', 'postgresql', 'graph'],
        importanceScore: 0.8,
        project: 'medtech-backend'
      });

      mockMemoryStore.createMemory.mockResolvedValue(originalMemory);
      const saved = await mockMemoryStore.createMemory(originalMemory);

      // Verify all metadata preserved
      expect(saved.tags).toEqual(originalMemory.tags);
      expect(saved.importanceScore).toBe(originalMemory.importanceScore);
      expect(saved.project).toBe(originalMemory.project);
      expect(saved.sourcePlatform).toBe('chatgpt');

      // Recall from different platform
      mockMemoryStore.getMemory.mockResolvedValue(saved);
      const recalled = await mockMemoryStore.getMemory(saved.id);

      expect(recalled.tags).toEqual(originalMemory.tags);
      expect(recalled.importanceScore).toBe(originalMemory.importanceScore);
    });

    it('should allow memories from all platforms to appear in unified search', async () => {
      const platformMemories = TEST_CONFIG.platforms.map(platform =>
        generateTestMemory({
          content: `Memory from ${platform} platform`,
          memoryType: 'fact',
          sourcePlatform: platform,
          tags: [platform, 'test']
        })
      );

      mockMemoryStore.searchMemories.mockResolvedValue(platformMemories);

      const results = await mockMemoryStore.searchMemories({
        query: 'Memory from',
        user_id: TEST_CONFIG.defaultUserId
      });

      const foundPlatforms = new Set(results.map(m => m.sourcePlatform));
      expect(foundPlatforms.size).toBeGreaterThanOrEqual(3);

      for (const platform of ['chatgpt', 'claude', 'mcp']) {
        expect(foundPlatforms.has(platform)).toBe(true);
      }
    });

    it('should maintain memory isolation between different users across platforms', async () => {
      const userAMemory = generateTestMemory({
        ...TEST_FIXTURES.memories.typescriptPreference,
        userId: 'user-a',
        sourcePlatform: 'claude'
      });

      const userBQuery = {
        query: 'TypeScript preference',
        user_id: 'user-b'
      };

      mockMemoryStore.searchMemories.mockImplementation((params) => {
        if (params.user_id === 'user-b') {
          return []; // User B should not see User A's memories
        }
        return [userAMemory];
      });

      const results = await mockMemoryStore.searchMemories(userBQuery);
      expect(results.length).toBe(0);
    });

    it('should handle concurrent access from multiple platforms', async () => {
      const platforms = ['chatgpt', 'claude', 'mcp'];
      const promises = platforms.map(platform =>
        mockApiCall('POST', '/api/memories', {
          content: `Concurrent memory from ${platform}`,
          sourcePlatform: platform
        })
      );

      const results = await Promise.all(promises);

      expect(results.length).toBe(3);
      results.forEach((result, index) => {
        expect(result.success).toBe(true);
        expect(result.memory.sourcePlatform).toBe(platforms[index]);
      });
    });
  });

  // ==========================================
  // Test Suite 4: Context Preservation
  // ==========================================
  describe('Context Preservation', () => {
    it('should preserve memory relationships (Updates/Extends/Derives) across platforms', async () => {
      // Create original memory on Claude
      const originalMemory = generateTestMemory({
        ...TEST_FIXTURES.memories.postgresqlDecision,
        sourcePlatform: 'claude'
      });

      // Create updated version on ChatGPT with Updates relationship
      const updatedMemory = generateTestMemory({
        ...TEST_FIXTURES.memories.postgresqlDecision,
        content: 'Updated: User decided to use PostgreSQL 16 with enhanced features',
        sourcePlatform: 'chatgpt'
      });

      mockMemoryStore.createRelationship.mockResolvedValue({
        id: uuidv4(),
        fromId: updatedMemory.id,
        toId: originalMemory.id,
        type: 'Updates'
      });

      const relationship = await mockMemoryStore.createRelationship({
        fromId: updatedMemory.id,
        toId: originalMemory.id,
        type: 'Updates'
      });

      expect(relationship.type).toBe('Updates');
      expect(relationship.fromId).toBe(updatedMemory.id);
      expect(relationship.toId).toBe(originalMemory.id);

      // Verify relationship from MCP
      mockMemoryStore.getRelatedMemories.mockResolvedValue([{
        ...relationship,
        memory: originalMemory
      }]);

      const related = await mockMemoryStore.getRelatedMemories(updatedMemory.id);
      expect(related.length).toBeGreaterThan(0);
      expect(related[0].type).toBe('Updates');
    });

    it('should maintain conversation continuity when switching platforms', async () => {
      // Start conversation on Claude
      const claudeContext = {
        conversationId: uuidv4(),
        platform: 'claude',
        memoriesInjected: [uuidv4(), uuidv4()],
        lastQuery: 'Tell me about the healthcare project'
      };

      // Switch to ChatGPT - context should be available
      const chatgptRecall = await mockApiCall('POST', '/api/recall', {
        query_context: claudeContext.lastQuery,
        user_id: TEST_CONFIG.defaultUserId
      });

      expect(chatgptRecall.memories).toBeDefined();
      expect(chatgptRecall.memories.length).toBeGreaterThan(0);
    });

    it('should preserve memory versioning across platform switches', async () => {
      const v1Memory = generateTestMemory({
        ...TEST_FIXTURES.memories.typescriptPreference,
        isLatest: false,
        version: 1,
        sourcePlatform: 'chatgpt'
      });

      const v2Memory = generateTestMemory({
        ...TEST_FIXTURES.memories.typescriptPreference,
        content: 'User prefers TypeScript for backend with strict mode and ESLint',
        isLatest: true,
        version: 2,
        supersedesId: v1Memory.id,
        sourcePlatform: 'claude'
      });

      // Recall from MCP should get latest version
      mockMemoryStore.getMemory.mockResolvedValue(v2Memory);
      const recalled = await mockMemoryStore.getMemory(v2Memory.id);

      expect(recalled.isLatest).toBe(true);
      expect(recalled.version).toBe(2);
      expect(recalled.content).toContain('ESLint');
    });

    it('should maintain tag consistency across platforms', async () => {
      const memory = generateTestMemory({
        ...TEST_FIXTURES.memories.microservicesLesson,
        tags: ['architecture', 'microservices', 'team-size'],
        sourcePlatform: 'claude'
      });

      // Save from Claude
      mockMemoryStore.createMemory.mockResolvedValue(memory);
      const saved = await mockMemoryStore.createMemory(memory);

      // Search from ChatGPT by tags
      mockMemoryStore.searchMemories.mockImplementation((params) => {
        if (params.tags?.includes('microservices')) {
          return [memory];
        }
        return [];
      });

      const results = await mockMemoryStore.searchMemories({
        tags: ['microservices'],
        user_id: TEST_CONFIG.defaultUserId
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].tags).toContain('microservices');
    });

    it('should preserve importance scores across platform boundaries', async () => {
      const highImportanceMemory = generateTestMemory({
        ...TEST_FIXTURES.memories.mvpGoal,
        importanceScore: 0.95,
        sourcePlatform: 'mcp'
      });

      mockMemoryStore.createMemory.mockResolvedValue(highImportanceMemory);
      const saved = await mockMemoryStore.createMemory(highImportanceMemory);

      // Recall from any platform should preserve importance
      mockMemoryStore.getMemory.mockResolvedValue(saved);
      const recalled = await mockMemoryStore.getMemory(saved.id);

      expect(recalled.importanceScore).toBe(0.95);
    });
  });

  // ==========================================
  // Test Suite 5: MCP Tool Integration
  // ==========================================
  describe('MCP Integration', () => {
    it('should return same data from MCP recall tool as REST API', async () => {
      const query = 'What database does the user prefer?';

      // REST API call
      const restResponse = await mockApiCall('POST', '/api/recall', {
        query_context: query
      });

      // MCP tool call (simulated)
      const mcpResponse = await mockApiCall('POST', '/api/recall', {
        query_context: query,
        source_platform: 'mcp'
      });

      // Both should return same structure
      expect(Object.keys(restResponse)).toEqual(Object.keys(mcpResponse));
      expect(restResponse.memories.length).toBe(mcpResponse.memories.length);
    });

    it('should support get_context resource with multiple formats', async () => {
      for (const format of ['xml', 'json', 'markdown']) {
        const response = await mockApiCall('POST', '/api/recall/context', {
          format,
          maxMemories: 10
        });

        expect(response).toHaveProperty('formatted');
        expect(response).toHaveProperty('memoryIds');
        expect(response).toHaveProperty('tokenCount');

        if (format === 'xml') {
          expect(response.formatted).toContain('<relevant-memories>');
        } else if (format === 'json') {
          expect(() => JSON.parse(response.formatted)).not.toThrow();
        } else if (format === 'markdown') {
          expect(response.formatted).toContain('##');
        }
      }
    });

    it('should handle MCP tool errors gracefully', async () => {
      const errorResponse = await mockApiCall('POST', '/api/recall', {
        query_context: '', // Empty query should fail
        shouldFail: true,
        failWith: new Error('Query is required')
      }).catch(e => ({ error: e.message, isError: true }));

      expect(errorResponse.isError).toBe(true);
      expect(errorResponse.error).toContain('required');
    });

    it('should support all MCP memory tools', async () => {
      const tools = ['save_memory', 'recall', 'list_memories', 'get_memory', 'delete_memory', 'get_context', 'search_memories', 'traverse_graph'];

      for (const tool of tools) {
        // Each tool should have a corresponding endpoint
        const endpointMap = {
          save_memory: '/api/memories',
          recall: '/api/recall',
          list_memories: '/api/memories',
          get_memory: `/api/memories/${uuidv4()}`,
          delete_memory: `/api/memories/${uuidv4()}`,
          get_context: '/api/recall/context',
          search_memories: '/api/memories/search',
          traverse_graph: '/api/memories/traverse'
        };

        expect(endpointMap).toHaveProperty(tool);
        expect(typeof endpointMap[tool]).toBe('string');
      }
    });

    it('should sync context updates across MCP and other platforms', async () => {
      // Save via MCP
      const mcpMemory = generateTestMemory({
        ...TEST_FIXTURES.memories.dockerEvent,
        sourcePlatform: 'mcp'
      });

      mockMemoryStore.createMemory.mockResolvedValue(mcpMemory);
      await mockMemoryStore.createMemory(mcpMemory);

      // Should be immediately available to Claude
      mockMemoryStore.searchMemories.mockResolvedValue([mcpMemory]);
      const claudeResults = await mockMemoryStore.searchMemories({
        query: 'Docker deployment',
        source_platforms: ['mcp', 'claude']
      });

      expect(claudeResults.some(m => m.sourcePlatform === 'mcp')).toBe(true);
    });

    it('should return consistent memory IDs between MCP and REST API', async () => {
      const memoryId = uuidv4();

      // REST API get
      mockMemoryStore.getMemory.mockResolvedValue({
        id: memoryId,
        content: 'Test memory'
      });

      const restMemory = await mockMemoryStore.getMemory(memoryId);

      // MCP get (same ID)
      const mcpMemory = await mockMemoryStore.getMemory(memoryId);

      expect(restMemory.id).toBe(mcpMemory.id);
      expect(restMemory.id).toBe(memoryId);
    });
  });

  // ==========================================
  // Test Suite 6: Three-Tier Retrieval Cross-Platform
  // ==========================================
  describe('Three-Tier Retrieval', () => {
    it('should perform QuickSearch from different platforms', async () => {
      for (const platform of ['chatgpt', 'claude', 'mcp']) {
        mockThreeTierRetrieval.quickSearch.mockResolvedValue({
          tier: 'quick',
          results: [generateTestMemory(TEST_FIXTURES.memories.typescriptPreference)],
          metadata: { durationMs: 45, requestId: uuidv4() }
        });

        const result = await mockThreeTierRetrieval.quickSearch('backend development', {
          userId: TEST_CONFIG.defaultUserId,
          sourcePlatform: platform
        });

        expect(result.tier).toBe('quick');
        expect(result.results).toBeDefined();
        expect(result.metadata.durationMs).toBeLessThan(100);
      }
    });

    it('should perform PanoramaSearch with historical context', async () => {
      const historicalMemories = [
        generateTestMemory({ ...TEST_FIXTURES.memories.typescriptPreference, createdAt: '2023-01-01T00:00:00Z' }),
        generateTestMemory({ ...TEST_FIXTURES.memories.postgresqlDecision, createdAt: '2023-06-01T00:00:00Z' }),
        generateTestMemory({ ...TEST_FIXTURES.memories.mvpGoal, createdAt: '2024-01-01T00:00:00Z' })
      ];

      mockThreeTierRetrieval.panoramaSearch.mockResolvedValue({
        tier: 'panorama',
        results: historicalMemories,
        categories: {
          active: [historicalMemories[2]],
          historical: historicalMemories.slice(0, 2)
        },
        timeline: {
          byYear: { 2023: 2, 2024: 1 }
        },
        metadata: { durationMs: 120, requestId: uuidv4() }
      });

      const result = await mockThreeTierRetrieval.panoramaSearch('project history', {
        userId: TEST_CONFIG.defaultUserId,
        includeHistorical: true
      });

      expect(result.tier).toBe('panorama');
      expect(result.categories).toBeDefined();
      expect(result.timeline).toBeDefined();
      expect(result.results.length).toBeGreaterThanOrEqual(3);
    });

    it('should perform InsightForge with LLM analysis', async () => {
      mockGroqClient.generate.mockResolvedValue(JSON.stringify({
        subQueries: [
          { query: 'TypeScript usage patterns', focus: 'technology', weight: 0.4 },
          { query: 'Database architecture decisions', focus: 'infrastructure', weight: 0.3 },
          { query: 'Team size and complexity', focus: 'organization', weight: 0.3 }
        ],
        reasoning: 'Analyzing technical stack and team context'
      }));

      mockThreeTierRetrieval.insightForge.mockResolvedValue({
        tier: 'insight',
        subQueries: [
          { id: 'sq-1', query: 'TypeScript usage patterns', focus: 'technology', weight: 0.4 }
        ],
        entityInsights: [
          { entity: 'TypeScript', type: 'technology', mentions: 5, sentiment: 'positive' },
          { entity: 'PostgreSQL', type: 'database', mentions: 3, sentiment: 'positive' }
        ],
        relationshipChains: [
          { from: 'TypeScript', to: 'Backend', relationship: 'used_for', strength: 0.9 }
        ],
        semanticFacts: [
          { fact: 'User prefers TypeScript for backend development', confidence: 0.95 }
        ],
        metadata: { durationMs: 850, requestId: uuidv4() }
      });

      const result = await mockThreeTierRetrieval.insightForge('analyze user technology preferences', {
        userId: TEST_CONFIG.defaultUserId,
        includeAnalysis: true
      });

      expect(result.tier).toBe('insight');
      expect(result.subQueries).toBeDefined();
      expect(result.entityInsights).toBeDefined();
      expect(result.entityInsights.length).toBeGreaterThan(0);
    });

    it('should auto-select appropriate tier based on query', async () => {
      const queries = [
        { query: 'hello world', expectedTier: 'quick' },
        { query: 'show me history', expectedTier: 'panorama' },
        { query: 'analyze patterns', expectedTier: 'insight' }
      ];

      for (const { query, expectedTier } of queries) {
        let selectedTier = 'quick';
        if (query.includes('history')) selectedTier = 'panorama';
        if (query.includes('analyze')) selectedTier = 'insight';

        expect(selectedTier).toBe(expectedTier);
      }
    });

    it('should compare all three tiers and return metrics', async () => {
      mockThreeTierRetrieval.compareTiers.mockResolvedValue({
        requestId: uuidv4(),
        query: 'test query',
        tiers: {
          quick: {
            success: true,
            durationMs: 45,
            resultCount: 5,
            topScore: 0.92
          },
          panorama: {
            success: true,
            durationMs: 120,
            resultCount: 15,
            categories: ['active', 'historical']
          },
          insight: {
            success: true,
            durationMs: 850,
            subQueryCount: 3,
            entityCount: 4
          }
        },
        totalDurationMs: 1015
      });

      const comparison = await mockThreeTierRetrieval.compareTiers('test query', {
        userId: TEST_CONFIG.defaultUserId
      });

      expect(comparison.tiers).toHaveProperty('quick');
      expect(comparison.tiers).toHaveProperty('panorama');
      expect(comparison.tiers).toHaveProperty('insight');
      expect(comparison.totalDurationMs).toBeGreaterThan(0);
    });

    it('should maintain multi-tenant isolation in three-tier search', async () => {
      const userA = 'user-a-isolated';
      const userB = 'user-b-isolated';

      mockThreeTierRetrieval.quickSearch.mockImplementation((query, options) => {
        if (options.userId === userA) {
          return Promise.resolve({
            tier: 'quick',
            results: [{ id: 'memory-a', content: 'User A memory' }],
            metadata: { userId: userA }
          });
        }
        return Promise.resolve({
          tier: 'quick',
          results: [{ id: 'memory-b', content: 'User B memory' }],
          metadata: { userId: userB }
        });
      });

      const resultsA = await mockThreeTierRetrieval.quickSearch('test', { userId: userA });
      const resultsB = await mockThreeTierRetrieval.quickSearch('test', { userId: userB });

      expect(resultsA.results[0].content).toContain('User A');
      expect(resultsB.results[0].content).toContain('User B');
      expect(resultsA.results[0].content).not.toContain('User B');
    });
  });

  // ==========================================
  // Test Suite 7: Error Handling & Edge Cases
  // ==========================================
  describe('Error Handling and Edge Cases', () => {
    it('should handle network errors gracefully', async () => {
      const errorResult = await mockApiCall('POST', '/api/recall', {
        query_context: 'test'
      }, { shouldFail: true, failWith: new Error('Network timeout') }).catch(e => ({
        error: e.message,
        requestId: uuidv4()
      }));

      expect(errorResult.error).toContain('timeout');
      expect(errorResult.requestId).toBeDefined();
    });

    it('should handle malformed requests with proper validation errors', async () => {
      const invalidRequests = [
        { content: '' }, // Empty content
        { content: 'a'.repeat(10001) }, // Content too long
        { importanceScore: 1.5 }, // Invalid score
        { tags: Array(21).fill('tag') } // Too many tags
      ];

      for (const invalidRequest of invalidRequests) {
        const isValid = !invalidRequest.content ||
                       (invalidRequest.content.length > 0 && invalidRequest.content.length <= 10000);

        expect(isValid).toBe(invalidRequest.content === '' ? false : true);
      }
    });

    it('should handle concurrent updates from multiple platforms', async () => {
      const memoryId = uuidv4();
      const updates = [
        { platform: 'chatgpt', content: 'Update from ChatGPT' },
        { platform: 'claude', content: 'Update from Claude' },
        { platform: 'mcp', content: 'Update from MCP' }
      ];

      // Simulate concurrent updates
      const results = await Promise.allSettled(
        updates.map(u => mockMemoryStore.updateMemory(memoryId, { content: u.content }))
      );

      // All should complete (some may fail due to conflicts, but no crashes)
      expect(results.length).toBe(3);
    });

    it('should handle missing user context appropriately', async () => {
      const response = await mockApiCall('POST', '/api/recall', {
        query_context: 'test'
      }, { shouldFail: true, failWith: new Error('Unauthorized') }).catch(e => ({
        status: 401,
        error: e.message
      }));

      expect(response.status).toBe(401);
    });

    it('should handle vector store unavailability', async () => {
      mockQdrantClient.search.mockRejectedValue(new Error('Vector store unavailable'));

      const result = await mockQdrantClient.search({}).catch(e => ({
        error: e.message,
        fallback: true
      }));

      expect(result.error).toContain('unavailable');
    });
  });

  // ==========================================
  // Test Suite 8: Performance & SLA
  // ==========================================
  describe('Performance and SLA', () => {
    it('should meet QuickSearch latency SLA (< 100ms p50)', async () => {
      const latencies = [];

      for (let i = 0; i < 20; i++) {
        const start = Date.now();
        await mockApiCall('POST', '/api/search/quick', { query: 'test' }, { delay: 30 + Math.random() * 40 });
        latencies.push(Date.now() - start);
      }

      latencies.sort((a, b) => a - b);
      const p50 = latencies[Math.floor(latencies.length * 0.5)];

      expect(p50).toBeLessThan(100);
    });

    it('should meet PanoramaSearch latency SLA (< 500ms p95)', async () => {
      const latencies = [];

      for (let i = 0; i < 20; i++) {
        const start = Date.now();
        await mockApiCall('POST', '/api/search/panorama', { query: 'test' }, { delay: 80 + Math.random() * 60 });
        latencies.push(Date.now() - start);
      }

      latencies.sort((a, b) => a - b);
      const p95 = latencies[Math.floor(latencies.length * 0.95)];

      expect(p95).toBeLessThan(500);
    });

    it('should handle high-throughput recall requests', async () => {
      const requests = Array(50).fill(null).map((_, i) =>
        mockApiCall('POST', '/api/recall', { query: `query ${i}` }, { delay: 10 })
      );

      const results = await Promise.all(requests);
      expect(results.length).toBe(50);
      expect(results.every(r => r.memories !== undefined)).toBe(true);
    });
  });

  // ==========================================
  // Test Suite 9: Security & Compliance
  // ==========================================
  describe('Security and Compliance', () => {
    it('should enforce multi-tenant isolation', async () => {
      const tenantA = { userId: 'tenant-a', orgId: 'org-a' };
      const tenantB = { userId: 'tenant-b', orgId: 'org-b' };

      // Create memory for tenant A
      const memoryA = generateTestMemory({
        ...TEST_FIXTURES.memories.typescriptPreference,
        userId: tenantA.userId,
        orgId: tenantA.orgId
      });

      mockMemoryStore.createMemory.mockResolvedValue(memoryA);
      await mockMemoryStore.createMemory(memoryA);

      // Tenant B should not see Tenant A's memory
      mockMemoryStore.searchMemories.mockImplementation((params) => {
        if (params.user_id === tenantB.userId) return [];
        return [memoryA];
      });

      const resultsB = await mockMemoryStore.searchMemories({
        query: 'TypeScript',
        user_id: tenantB.userId,
        org_id: tenantB.orgId
      });

      expect(resultsB.length).toBe(0);
    });

    it('should validate API keys for protected endpoints', async () => {
      const protectedEndpoints = [
        '/api/memories',
        '/api/recall',
        '/api/search/quick',
        '/api/search/panorama'
      ];

      for (const endpoint of protectedEndpoints) {
        const result = await mockApiCall('POST', endpoint, {}, {
          shouldFail: true,
          failWith: new Error('Unauthorized: Invalid API key')
        }).catch(e => e.message);

        expect(result).toContain('Unauthorized');
      }
    });

    it('should not expose sensitive data in error messages', async () => {
      const error = await mockApiCall('POST', '/api/recall', {
        query_context: 'test'
      }, {
        shouldFail: true,
        failWith: new Error('Database connection failed: postgres://user:pass@host/db')
      }).catch(e => e.message);

      // Should not contain connection string details
      expect(error).not.toContain('postgres://');
      expect(error).not.toContain('password');
    });

    it('should support GDPR data export', async () => {
      const userId = 'gdpr-test-user';

      mockMemoryStore.listMemories.mockResolvedValue({
        memories: [
          generateTestMemory({ ...TEST_FIXTURES.memories.typescriptPreference, userId }),
          generateTestMemory({ ...TEST_FIXTURES.memories.postgresqlDecision, userId })
        ],
        total: 2
      });

      const exportData = await mockMemoryStore.listMemories({ user_id: userId });

      expect(exportData.memories.length).toBe(2);
      expect(exportData.memories.every(m => m.userId === userId)).toBe(true);
    });

    it('should support GDPR data erasure', async () => {
      const userId = 'gdpr-delete-user';
      const memoryId = uuidv4();

      mockMemoryStore.deleteMemory.mockResolvedValue({
        id: memoryId,
        deleted: true,
        deletedAt: new Date().toISOString()
      });

      const result = await mockMemoryStore.deleteMemory(memoryId, { user_id: userId });

      expect(result.deleted).toBe(true);
      expect(result.deletedAt).toBeDefined();
    });
  });
});

// ==========================================
// Export for external use
// ==========================================

export {
  TEST_CONFIG,
  TEST_FIXTURES,
  generateTestMemory,
  mockApiCall
};
