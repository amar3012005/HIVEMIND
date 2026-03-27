import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PredictCalibrateFilter, extractSentences } from '../../src/memory/predict-calibrate.js';

describe('extractSentences', () => {
  it('splits long updates on semicolons and line breaks', () => {
    const sentences = extractSentences('Sarah approved the migration; Jake scheduled the rollout.\n- The launch moved to Wednesday.');

    assert.equal(sentences.length, 3);
    assert.ok(sentences.some((sentence) => sentence.includes('Sarah approved the migration')));
    assert.ok(sentences.some((sentence) => sentence.includes('Jake scheduled the rollout')));
    assert.ok(sentences.some((sentence) => sentence.includes('The launch moved to Wednesday')));
  });
});

describe('PredictCalibrateFilter', () => {
  it('extracts only the novel clause from a partially overlapping update', () => {
    const filter = new PredictCalibrateFilter({
      strongMatchThreshold: 0.9,
      partialMatchThreshold: 0.6,
      sentenceNoveltyThreshold: 0.35,
    });

    const existingMemories = [
      {
        id: 'mem-1',
        content: 'Sarah approved the PostgreSQL migration.',
      }
    ];

    const result = filter.filter(
      {
        content: 'Sarah approved the PostgreSQL migration; the launch moved to Wednesday.',
      },
      existingMemories
    );

    assert.equal(result.shouldStore, true);
    assert.equal(result.deltaExtracted, true);
    assert.ok(result.deltaContent.includes('launch moved to Wednesday'), `Expected novel clause in deltaContent, got: ${result.deltaContent}`);
    assert.ok(!result.deltaContent.includes('Sarah approved the PostgreSQL migration'), `Expected redundant clause to be removed, got: ${result.deltaContent}`);
  });
});
