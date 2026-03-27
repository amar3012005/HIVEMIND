// tests/executor/decision/classify-decision.test.js
import { describe, it, expect } from 'vitest';
import { buildClassificationPrompt, parseClassificationResponse } from '../../../core/src/executor/decision/classify-decision.js';

describe('buildClassificationPrompt', () => {
  it('should produce a structured prompt', () => {
    const prompt = buildClassificationPrompt({
      content: 'Approved — let\'s go with Redis for the caching layer.',
      platform: 'gmail',
      context: { signals: ['phrase:approved'] },
    });
    expect(prompt).toContain('Redis');
    expect(prompt).toContain('JSON');
    expect(prompt).toContain('is_decision');
  });
});

describe('parseClassificationResponse', () => {
  it('should parse valid JSON classification', () => {
    const raw = JSON.stringify({
      is_decision: true,
      decision_type: 'approval',
      decision_statement: 'Use Redis for caching',
      rationale: 'Lower latency for hot keys',
      alternatives_rejected: ['Postgres'],
      participants: [{ name: 'Alice', role: 'approver', platform: 'gmail' }],
      confidence: 0.9,
      needs_more_context: false,
    });
    const result = parseClassificationResponse(raw);
    expect(result.is_decision).toBe(true);
    expect(result.decision_type).toBe('approval');
    expect(result.confidence).toBe(0.9);
  });

  it('should handle LLM wrapping JSON in markdown', () => {
    const raw = '```json\n{"is_decision": false, "confidence": 0.2}\n```';
    const result = parseClassificationResponse(raw);
    expect(result.is_decision).toBe(false);
  });

  it('should return safe default on parse failure', () => {
    const result = parseClassificationResponse('not json at all');
    expect(result.is_decision).toBe(false);
    expect(result.confidence).toBe(0);
  });
});
