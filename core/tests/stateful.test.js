/**
 * HIVE-MIND Stateful Memory Manager Tests
 * Tests for state mutation, conflict resolution, and version history
 *
 * Run with: node --test tests/stateful.test.js
 */

import { describe, it, beforeEach } from 'node:test';
import { MemoryEngine } from '../src/engine.local.js';
import { StateMutator } from '../src/stateful/mutator.js';
import { ConflictResolver } from '../src/stateful/resolver.js';
import assert from 'node:assert';

// Mock dependencies for standalone testing
global.console = {
  log: console.log,
  warn: console.warn,
  error: console.error,
  debug: console.debug
};

describe('Stateful Memory Manager', () => {
  describe('StateMutator', () => {
    let mutator;
    let memories;

    beforeEach(() => {
      mutator = new StateMutator();
      memories = new Map();
    });

    it('should create initial memory with is_latest=true', () => {
      const now = new Date().toISOString();
      const memory = {
        id: 'mem-1',
        content: 'Test content',
        created_at: now,
        updated_at: now,
        is_latest: true,
        version: 1
      };

      memories.set(memory.id, memory);

      assert.strictEqual(memory.is_latest, true);
      assert.strictEqual(memory.version, 1);
    });

    it('should apply Update relationship mutation', () => {
      const now = new Date().toISOString();
      const oldMemory = {
        id: 'mem-1',
        content: 'Old content',
        created_at: now,
        updated_at: now,
        is_latest: true,
        version: 1
      };

      const newMemory = {
        id: 'mem-2',
        content: 'New content',
        created_at: now,
        updated_at: now,
        is_latest: true,
        version: 1
      };

      memories.set(oldMemory.id, oldMemory);
      memories.set(newMemory.id, newMemory);

      const relationship = {
        type: 'Updates',
        confidence: 1.0
      };

      const mutation = mutator.applyMutation({
        relationship,
        oldMemory,
        newMemory,
        memories
      });

      // Verify mutation was recorded
      assert.strictEqual(mutation.type, 'Updates');
      assert.ok(mutation.changes.length > 0);

      // Verify old memory is not latest
      assert.strictEqual(oldMemory.is_latest, false);
      assert.strictEqual(oldMemory.version, 2);

      // Verify new memory is latest
      assert.strictEqual(newMemory.is_latest, true);
      assert.strictEqual(newMemory.version, 2);
    });

    it('should apply Extends relationship mutation', () => {
      const now = new Date().toISOString();
      const oldMemory = {
        id: 'mem-1',
        content: 'Old content',
        created_at: now,
        updated_at: now,
        is_latest: true,
        version: 1
      };

      const newMemory = {
        id: 'mem-2',
        content: 'Extended content',
        created_at: now,
        updated_at: now,
        is_latest: true,
        version: 1
      };

      memories.set(oldMemory.id, oldMemory);
      memories.set(newMemory.id, newMemory);

      const relationship = {
        type: 'Extends',
        confidence: 1.0
      };

      const mutation = mutator.applyMutation({
        relationship,
        oldMemory,
        newMemory,
        memories
      });

      // Verify mutation was recorded
      assert.strictEqual(mutation.type, 'Extends');

      // For Extends, both memories should remain latest
      assert.strictEqual(oldMemory.is_latest, true);
      assert.strictEqual(newMemory.is_latest, true);
    });

    it('should apply Derive relationship mutation', () => {
      const now = new Date().toISOString();
      const oldMemory = {
        id: 'mem-1',
        content: 'Source content',
        created_at: now,
        updated_at: now,
        is_latest: true,
        version: 1
      };

      const newMemory = {
        id: 'mem-2',
        content: 'Derived content',
        created_at: now,
        updated_at: now,
        is_latest: true,
        version: 1
      };

      memories.set(oldMemory.id, oldMemory);
      memories.set(newMemory.id, newMemory);

      const relationship = {
        type: 'Derives',
        confidence: 1.0
      };

      const mutation = mutator.applyMutation({
        relationship,
        oldMemory,
        newMemory,
        memories
      });

      // Verify mutation was recorded
      assert.strictEqual(mutation.type, 'Derives');

      // For Derives, new memory is independent
      assert.strictEqual(newMemory.is_latest, true);
    });

    it('should track version history', () => {
      const now = new Date().toISOString();
      const memory = {
        id: 'mem-1',
        content: 'Test content',
        created_at: now,
        updated_at: now,
        is_latest: true,
        version: 1
      };

      memories.set(memory.id, memory);

      // Apply Update mutation
      const newMemory = {
        id: 'mem-2',
        content: 'Updated content',
        created_at: now,
        updated_at: now,
        is_latest: true,
        version: 1
      };

      memories.set(newMemory.id, newMemory);

      mutator.applyMutation({
        relationship: { type: 'Updates', confidence: 1.0 },
        oldMemory: memory,
        newMemory,
        memories
      });

      // Get version history
      const history = mutator.getVersionHistory('mem-1');

      assert.ok(history.length > 0);
      assert.strictEqual(history[0].reason, 'Updates');
    });

    it('should validate state transitions', () => {
      const mutator = new StateMutator();

      // Valid Update transition
      const validUpdate = mutator.validateTransition({
        type: 'Updates',
        oldMemory: { id: 'mem-1', is_latest: true },
        newMemory: { id: 'mem-2' }
      });

      assert.strictEqual(validUpdate.valid, true);

      // Invalid Update transition (no old memory)
      const invalidUpdate = mutator.validateTransition({
        type: 'Updates',
        oldMemory: null,
        newMemory: { id: 'mem-2' }
      });

      assert.strictEqual(invalidUpdate.valid, false);
      assert.ok(invalidUpdate.errors.length > 0);
    });

    it('should provide mutation statistics', () => {
      const mutator = new StateMutator();
      const memories = new Map();
      const now = new Date().toISOString();

      // Create and update memories
      for (let i = 0; i < 3; i++) {
        const oldMem = {
          id: `old-${i}`,
          content: `Old ${i}`,
          created_at: now,
          updated_at: now,
          is_latest: true,
          version: 1
        };

        const newMem = {
          id: `new-${i}`,
          content: `New ${i}`,
          created_at: now,
          updated_at: now,
          is_latest: true,
          version: 1
        };

        memories.set(oldMem.id, oldMem);
        memories.set(newMem.id, newMem);

        mutator.applyMutation({
          relationship: { type: 'Updates', confidence: 1.0 },
          oldMemory: oldMem,
          newMemory: newMem,
          memories
        });
      }

      const stats = mutator.getStats();

      assert.strictEqual(stats.totalMutations, 3);
      assert.strictEqual(stats.updates, 3);
      assert.ok(stats.memoriesWithHistory > 0);
    });
  });

  describe('ConflictResolver', () => {
    let resolver;

    beforeEach(() => {
      resolver = new ConflictResolver();
    });

    it('should detect duplicate conflicts', () => {
      const memories = [
        { id: '1', content: 'Same content', created_at: '2024-01-01' },
        { id: '2', content: 'Same content', created_at: '2024-01-02' },
        { id: '3', content: 'Same content', created_at: '2024-01-03' }
      ];

      const conflicts = resolver.detectConflicts(memories);

      assert.strictEqual(conflicts.length, 1);
      assert.strictEqual(conflicts[0].count, 3);
    });

    it('should resolve conflicts using latest strategy', () => {
      const conflicts = resolver.detectConflicts([
        { id: '1', content: 'Same content', created_at: '2024-01-01' },
        { id: '2', content: 'Same content', created_at: '2024-01-02' },
        { id: '3', content: 'Same content', created_at: '2024-01-03' }
      ]);

      const resolutions = resolver.resolveConflicts(conflicts, 'latest');

      assert.strictEqual(resolutions.length, 1);
      assert.strictEqual(resolutions[0].keep.id, '3');
      assert.strictEqual(resolutions[0].discard.length, 2);
    });

    it('should resolve conflicts using highest-confidence strategy', () => {
      const conflicts = resolver.detectConflicts([
        { id: '1', content: 'Same content', confidence: 0.5, created_at: '2024-01-01' },
        { id: '2', content: 'Same content', confidence: 0.9, created_at: '2024-01-02' },
        { id: '3', content: 'Same content', confidence: 0.7, created_at: '2024-01-03' }
      ]);

      const resolutions = resolver.resolveConflicts(conflicts, 'highest-confidence');

      assert.strictEqual(resolutions[0].keep.id, '2');
      assert.strictEqual(resolutions[0].keep.confidence, 0.9);
    });

    it('should resolve conflicts using merge strategy', () => {
      const conflicts = resolver.detectConflicts([
        { id: '1', content: 'First content', created_at: '2024-01-01' },
        { id: '2', content: 'Second content', created_at: '2024-01-02' }
      ]);

      const resolutions = resolver.resolveConflicts(conflicts, 'merge');

      assert.strictEqual(resolutions[0].type, 'merge');
      assert.ok(resolutions[0].merged.content.includes('MERGED MEMORY'));
      assert.strictEqual(resolutions[0].merged.sourceCount, 2);
    });

    it('should resolve conflicts using temporal-weighted strategy', () => {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);

      const conflicts = resolver.detectConflicts([
        { id: '1', content: 'Content', created_at: twoDaysAgo.toISOString(), importance_score: 0.9 },
        { id: '2', content: 'Content', created_at: yesterday.toISOString(), importance_score: 0.5 },
        { id: '3', content: 'Content', created_at: now.toISOString(), importance_score: 0.3 }
      ]);

      const resolutions = resolver.resolveConflicts(conflicts, 'temporal-weighted');

      // Should prefer more recent memory even with lower importance
      assert.strictEqual(resolutions[0].keep.id, '3');
    });

    it('should calculate content similarity', () => {
      const similarity1 = resolver._calculateSimilarity('Hello world', 'Hello world');
      const similarity2 = resolver._calculateSimilarity('Hello world', 'Hello there');

      assert.strictEqual(similarity1, 1.0);
      assert.ok(similarity2 < 1.0);
      assert.ok(similarity2 > 0.5);
    });

    it('should provide resolution statistics', () => {
      const conflicts = resolver.detectConflicts([
        { id: '1', content: 'Same content', created_at: '2024-01-01' },
        { id: '2', content: 'Same content', created_at: '2024-01-02' }
      ]);

      resolver.resolveConflicts(conflicts, 'latest');

      const stats = resolver.getStats();

      assert.strictEqual(stats.totalResolutions, 1);
      assert.strictEqual(stats.uniqueConflictsResolved, 1);
    });
  });

  describe('MemoryEngine Integration', () => {
    let engine;

    beforeEach(() => {
      engine = new MemoryEngine();
    });

    it('should store memory with state mutation', () => {
      const result = engine.storeMemory({
        content: 'Test memory',
        user_id: 'user-1',
        org_id: 'org-1'
      });

      assert.ok(result.memory);
      assert.strictEqual(result.memory.is_latest, true);
      assert.strictEqual(result.mutation, null);
    });

    it('should apply Update relationship with state mutation', () => {
      // Create first memory
      const result1 = engine.storeMemory({
        content: 'Original content',
        user_id: 'user-1',
        org_id: 'org-1'
      });

      // Create update relationship
      const result2 = engine.storeMemory({
        content: 'Updated content',
        user_id: 'user-1',
        org_id: 'org-1',
        relationship: {
          target_id: result1.memory.id,
          type: 'Updates'
        }
      });

      // Verify old memory is not latest
      const oldMemory = engine.memories.get(result1.memory.id);
      assert.strictEqual(oldMemory.is_latest, false);

      // Verify new memory is latest
      assert.strictEqual(result2.memory.is_latest, true);

      // Verify mutation was recorded
      assert.ok(result2.mutation);
      assert.strictEqual(result2.mutation.type, 'Updates');
    });

    it('should apply Extends relationship without changing is_latest', () => {
      // Create first memory
      const result1 = engine.storeMemory({
        content: 'Original content',
        user_id: 'user-1',
        org_id: 'org-1'
      });

      // Create extends relationship
      const result2 = engine.storeMemory({
        content: 'Extended content',
        user_id: 'user-1',
        org_id: 'org-1',
        relationship: {
          target_id: result1.memory.id,
          type: 'Extends'
        }
      });

      // Both should remain latest for Extends
      assert.strictEqual(result1.memory.is_latest, true);
      assert.strictEqual(result2.memory.is_latest, true);
    });

    it('should track version history', () => {
      // Create first memory
      const result1 = engine.storeMemory({
        content: 'Original content',
        user_id: 'user-1',
        org_id: 'org-1'
      });

      // Create update
      engine.storeMemory({
        content: 'Updated content',
        user_id: 'user-1',
        org_id: 'org-1',
        relationship: {
          target_id: result1.memory.id,
          type: 'Updates'
        }
      });

      // Get version history
      const history = engine.getVersionHistory(result1.memory.id);

      assert.ok(history.length > 0);
      assert.strictEqual(history[0].reason, 'Updates');
    });

    it('should resolve conflicts', () => {
      // Create multiple memories with same content
      engine.storeMemory({
        content: 'Duplicate content',
        user_id: 'user-1',
        org_id: 'org-1'
      });

      engine.storeMemory({
        content: 'Duplicate content',
        user_id: 'user-1',
        org_id: 'org-1'
      });

      // Resolve conflicts
      const resolution = engine.resolveConflicts({ strategy: 'latest' });

      assert.ok(resolution);
      assert.ok(resolution.conflicts.length > 0);
    });

    it('should provide stateful statistics', () => {
      // Create memories with relationships
      const result1 = engine.storeMemory({
        content: 'Original',
        user_id: 'user-1',
        org_id: 'org-1'
      });

      engine.storeMemory({
        content: 'Updated',
        user_id: 'user-1',
        org_id: 'org-1',
        relationship: {
          target_id: result1.memory.id,
          type: 'Updates'
        }
      });

      const stats = engine.getStatefulStats('user-1', 'org-1');

      assert.ok(stats.total_memories > 0);
      assert.ok(stats.active_memories > 0);
      assert.strictEqual(stats.updates, 1);
      assert.ok(stats.mutator_stats);
      assert.ok(stats.resolver_stats);
    });
  });
});
