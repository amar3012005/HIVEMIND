import { describe, it, expect } from 'vitest';
import { buildEvidenceScoringPrompt, parseEvidenceScoringResponse } from '../../../core/src/executor/decision/score-evidence.js';

describe('Evidence Scoring', () => {
  it('should build scoring prompt with candidates', () => {
    const prompt = buildEvidenceScoringPrompt('Use Redis', [
      { id: '1', content: 'Redis is fast for caching', platform: 'slack' },
      { id: '2', content: 'Meeting at 3pm tomorrow', platform: 'gmail' },
    ]);
    expect(prompt).toContain('Use Redis');
    expect(prompt).toContain('Redis is fast');
    expect(prompt).toContain('[slack]');
  });

  it('should parse valid scoring response', () => {
    const scores = parseEvidenceScoringResponse(JSON.stringify({
      scores: [
        { index: 1, relevant: true, relationship: 'supporting', strength: 0.9, reason: 'directly supports' },
        { index: 2, relevant: false, relationship: 'unrelated', strength: 0.1, reason: 'meeting invite' },
      ]
    }));
    expect(scores).toHaveLength(2);
    expect(scores[0].relevant).toBe(true);
    expect(scores[1].relevant).toBe(false);
  });

  it('should handle parse failure', () => {
    const scores = parseEvidenceScoringResponse('not json');
    expect(scores).toEqual([]);
  });
});
