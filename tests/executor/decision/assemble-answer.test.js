import { describe, it, expect } from 'vitest';
import { buildAnswerPrompt, assembleAnswer } from '../../../core/src/executor/decision/assemble-answer.js';

describe('Answer Assembly', () => {
  it('should build answer prompt with decision data', () => {
    const prompt = buildAnswerPrompt('Why Redis?', [{
      decision_statement: 'Use Redis for caching',
      rationale: 'Lower latency',
      participants: [{ name: 'Alice', role: 'proposer', platform: 'slack' }],
      evidence: { supporting: [{ platform: 'slack', snippet: 'Redis is better' }], conflicting: [] },
      status: 'validated',
      confidence: 0.9,
    }]);
    expect(prompt).toContain('Why Redis?');
    expect(prompt).toContain('Use Redis for caching');
    expect(prompt).toContain('Alice');
    expect(prompt).toContain('[slack]');
  });

  it('should return fallback when no groqClient', async () => {
    const result = await assembleAnswer('Why?', [{ decision_statement: 'Use Redis', rationale: 'Fast', status: 'validated' }], null);
    expect(result).toContain('Use Redis');
  });

  it('should return message when no decisions', async () => {
    const result = await assembleAnswer('Why?', [], null);
    expect(result).toContain('No relevant decisions');
  });
});
