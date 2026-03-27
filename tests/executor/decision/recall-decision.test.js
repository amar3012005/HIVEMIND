// tests/executor/decision/recall-decision.test.js
import { describe, it, expect } from 'vitest';
import { recallDecision } from '../../../core/src/executor/decision/recall-decision.js';

describe('recallDecision', () => {
  it('should return empty for no store', async () => {
    const result = await recallDecision({ query: 'test' }, null);
    expect(result.decisions).toHaveLength(0);
    expect(result.done).toBe(true);
  });

  it('should rank validated decisions higher', async () => {
    const mockStore = {
      searchMemories: async () => [
        { id: '1', content: 'Use Redis', score: 0.8, memory_type: 'decision', created_at: new Date().toISOString(), metadata: { status: 'candidate', evidence_strength: 0.3 } },
        { id: '2', content: 'Use Redis for caching', score: 0.8, memory_type: 'decision', created_at: new Date().toISOString(), metadata: { status: 'validated', evidence_strength: 0.9, evidence: { supporting: [{}, {}] } } },
      ],
    };
    const result = await recallDecision({ query: 'Redis caching' }, mockStore);
    expect(result.decisions[0].status).toBe('validated');
    expect(result.decisions[0].recall_score).toBeGreaterThan(result.decisions[1].recall_score);
  });

  it('should include completeness_score', async () => {
    const mockStore = {
      searchMemories: async () => [
        { id: '1', content: 'Decision', score: 0.9, memory_type: 'decision', created_at: new Date().toISOString(),
          metadata: { rationale: 'Good reason', evidence: { supporting: [{}] }, participants: [{}] } },
      ],
    };
    const result = await recallDecision({ query: 'test' }, mockStore);
    expect(result.decisions[0].completeness_score).toBe(1);
  });
});
