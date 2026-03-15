/**
 * Contextual Retrieval Pipeline Tests
 * Tests for Groq Situationalizer and Context Injection Pipeline
 *
 * @module tests/contextual
 * @description Unit and integration tests for Contextual Retrieval Pipeline
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GroqSituationalizer, ContextualPipeline, getSituationalizer } from '../src/situationalizer.js';
import { getMistralEmbedService } from '../src/embeddings/mistral.js';
import { MemoryEngine } from '../src/engine.local.js';

// ==========================================
// Mock Groq Client for Testing
// ==========================================

class MockGroqClient {
  constructor() {
    this.isAvailable = () => true;
  }

  async generate(prompt, options = {}) {
    // Simulate situationalizer response based on prompt content
    if (prompt.includes('FULL DOCUMENT') && prompt.includes('TEXT CHUNK')) {
      return 'This is from documentation about API integration; "The API endpoint allows for..."';
    }
    return 'Test response';
  }

  getUsage() {
    return {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150
    };
  }
}

// ==========================================
// GroqSituationalizer Tests
// ==========================================

describe('GroqSituationalizer', () => {
  let situationalizer;

  beforeEach(() => {
    // Create new instance with mock client
    situationalizer = new GroqSituationalizer({
      groq: {
        model: 'llama-3-3-70b-versatile',
        temperature: 0.3,
        maxTokens: 150
      }
    });
    
    // Replace real Groq client with mock
    situationalizer.groqClient = new MockGroqClient();
  });

  afterEach(() => {
    situationalizer.clearCache();
  });

  describe('generateContext', () => {
    it('should generate situational context for a chunk', async () => {
      const result = await situationalizer.generateContext({
        fullDocument: 'Q3 2025 Financial Report: Revenue grew by 15% from Q2. Cloud services revenue increased by 25%. Overall profit margin improved to 22%.',
        chunk: 'Cloud services revenue increased by 25%',
        source: 'q3-2025-financial-report.pdf',
        chunkIndex: 1
      });

      assert.strictEqual(typeof result, 'string');
      assert.ok(result.length > 10);
      assert.ok(result.toLowerCase().includes('financial'));
    });

    it('should use cache when available', async () => {
      const params = {
        fullDocument: 'Test document content',
        chunk: 'Test chunk',
        source: 'test.pdf',
        chunkIndex: 0
      };

      const result1 = await situationalizer.generateContext(params);
      const result2 = await situationalizer.generateContext(params);

      assert.strictEqual(result1, result2);

      const cacheStats = situationalizer.getCacheStats();
      assert.ok(cacheStats.hits >= 1);
    });

    it('should handle missing source gracefully', async () => {
      const result = await situationalizer.generateContext({
        fullDocument: 'Test content',
        chunk: 'Test chunk',
        source: null,
        chunkIndex: 0
      });

      assert.strictEqual(typeof result, 'string');
      assert.ok(result.toLowerCase().includes('document'));
    });

    it('should truncate long documents', async () => {
      const longDocument = 'A'.repeat(10000);
      const result = await situationalizer.generateContext({
        fullDocument: longDocument,
        chunk: 'Test chunk',
        source: 'test.pdf',
        chunkIndex: 0
      });

      assert.strictEqual(typeof result, 'string');
    });

    it('should handle empty chunk gracefully', async () => {
      const result = await situationalizer.generateContext({
        fullDocument: 'Test document',
        chunk: '',
        source: 'test.pdf',
        chunkIndex: 0
      });

      assert.strictEqual(typeof result, 'string');
    });
  });

  describe('generateContextBatch', () => {
    it('should process multiple chunks in batch', async () => {
      const paramsArray = [
        {
          fullDocument: 'Doc 1 content',
          chunk: 'Chunk 1',
          source: 'doc1.pdf',
          chunkIndex: 0
        },
        {
          fullDocument: 'Doc 2 content',
          chunk: 'Chunk 2',
          source: 'doc2.pdf',
          chunkIndex: 0
        }
      ];

      const results = await situationalizer.generateContextBatch(paramsArray);

      assert.ok(Array.isArray(results));
      assert.strictEqual(results.length, 2);
      assert.strictEqual(typeof results[0], 'string');
      assert.strictEqual(typeof results[1], 'string');
    });

    it('should handle empty batch', async () => {
      const results = await situationalizer.generateContextBatch([]);
      assert.ok(Array.isArray(results));
      assert.strictEqual(results.length, 0);
    });
  });

  describe('getStats', () => {
    it('should return situationalizer statistics', async () => {
      const stats = situationalizer.getStats();

      assert.ok(stats.model);
      assert.ok(stats.available !== undefined);
      assert.ok(stats.cacheStats);
      assert.ok(stats.tokenUsage);
    });
  });

  describe('_detectSourceType', () => {
    it('should detect PDF source type', () => {
      assert.strictEqual(situationalizer._detectSourceType('report.pdf'), 'report');
    });

    it('should detect markdown source type', () => {
      assert.strictEqual(situationalizer._detectSourceType('readme.md'), 'documentation');
    });

    it('should detect code source type', () => {
      assert.strictEqual(situationalizer._detectSourceType('app.js'), 'code');
      assert.strictEqual(situationalizer._detectSourceType('script.py'), 'code');
      assert.strictEqual(situationalizer._detectSourceType('module.ts'), 'code');
    });

    it('should detect conversation source type', () => {
      assert.strictEqual(situationalizer._detectSourceType('meeting.txt'), 'conversation');
      assert.strictEqual(situationalizer._detectSourceType('chat.log'), 'conversation');
    });

    it('should return unknown for unrecognized source', () => {
      assert.strictEqual(situationalizer._detectSourceType('unknown.xyz'), 'unknown');
    });
  });
});

// ==========================================
// ContextualPipeline Tests
// ==========================================

describe('ContextualPipeline', () => {
  let pipeline;
  let mockSituationalizer;

  beforeEach(() => {
    mockSituationalizer = new GroqSituationalizer({
      groq: {
        model: 'llama-3-3-70b-versatile',
        temperature: 0.3,
        maxTokens: 150
      }
    });
    mockSituationalizer.groqClient = new MockGroqClient();
    
    pipeline = new ContextualPipeline(mockSituationalizer);
  });

  describe('processChunk', () => {
    it('should process chunk through contextual pipeline', async () => {
      const result = await pipeline.processChunk({
        chunk: 'The API endpoint allows for CRUD operations on user data.',
        fullDocument: 'User Management API Documentation\n\nThis API provides endpoints for managing users.',
        source: 'api-docs.md',
        chunkIndex: 1
      });

      assert.ok(result.chunk);
      assert.ok(result.context);
      assert.ok(result.contextualizedText);
      assert.ok(result.chunkIndex !== undefined);
      assert.ok(result.source);
      assert.ok(result.processedAt);

      assert.ok(result.contextualizedText.includes(result.context));
      assert.ok(result.contextualizedText.includes(result.chunk));
    });

    it('should include latency in result', async () => {
      const result = await pipeline.processChunk({
        chunk: 'Test chunk',
        fullDocument: 'Test document',
        source: 'test.pdf',
        chunkIndex: 0
      });

      assert.ok(typeof result.latencyMs === 'number');
      assert.ok(result.latencyMs >= 0);
    });
  });

  describe('processChunks', () => {
    it('should process multiple chunks', async () => {
      const chunks = [
        { text: 'First chunk content', chunkIndex: 0 },
        { text: 'Second chunk content', chunkIndex: 1 },
        { text: 'Third chunk content', chunkIndex: 2 }
      ];

      const results = await pipeline.processChunks(
        chunks,
        'Full document content for all chunks',
        'test.pdf'
      );

      assert.ok(Array.isArray(results));
      assert.strictEqual(results.length, 3);

      results.forEach((result, index) => {
        assert.strictEqual(result.chunkIndex, index);
        assert.ok(result.contextualizedText.includes(result.context));
      });
    });
  });

  describe('getStats', () => {
    it('should return pipeline statistics', () => {
      const stats = pipeline.getStats();

      assert.ok(stats.situationalizer);
    });
  });
});

// ==========================================
// Integration Tests with MemoryEngine
// ==========================================

describe('MemoryEngine Contextual Pipeline Integration', () => {
  let engine;
  let mockSituationalizer;
  let mockEmbedService;

  beforeEach(() => {
    mockSituationalizer = new GroqSituationalizer({
      groq: {
        model: 'llama-3-3-70b-versatile',
        temperature: 0.3,
        maxTokens: 150
      }
    });
    mockSituationalizer.groqClient = new MockGroqClient();
    
    mockEmbedService = {
      embedBatch: async (texts) => {
        return texts.map(() => Array(1024).fill(0.1).map(() => Math.random()));
      },
      getModelInfo: () => ({
        name: 'mistral-embed',
        dimension: 1024,
        euDataResidency: true
      }),
      clearCache: () => {},
      getUsageStats: () => ({
        requestCount: 0,
        errorCount: 0,
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        cacheStats: { size: 0, hits: 0, misses: 0 }
      })
    };
    
    engine = new MemoryEngine({
      situationalizer: mockSituationalizer,
      embedService: mockEmbedService
    });
  });

  describe('processDocumentWithContext', () => {
    it('should process document through contextual pipeline', async () => {
      const content = `Q3 2025 Financial Report

Revenue Summary:
- Total Revenue: $5.2M (up 15% from Q2)
- Cloud Services: $2.1M (up 25%)
- On-premise: $3.1M (up 8%)

Profit Margin: 22% (improved from 18% in Q2)

The cloud services segment showed exceptional growth, driven by new enterprise contracts.`;

      const results = await engine.processDocumentWithContext({
        content,
        source: 'q3-2025-financial-report.pdf',
        userId: 'test-user',
        orgId: 'test-org',
        project: 'financial-reports'
      });

      assert.ok(Array.isArray(results));
      assert.ok(results.length > 0);

      results.forEach(chunk => {
        assert.ok(chunk.chunk);
        assert.ok(chunk.context);
        assert.ok(chunk.contextualizedText);
        assert.ok(chunk.embedding);
        assert.ok(chunk.embeddingDimension);
        assert.ok(chunk.userId);
        assert.ok(chunk.orgId);
        assert.ok(chunk.project);
        assert.ok(chunk.metadata);
      });

      assert.strictEqual(results[0].embeddingDimension, 1024);
      assert.strictEqual(results[0].embedding.length, 1024);
    });

    it('should handle documents that fit in single chunk', async () => {
      const content = 'Short document that fits in one chunk.';

      const results = await engine.processDocumentWithContext({
        content,
        source: 'short.txt',
        userId: 'test-user',
        orgId: 'test-org',
        project: 'test'
      });

      assert.ok(Array.isArray(results));
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].chunk, content);
    });

    it('should include pipeline metadata', async () => {
      const content = 'Test content for pipeline metadata.';

      const results = await engine.processDocumentWithContext({
        content,
        source: 'test.txt',
        userId: 'test-user',
        orgId: 'test-org',
        project: 'test',
        metadata: { customField: 'value' }
      });

      assert.strictEqual(results[0].metadata.pipeline, 'contextual');
      assert.ok(results[0].metadata.contextGeneratedAt);
      assert.strictEqual(results[0].metadata.customField, 'value');
    });
  });

  describe('_processDocumentWithoutContext', () => {
    it('should process without situationalizer', async () => {
      const content = 'Test content without situationalizer.';

      const results = await engine._processDocumentWithoutContext({
        content,
        source: 'test.txt',
        userId: 'test-user',
        orgId: 'test-org',
        project: 'test'
      });

      assert.ok(Array.isArray(results));
      assert.ok(results.length > 0);
      assert.strictEqual(results[0].metadata.pipeline, 'standard');
      assert.strictEqual(results[0].metadata.contextGeneratedAt, null);
    });
  });

  describe('storeMemory with contextual', () => {
    it('should store memory using contextual pipeline when enabled', async () => {
      const content = `Project Documentation

This project implements a memory engine with contextual retrieval.

Key Features:
- Graph-based relationships
- Contextual embedding generation
- Ebbinghaus decay for memory strength`;

      const result = await engine.storeMemory({
        content,
        user_id: 'test-user',
        org_id: 'test-org',
        project: 'memory-engine',
        tags: ['documentation', 'project'],
        source: 'project-docs.md',
        useContextual: true
      });

      assert.ok(Array.isArray(result.memories));
      assert.ok(result.memories.length > 0);

      result.memories.forEach(memory => {
        assert.ok(memory.tags.includes('contextual'));
        assert.ok(memory.metadata.originalChunk);
        assert.ok(memory.metadata.context);
        assert.ok(memory.metadata.chunkIndex !== undefined);
      });
    });

    it('should store memory without contextual pipeline when disabled', () => {
      const result = engine.storeMemory({
        content: 'Simple memory without context',
        user_id: 'test-user',
        org_id: 'test-org',
        project: 'test',
        tags: ['simple']
      });

      assert.ok(result.memory);
      assert.strictEqual(result.memory.content, 'Simple memory without context');
      assert.ok(!result.memory.tags.includes('contextual'));
    });
  });

  describe('getPipelineStats', () => {
    it('should return pipeline statistics', () => {
      const stats = engine.getPipelineStats();

      assert.ok(stats.situationalizer);
      assert.ok(stats.embedService);
      assert.ok(stats.pipelineConfig);

      assert.ok(stats.pipelineConfig.useSituationalizer !== undefined);
      assert.ok(stats.pipelineConfig.chunkSize);
      assert.ok(stats.pipelineConfig.chunkOverlap);
    });
  });
});

// ==========================================
// Edge Case Tests
// ==========================================

describe('Contextual Pipeline Edge Cases', () => {
  let engine;
  let mockSituationalizer;
  let mockEmbedService;

  beforeEach(() => {
    mockSituationalizer = new GroqSituationalizer({
      groq: {
        model: 'llama-3-3-70b-versatile',
        temperature: 0.3,
        maxTokens: 150
      }
    });
    mockSituationalizer.groqClient = new MockGroqClient();
    
    mockEmbedService = {
      embedBatch: async (texts) => {
        return texts.map(() => Array(1024).fill(0.1).map(() => Math.random()));
      },
      getModelInfo: () => ({
        name: 'mistral-embed',
        dimension: 1024,
        euDataResidency: true
      }),
      clearCache: () => {},
      getUsageStats: () => ({
        requestCount: 0,
        errorCount: 0,
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        cacheStats: { size: 0, hits: 0, misses: 0 }
      })
    };
    
    engine = new MemoryEngine({
      situationalizer: mockSituationalizer,
      embedService: mockEmbedService
    });
  });

  it('should handle very long documents', async () => {
    const content = 'A'.repeat(10000);

    const results = await engine.processDocumentWithContext({
      content,
      source: 'long.txt',
      userId: 'test-user',
      orgId: 'test-org',
      project: 'test'
    });

    assert.ok(Array.isArray(results));
    assert.ok(results.length > 0);

    results.forEach(r => {
      assert.strictEqual(r.embedding.length, 1024);
    });
  });

  it('should handle documents with special characters', async () => {
    const content = `Special characters test: @#$%^&*()
Unicode: café, naïve, 日本語
Emojis: 🚀 💡 🧠
Newlines and tabs:\n\tTest`;

    const results = await engine.processDocumentWithContext({
      content,
      source: 'special.txt',
      userId: 'test-user',
      orgId: 'test-org',
      project: 'test'
    });

    assert.ok(Array.isArray(results));
    assert.ok(results.length > 0);
  });

  it('should handle empty content gracefully', async () => {
    const results = await engine.processDocumentWithContext({
      content: '',
      source: 'empty.txt',
      userId: 'test-user',
      orgId: 'test-org',
      project: 'test'
    });

    assert.ok(Array.isArray(results));
  });

  it('should handle missing source gracefully', async () => {
    const content = 'Test content without source';

    const results = await engine.processDocumentWithContext({
      content,
      source: null,
      userId: 'test-user',
      orgId: 'test-org',
      project: 'test'
    });

    assert.ok(Array.isArray(results));
    assert.ok(results.length > 0);
  });

  it('should clear caches on engine reset', () => {
    engine.reset();

    const stats = engine.getPipelineStats();
    assert.strictEqual(stats.situationalizer.cacheStats.size, 0);
  });
});

// ==========================================
// Performance Tests
// ==========================================

describe('Contextual Pipeline Performance', () => {
  let engine;
  let mockSituationalizer;
  let mockEmbedService;

  beforeEach(() => {
    mockSituationalizer = new GroqSituationalizer({
      groq: {
        model: 'llama-3-3-70b-versatile',
        temperature: 0.3,
        maxTokens: 150
      }
    });
    mockSituationalizer.groqClient = new MockGroqClient();
    
    mockEmbedService = {
      embedBatch: async (texts) => {
        return texts.map(() => Array(1024).fill(0.1).map(() => Math.random()));
      },
      getModelInfo: () => ({
        name: 'mistral-embed',
        dimension: 1024,
        euDataResidency: true
      }),
      clearCache: () => {},
      getUsageStats: () => ({
        requestCount: 0,
        errorCount: 0,
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        cacheStats: { size: 0, hits: 0, misses: 0 }
      })
    };
    
    engine = new MemoryEngine({
      situationalizer: mockSituationalizer,
      embedService: mockEmbedService
    });
  });

  it('should process batch of chunks within reasonable time', async () => {
    const content = `Chunk 1: First paragraph of document.
Chunk 2: Second paragraph with more details.
Chunk 3: Third paragraph with additional context.
Chunk 4: Fourth paragraph concluding the document.
Chunk 5: Fifth paragraph with final notes.`;

    const startTime = Date.now();
    const results = await engine.processDocumentWithContext({
      content,
      source: 'performance-test.txt',
      userId: 'test-user',
      orgId: 'test-org',
      project: 'test'
    });
    const duration = Date.now() - startTime;

    assert.ok(duration < 30000);
    assert.ok(Array.isArray(results));
    assert.ok(results.length > 0);
  });

  it('should maintain embedding consistency', async () => {
    const content = 'Consistent content for embedding test.';

    const results1 = await engine.processDocumentWithContext({
      content,
      source: 'test1.txt',
      userId: 'test-user',
      orgId: 'test-org',
      project: 'test'
    });

    const results2 = await engine.processDocumentWithContext({
      content,
      source: 'test2.txt',
      userId: 'test-user',
      orgId: 'test-org',
      project: 'test'
    });

    assert.strictEqual(results1[0].embeddingDimension, results2[0].embeddingDimension);
    assert.strictEqual(results1[0].embedding.length, results2[0].embedding.length);
  });
});
