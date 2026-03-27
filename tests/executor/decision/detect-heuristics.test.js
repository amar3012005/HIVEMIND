// tests/executor/decision/detect-heuristics.test.js
import { describe, it, expect } from 'vitest';
import { generateDecisionKey } from '../../../core/src/executor/decision/decision-key.js';
import { detectDecisionCandidate } from '../../../core/src/executor/decision/detect-heuristics.js';

describe('generateDecisionKey', () => {
  it('should normalize and hash consistently', () => {
    const key1 = generateDecisionKey('acme', 'choice', 'Use Redis for caching');
    const key2 = generateDecisionKey('acme', 'choice', 'use redis for caching');
    expect(key1).toBe(key2);
  });

  it('should strip punctuation and collapse whitespace', () => {
    const key1 = generateDecisionKey('acme', 'approval', 'Approved: the new API!');
    const key2 = generateDecisionKey('acme', 'approval', 'approved the new api');
    expect(key1).toBe(key2);
  });

  it('should produce different keys for different decisions', () => {
    const key1 = generateDecisionKey('acme', 'choice', 'Use Redis');
    const key2 = generateDecisionKey('acme', 'choice', 'Use Postgres');
    expect(key1).not.toBe(key2);
  });
});

describe('detectDecisionCandidate', () => {
  it('should detect Gmail approval pattern', () => {
    const result = detectDecisionCandidate({
      content: 'Looks good, approved. Let\'s proceed with the Redis approach.',
      platform: 'gmail',
      metadata: {},
    });
    expect(result.is_candidate).toBe(true);
    expect(result.signals.length).toBeGreaterThan(0);
    expect(result.signals.some(s => s.includes('approved'))).toBe(true);
  });

  it('should detect Slack decision pattern', () => {
    const result = detectDecisionCandidate({
      content: 'We\'re going with option B for the deployment pipeline. Final answer.',
      platform: 'slack',
      metadata: {},
    });
    expect(result.is_candidate).toBe(true);
  });

  it('should detect GitHub PR merge as decision signal', () => {
    const result = detectDecisionCandidate({
      content: 'Merging this PR after review approval.',
      platform: 'github',
      metadata: { eventType: 'pull_request.merged' },
    });
    expect(result.is_candidate).toBe(true);
    expect(result.signals.some(s => s.includes('pr_merged'))).toBe(true);
  });

  it('should NOT flag a simple status update', () => {
    const result = detectDecisionCandidate({
      content: 'Just pushed the latest changes. Build is green.',
      platform: 'slack',
      metadata: {},
    });
    expect(result.is_candidate).toBe(false);
  });

  it('should NOT flag a question', () => {
    const result = detectDecisionCandidate({
      content: 'Should we use Redis or Postgres for caching?',
      platform: 'gmail',
      metadata: {},
    });
    expect(result.is_candidate).toBe(false);
  });

  it('should return confidence between 0 and 1', () => {
    const result = detectDecisionCandidate({
      content: 'We decided to go with the monorepo approach.',
      platform: 'slack',
      metadata: {},
    });
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('should flag needs_more_context for ambiguous content', () => {
    const result = detectDecisionCandidate({
      content: 'I think we should probably go with Redis maybe.',
      platform: 'slack',
      metadata: {},
    });
    // Ambiguous — hedging language
    if (result.is_candidate) {
      expect(result.needs_more_context).toBe(true);
    }
  });
});
