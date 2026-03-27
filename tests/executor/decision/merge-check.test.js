import { describe, it, expect } from 'vitest';
import { buildMergeCheckPrompt, parseMergeCheckResponse } from '../../../core/src/executor/decision/merge-check.js';

describe('Merge Check', () => {
  it('should build prompt with existing decisions', () => {
    const prompt = buildMergeCheckPrompt('Use Redis for caching', [
      { id: 'd1', decision_statement: 'Approved: Redis for cache layer' },
      { id: 'd2', decision_statement: 'Switch to Postgres' },
    ]);
    expect(prompt).toContain('Use Redis for caching');
    expect(prompt).toContain('Approved: Redis for cache layer');
    expect(prompt).toContain('d1');
  });

  it('should parse valid merge response', () => {
    const result = parseMergeCheckResponse(JSON.stringify({
      is_same_decision: true,
      matches_id: 'd1',
      relationship: 'same_decision',
      confidence: 0.92,
      reasoning: 'Both refer to using Redis for caching'
    }));
    expect(result.is_same_decision).toBe(true);
    expect(result.matches_id).toBe('d1');
    expect(result.confidence).toBe(0.92);
  });

  it('should handle parse failure gracefully', () => {
    const result = parseMergeCheckResponse('not json');
    expect(result.is_same_decision).toBe(false);
    expect(result.matches_id).toBeNull();
  });

  it('should handle markdown-wrapped JSON', () => {
    const result = parseMergeCheckResponse('```json\n{"is_same_decision":true,"matches_id":"d1","relationship":"implements","confidence":0.8,"reasoning":"test"}\n```');
    expect(result.is_same_decision).toBe(true);
    expect(result.matches_id).toBe('d1');
  });
});
