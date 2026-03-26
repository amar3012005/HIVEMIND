import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictResolver } from '../../src/memory/conflict-resolver.js';

describe('ConflictResolver', () => {
  describe('constructor', () => {
    it('accepts groqApiKey option', () => {
      const resolver = new ConflictResolver({ groqApiKey: 'test-key-123' });
      assert.equal(resolver.groqApiKey, 'test-key-123');
    });

    it('falls back to GROQ_API_KEY env var when no option provided', () => {
      const original = process.env.GROQ_API_KEY;
      process.env.GROQ_API_KEY = 'env-key-456';
      const resolver = new ConflictResolver();
      assert.equal(resolver.groqApiKey, 'env-key-456');
      if (original === undefined) {
        delete process.env.GROQ_API_KEY;
      } else {
        process.env.GROQ_API_KEY = original;
      }
    });
  });

  describe('_heuristicResolve', () => {
    it('detects UPDATE when content contains "changed"', () => {
      const resolver = new ConflictResolver();
      const result = resolver._heuristicResolve(
        { content: 'User changed their preferred language to TypeScript' },
        { id: 'mem-001', content: 'User prefers JavaScript' }
      );
      assert.equal(result.action, 'UPDATE');
      assert.equal(result.reason, 'change_words_detected');
      assert.equal(result.targetId, 'mem-001');
    });

    it('detects UPDATE when content contains "now"', () => {
      const resolver = new ConflictResolver();
      const result = resolver._heuristicResolve(
        { content: 'User now works at Acme Corp' },
        { id: 'mem-002', content: 'User works at OldCo' }
      );
      assert.equal(result.action, 'UPDATE');
      assert.equal(result.reason, 'change_words_detected');
      assert.equal(result.targetId, 'mem-002');
    });

    it('detects UPDATE when content contains "switched"', () => {
      const resolver = new ConflictResolver();
      const result = resolver._heuristicResolve(
        { content: 'User switched from dark mode to light mode' },
        { id: 'mem-003', content: 'User prefers dark mode' }
      );
      assert.equal(result.action, 'UPDATE');
      assert.equal(result.reason, 'change_words_detected');
      assert.equal(result.targetId, 'mem-003');
    });

    it('returns ADD for unrelated content with no change words', () => {
      const resolver = new ConflictResolver();
      const result = resolver._heuristicResolve(
        { content: 'User enjoys hiking on weekends' },
        { id: 'mem-004', content: 'User likes cooking Italian food' }
      );
      assert.equal(result.action, 'ADD');
      assert.equal(result.reason, 'heuristic_default');
      assert.equal(result.targetId, null);
    });

    it('returns ADD for empty content', () => {
      const resolver = new ConflictResolver();
      const result = resolver._heuristicResolve(
        { content: '' },
        { id: 'mem-005', content: 'Some existing memory' }
      );
      assert.equal(result.action, 'ADD');
      assert.equal(result.reason, 'heuristic_default');
      assert.equal(result.targetId, null);
    });
  });

  describe('resolve()', () => {
    it('returns correct shape with action, reason, targetId', async () => {
      // No API key — will use heuristic path
      const originalKey = process.env.GROQ_API_KEY;
      delete process.env.GROQ_API_KEY;

      const resolver = new ConflictResolver();
      const result = await resolver.resolve(
        { content: 'User changed their editor to Neovim' },
        { id: 'mem-100', content: 'User uses VSCode' }
      );

      assert.ok(Object.prototype.hasOwnProperty.call(result, 'action'), 'result must have action');
      assert.ok(Object.prototype.hasOwnProperty.call(result, 'reason'), 'result must have reason');
      assert.ok(Object.prototype.hasOwnProperty.call(result, 'targetId'), 'result must have targetId');
      assert.ok(['ADD', 'UPDATE', 'NOOP', 'EXTEND'].includes(result.action), `action must be one of ADD/UPDATE/NOOP/EXTEND, got: ${result.action}`);
      assert.equal(typeof result.reason, 'string');

      if (originalKey !== undefined) {
        process.env.GROQ_API_KEY = originalKey;
      }
    });

    it('falls back to heuristic when no API key is set', async () => {
      const originalKey = process.env.GROQ_API_KEY;
      delete process.env.GROQ_API_KEY;

      const resolver = new ConflictResolver();
      const result = await resolver.resolve(
        { content: 'User updated their timezone to PST' },
        { id: 'mem-200', content: 'User timezone is EST' }
      );

      // "updated" is a change word — heuristic should return UPDATE
      assert.equal(result.action, 'UPDATE');
      assert.equal(result.targetId, 'mem-200');

      if (originalKey !== undefined) {
        process.env.GROQ_API_KEY = originalKey;
      }
    });
  });
});
