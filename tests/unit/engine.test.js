/**
 * HIVE-MIND - Core Engine Unit Tests
 * Tests for MemoryEngine class and core functionality
 * 
 * Run: node --test tests/unit/engine.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { MemoryEngine } from '../../core/src/engine.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';

describe('MemoryEngine', () => {
  let engine;
  let tempDir;
  let dbPath;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'hivemind-test-'));
    dbPath = join(tempDir, 'test.db');
    engine = new MemoryEngine(dbPath);
  });

  afterEach(() => {
    if (engine) {
      engine.close();
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Initialization', () => {
    it('should create in-memory database by default', () => {
      const inMemoryEngine = new MemoryEngine();
      assert.ok(inMemoryEngine);
      inMemoryEngine.close();
    });

    it('should create database at specified path', () => {
      assert.ok(engine);
      const stats = engine.getStats('test-user', 'test-org');
      assert.strictEqual(stats.total_memories, 0);
    });
  });

  describe('storeMemory', () => {
    it('should store a new memory with required fields', () => {
      const memory = engine.storeMemory({
        content: 'Test memory content',
        user_id: 'user-123',
        org_id: 'org-456'
      });

      assert.ok(memory.id);
      assert.strictEqual(memory.content, 'Test memory content');
      assert.strictEqual(memory.user_id, 'user-123');
      assert.strictEqual(memory.org_id, 'org-456');
      assert.strictEqual(memory.is_latest, true);
      assert.strictEqual(memory.strength, 1.0);
      assert.strictEqual(memory.recall_count, 0);
    });

    it('should store memory with optional fields', () => {
      const memory = engine.storeMemory({
        content: 'Memory with metadata',
        user_id: 'user-123',
        org_id: 'org-456',
        project: 'TestProject',
        tags: ['tag1', 'tag2'],
        source: 'test-source',
        metadata: { custom: 'value' },
        document_date: '2025-01-01'
      });

      assert.strictEqual(memory.project, 'TestProject');
      assert.deepStrictEqual(memory.tags, ['tag1', 'tag2']);
      assert.strictEqual(memory.source, 'test-source');
      assert.deepStrictEqual(memory.metadata, { custom: 'value' });
      assert.strictEqual(memory.document_date, '2025-01-01');
    });

    it('should create relationship when specified', () => {
      const memory1 = engine.storeMemory({
        content: 'Initial memory',
        user_id: 'user-123',
        org_id: 'org-456'
      });

      const memory2 = engine.storeMemory({
        content: 'Updated memory',
        user_id: 'user-123',
        org_id: 'org-456',
        relationship: {
          type: 'Updates',
          target_id: memory1.id
        }
      });

      assert.ok(memory2);
      
      // Verify memory1 is no longer latest
      const memory1Updated = engine.getMemory(memory1.id);
      assert.strictEqual(memory1Updated.memory.is_latest, false);
      
      // Verify memory2 is latest
      assert.strictEqual(memory2.is_latest, true);
    });

    it('should handle all relationship types', () => {
      const memory1 = engine.storeMemory({
        content: 'Base memory',
        user_id: 'user-123',
        org_id: 'org-456'
      });

      // Test Updates relationship
      const memory2 = engine.storeMemory({
        content: 'Updates memory',
        user_id: 'user-123',
        org_id: 'org-456',
        relationship: { type: 'Updates', target_id: memory1.id }
      });

      // Test Extends relationship
      const memory3 = engine.storeMemory({
        content: 'Extends memory',
        user_id: 'user-123',
        org_id: 'org-456',
        relationship: { type: 'Extends', target_id: memory1.id }
      });

      // Test Derives relationship
      const memory4 = engine.storeMemory({
        content: 'Derives memory',
        user_id: 'user-123',
        org_id: 'org-456',
        relationship: { type: 'Derives', target_id: memory1.id }
      });

      assert.ok(memory2);
      assert.ok(memory3);
      assert.ok(memory4);
    });
  });

  describe('getMemory', () => {
    it('should retrieve memory by ID', () => {
      const stored = engine.storeMemory({
        content: 'Retrievable memory',
        user_id: 'user-123',
        org_id: 'org-456'
      });

      const retrieved = engine.getMemory(stored.id);
      
      assert.ok(retrieved);
      assert.ok(retrieved.memory);
      assert.strictEqual(retrieved.memory.content, 'Retrievable memory');
      assert.ok(retrieved.relationships);
      assert(Array.isArray(retrieved.relationships));
    });

    it('should return null for non-existent memory', () => {
      const retrieved = engine.getMemory('non-existent-id');
      assert.strictEqual(retrieved, null);
    });
  });

  describe('searchMemories', () => {
    beforeEach(() => {
      // Seed test data
      engine.storeMemory({
        content: 'Revenue grew by 15% in Q4 2024',
        user_id: 'user-123',
        org_id: 'org-456',
        project: 'Finance',
        tags: ['finance', 'quarterly']
      });

      engine.storeMemory({
        content: 'User acquisition increased by 30%',
        user_id: 'user-123',
        org_id: 'org-456',
        project: 'Marketing',
        tags: ['marketing', 'growth']
      });

      engine.storeMemory({
        content: 'New feature launched successfully',
        user_id: 'user-123',
        org_id: 'org-456',
        project: 'Product',
        tags: ['product', 'launch']
      });
    });

    it('should search by query text', () => {
      const results = engine.searchMemories({
        query: 'revenue',
        user_id: 'user-123',
        org_id: 'org-456'
      });

      assert.ok(results.length > 0);
      assert.ok(results[0].content.includes('Revenue'));
    });

    it('should filter by user_id', () => {
      const results = engine.searchMemories({
        query: '',
        user_id: 'user-123',
        org_id: 'org-456'
      });

      assert.strictEqual(results.length, 3);
    });

    it('should filter by org_id', () => {
      const results = engine.searchMemories({
        query: '',
        user_id: 'user-123',
        org_id: 'wrong-org'
      });

      assert.strictEqual(results.length, 0);
    });

    it('should filter by project', () => {
      const results = engine.searchMemories({
        query: '',
        user_id: 'user-123',
        org_id: 'org-456',
        filter: { project: 'Finance' }
      });

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].project, 'Finance');
    });

    it('should filter by is_latest', () => {
      const memory1 = engine.storeMemory({
        content: 'Original',
        user_id: 'user-123',
        org_id: 'org-456'
      });

      engine.storeMemory({
        content: 'Updated',
        user_id: 'user-123',
        org_id: 'org-456',
        relationship: { type: 'Updates', target_id: memory1.id }
      });

      const latestResults = engine.searchMemories({
        query: '',
        user_id: 'user-123',
        org_id: 'org-456',
        filter: { is_latest: true }
      });

      const allResults = engine.searchMemories({
        query: '',
        user_id: 'user-123',
        org_id: 'org-456',
        filter: { is_latest: false }
      });

      assert.ok(latestResults.length > 0);
      assert.ok(allResults.length > 0);
    });

    it('should limit results with n_results', () => {
      const results = engine.searchMemories({
        query: '',
        user_id: 'user-123',
        org_id: 'org-456',
        n_results: 2
      });

      assert.strictEqual(results.length, 2);
    });
  });

  describe('createRelationship', () => {
    it('should create Updates relationship', () => {
      const memory1 = engine.storeMemory({
        content: 'Original',
        user_id: 'user-123',
        org_id: 'org-456'
      });

      const memory2 = engine.storeMemory({
        content: 'Updated',
        user_id: 'user-123',
        org_id: 'org-456'
      });

      const relationship = engine.createRelationship({
        from_id: memory2.id,
        to_id: memory1.id,
        type: 'Updates',
        confidence: 0.95
      });

      assert.ok(relationship.id);
      assert.strictEqual(relationship.type, 'Updates');
      assert.strictEqual(relationship.confidence, 0.95);
    });

    it('should create Extends relationship', () => {
      const memory1 = engine.storeMemory({
        content: 'Base',
        user_id: 'user-123',
        org_id: 'org-456'
      });

      const memory2 = engine.storeMemory({
        content: 'Extended',
        user_id: 'user-123',
        org_id: 'org-456'
      });

      const relationship = engine.createRelationship({
        from_id: memory2.id,
        to_id: memory1.id,
        type: 'Extends'
      });

      assert.strictEqual(relationship.type, 'Extends');
    });

    it('should create Derives relationship', () => {
      const memory1 = engine.storeMemory({
        content: 'Source',
        user_id: 'user-123',
        org_id: 'org-456'
      });

      const memory2 = engine.storeMemory({
        content: 'Derived',
        user_id: 'user-123',
        org_id: 'org-456'
      });

      const relationship = engine.createRelationship({
        from_id: memory2.id,
        to_id: memory1.id,
        type: 'Derives'
      });

      assert.strictEqual(relationship.type, 'Derives');
    });

    it('should reject invalid relationship type', () => {
      const memory1 = engine.storeMemory({
        content: 'Base',
        user_id: 'user-123',
        org_id: 'org-456'
      });

      const memory2 = engine.storeMemory({
        content: 'Related',
        user_id: 'user-123',
        org_id: 'org-456'
      });

      assert.throws(() => {
        engine.createRelationship({
          from_id: memory2.id,
          to_id: memory1.id,
          type: 'InvalidType'
        });
      }, /CHECK constraint failed/);
    });
  });

  describe('traverse', () => {
    it('should traverse graph from starting memory', () => {
      const memory1 = engine.storeMemory({
        content: 'Root memory',
        user_id: 'user-123',
        org_id: 'org-456'
      });

      const memory2 = engine.storeMemory({
        content: 'Child memory',
        user_id: 'user-123',
        org_id: 'org-456',
        relationship: { type: 'Extends', target_id: memory1.id }
      });

      const memory3 = engine.storeMemory({
        content: 'Grandchild memory',
        user_id: 'user-123',
        org_id: 'org-456',
        relationship: { type: 'Extends', target_id: memory2.id }
      });

      const result = engine.traverse({
        start_id: memory1.id,
        depth: 2
      });

      assert.ok(result.nodes);
      assert.ok(result.edges);
      assert.ok(result.paths);
      assert.strictEqual(result.nodes.length, 3);
      assert.strictEqual(result.edges.length, 2);
    });

    it('should respect depth limit', () => {
      const memory1 = engine.storeMemory({
        content: 'Root',
        user_id: 'user-123',
        org_id: 'org-456'
      });

      const memory2 = engine.storeMemory({
        content: 'Level 1',
        user_id: 'user-123',
        org_id: 'org-456',
        relationship: { type: 'Extends', target_id: memory1.id }
      });

      const memory3 = engine.storeMemory({
        content: 'Level 2',
        user_id: 'user-123',
        org_id: 'org-456',
        relationship: { type: 'Extends', target_id: memory2.id }
      });

      const result = engine.traverse({
        start_id: memory1.id,
        depth: 1
      });

      // Should only include nodes within depth 1
      assert.ok(result.nodes.length >= 2);
    });

    it('should filter by relationship types', () => {
      const memory1 = engine.storeMemory({
        content: 'Root',
        user_id: 'user-123',
        org_id: 'org-456'
      });

      const memory2 = engine.storeMemory({
        content: 'Extended',
        user_id: 'user-123',
        org_id: 'org-456',
        relationship: { type: 'Extends', target_id: memory1.id }
      });

      const memory3 = engine.storeMemory({
        content: 'Updated',
        user_id: 'user-123',
        org_id: 'org-456',
        relationship: { type: 'Updates', target_id: memory1.id }
      });

      const extendsOnly = engine.traverse({
        start_id: memory1.id,
        depth: 2,
        relationship_types: ['Extends']
      });

      assert.strictEqual(extendsOnly.edges.length, 1);
    });
  });

  describe('calculateDecay', () => {
    it('should calculate decay for a memory', () => {
      const memory = engine.storeMemory({
        content: 'Decay test memory',
        user_id: 'user-123',
        org_id: 'org-456'
      });

      const decay = engine.calculateDecay(memory.id);

      assert.ok(decay);
      assert.strictEqual(decay.memory_id, memory.id);
      assert.ok(decay.recall_probability >= 0);
      assert.ok(decay.recall_probability <= 1);
      assert.ok(['active', 'decaying', 'forgotten'].includes(decay.status));
      assert.ok(decay.half_life_days > 0);
    });

    it('should return null for non-existent memory', () => {
      const decay = engine.calculateDecay('non-existent-id');
      assert.strictEqual(decay, null);
    });

    it('should show active status for new memories', () => {
      const memory = engine.storeMemory({
        content: 'New memory',
        user_id: 'user-123',
        org_id: 'org-456'
      });

      const decay = engine.calculateDecay(memory.id);
      assert.strictEqual(decay.status, 'active');
      assert.ok(decay.recall_probability > 0.3);
    });
  });

  describe('reinforceMemory', () => {
    it('should increase strength and recall count', () => {
      const memory = engine.storeMemory({
        content: 'Reinforce test',
        user_id: 'user-123',
        org_id: 'org-456'
      });

      const initialStrength = memory.strength;
      const initialRecallCount = memory.recall_count;

      const reinforced = engine.reinforceMemory(memory.id);

      assert.ok(reinforced.memory);
      assert.ok(reinforced.memory.strength > initialStrength);
      assert.strictEqual(reinforced.memory.recall_count, initialRecallCount + 1);
    });

    it('should return null for non-existent memory', () => {
      const reinforced = engine.reinforceMemory('non-existent-id');
      assert.strictEqual(reinforced, null);
    });
  });

  describe('autoRecall', () => {
    beforeEach(() => {
      engine.storeMemory({
        content: 'User authentication uses JWT tokens',
        user_id: 'user-123',
        org_id: 'org-456',
        tags: ['auth', 'security']
      });

      engine.storeMemory({
        content: 'Database connection pooling is configured',
        user_id: 'user-123',
        org_id: 'org-456',
        tags: ['database', 'config']
      });

      engine.storeMemory({
        content: 'API rate limiting is set to 100 requests per minute',
        user_id: 'user-123',
        org_id: 'org-456',
        tags: ['api', 'rate-limit']
      });
    });

    it('should return relevant memories for context', () => {
      const result = engine.autoRecall({
        query_context: 'authentication JWT security',
        user_id: 'user-123',
        max_memories: 5
      });

      assert.ok(result.memories);
      assert.ok(result.injectionText);
      assert.ok(result.memories.length > 0);
      assert.ok(result.injectionText.includes('<relevant-memories>'));
    });

    it('should respect max_memories limit', () => {
      const result = engine.autoRecall({
        query_context: 'database',
        user_id: 'user-123',
        max_memories: 1
      });

      assert.strictEqual(result.memories.length, 1);
    });

    it('should include weighted scoring', () => {
      const result = engine.autoRecall({
        query_context: 'API rate',
        user_id: 'user-123',
        max_memories: 5,
        weights: { similarity: 0.7, recency: 0.2, importance: 0.1 }
      });

      assert.ok(result.memories);
      assert.ok(result.memories.length > 0);
    });
  });

  describe('sessionEndHook', () => {
    it('should capture decisions from session content', () => {
      const sessionContent = `
        We discussed the architecture.
        We decided to use PostgreSQL for the database.
        The team agreed to implement caching with Redis.
        This is important to remember for future reference.
      `;

      const result = engine.sessionEndHook({
        session_content: sessionContent,
        user_id: 'user-123',
        org_id: 'org-456'
      });

      assert.ok(result.captured);
      assert.ok(result.count >= 0);
      
      // Verify decisions were captured
      const memories = engine.getAllMemories('user-123', 'org-456');
      const decisionMemories = memories.filter(m => 
        m.tags.includes('decision') || m.content.includes('Decision:')
      );
      assert.ok(decisionMemories.length > 0);
    });

    it('should capture lessons from session content', () => {
      const sessionContent = `
        The lesson learned is that we need better error handling.
        Important takeaway: always validate user input.
      `;

      const result = engine.sessionEndHook({
        session_content: sessionContent,
        user_id: 'user-123',
        org_id: 'org-456'
      });

      assert.ok(result.captured);
      
      const memories = engine.getAllMemories('user-123', 'org-456');
      const lessonMemories = memories.filter(m => 
        m.tags.includes('lesson') || m.content.includes('Lesson:')
      );
      assert.ok(lessonMemories.length > 0);
    });

    it('should handle empty session content', () => {
      const result = engine.sessionEndHook({
        session_content: '',
        user_id: 'user-123',
        org_id: 'org-456'
      });

      assert.strictEqual(result.count, 0);
      assert.deepStrictEqual(result.captured, []);
    });
  });

  describe('getAllMemories', () => {
    beforeEach(() => {
      engine.storeMemory({
        content: 'Memory 1',
        user_id: 'user-123',
        org_id: 'org-456'
      });
      engine.storeMemory({
        content: 'Memory 2',
        user_id: 'user-123',
        org_id: 'org-456'
      });
      engine.storeMemory({
        content: 'Memory 3',
        user_id: 'user-123',
        org_id: 'org-456'
      });
    });

    it('should return all memories for user and org', () => {
      const memories = engine.getAllMemories('user-123', 'org-456');
      assert.strictEqual(memories.length, 3);
    });

    it('should return empty array for wrong org', () => {
      const memories = engine.getAllMemories('user-123', 'wrong-org');
      assert.strictEqual(memories.length, 0);
    });

    it('should order by created_at DESC', () => {
      const memories = engine.getAllMemories('user-123', 'org-456');
      
      for (let i = 1; i < memories.length; i++) {
        const prev = new Date(memories[i - 1].created_at);
        const curr = new Date(memories[i].created_at);
        assert.ok(prev >= curr);
      }
    });
  });

  describe('getStats', () => {
    beforeEach(() => {
      const memory1 = engine.storeMemory({
        content: 'Memory 1',
        user_id: 'user-123',
        org_id: 'org-456'
      });
      
      engine.storeMemory({
        content: 'Memory 2',
        user_id: 'user-123',
        org_id: 'org-456',
        relationship: { type: 'Updates', target_id: memory1.id }
      });
    });

    it('should return correct statistics', () => {
      const stats = engine.getStats('user-123', 'org-456');

      assert.ok(stats.total_memories >= 2);
      assert.ok(stats.active_memories >= 1);
      assert.ok(stats.relationships >= 1);
    });

    it('should return zero stats for non-existent user', () => {
      const stats = engine.getStats('non-existent', 'org-456');
      assert.strictEqual(stats.total_memories, 0);
      assert.strictEqual(stats.active_memories, 0);
      assert.strictEqual(stats.relationships, 0);
    });
  });

  describe('rowToMemory helper', () => {
    it('should convert database row to memory object', () => {
      const stored = engine.storeMemory({
        content: 'Test conversion',
        user_id: 'user-123',
        org_id: 'org-456',
        tags: ['test'],
        metadata: { key: 'value' }
      });

      const row = engine.db.prepare('SELECT * FROM memories WHERE id = ?').get(stored.id);
      const memory = engine.rowToMemory(row);

      assert.strictEqual(memory.content, 'Test conversion');
      assert.deepStrictEqual(memory.tags, ['test']);
      assert.deepStrictEqual(memory.metadata, { key: 'value' });
      assert.strictEqual(memory.is_latest, true);
    });
  });

  describe('rowToRelationship helper', () => {
    it('should convert database row to relationship object', () => {
      const memory1 = engine.storeMemory({
        content: 'Base',
        user_id: 'user-123',
        org_id: 'org-456'
      });

      const memory2 = engine.storeMemory({
        content: 'Related',
        user_id: 'user-123',
        org_id: 'org-456'
      });

      engine.createRelationship({
        from_id: memory2.id,
        to_id: memory1.id,
        type: 'Extends',
        confidence: 0.9,
        metadata: { note: 'test' }
      });

      const row = engine.db.prepare('SELECT * FROM relationships WHERE from_id = ?').get(memory2.id);
      const relationship = engine.rowToRelationship(row);

      assert.strictEqual(relationship.type, 'Extends');
      assert.strictEqual(relationship.confidence, 0.9);
      assert.deepStrictEqual(relationship.metadata, { note: 'test' });
    });
  });
});

describe('MemoryEngine - Edge Cases', () => {
  let engine;

  beforeEach(() => {
    engine = new MemoryEngine();
  });

  afterEach(() => {
    if (engine) {
      engine.close();
    }
  });

  it('should handle special characters in content', () => {
    const memory = engine.storeMemory({
      content: 'Special chars: <>&"\' and emojis 🧠🚀',
      user_id: 'user-123',
      org_id: 'org-456'
    });

    assert.ok(memory);
    assert.strictEqual(memory.content, 'Special chars: <>&"\' and emojis 🧠🚀');
  });

  it('should handle very long content', () => {
    const longContent = 'A'.repeat(10000);
    const memory = engine.storeMemory({
      content: longContent,
      user_id: 'user-123',
      org_id: 'org-456'
    });

    assert.ok(memory);
    assert.strictEqual(memory.content.length, 10000);
  });

  it('should handle empty tags array', () => {
    const memory = engine.storeMemory({
      content: 'No tags',
      user_id: 'user-123',
      org_id: 'org-456',
      tags: []
    });

    assert.deepStrictEqual(memory.tags, []);
  });

  it('should handle null/undefined optional fields', () => {
    const memory = engine.storeMemory({
      content: 'Minimal memory',
      user_id: 'user-123',
      org_id: 'org-456',
      project: null,
      source: undefined
    });

    assert.ok(memory);
  });
});
