import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Observer } from '../../src/memory/observer.js';
import { Reflector } from '../../src/memory/reflector.js';
import { mergeObservationLogs, estimateTokens } from '../../src/memory/observation-store.js';

describe('Observer-Reflector Pipeline — Integration', () => {
  it('observe 10 turns → reflect → verify compression', async () => {
    const observer = new Observer();
    const observations = [];

    const turns = [
      'User: I graduated with a BA in Business Administration from Michigan in 2012.\nAssistant: Great foundation!',
      'User: My daily commute is 45 minutes each way.\nAssistant: That is reasonable.',
      'User: Can you tell me a joke?\nAssistant: Why did the chicken cross the road?',
      'User: I bought a new tennis racket at the sports store downtown for $150.\nAssistant: Nice purchase!',
      'User: My favorite restaurant is Olive Garden.\nAssistant: Italian food is great!',
      'User: I have three bikes: road, mountain, and hybrid.\nAssistant: Impressive collection.',
      'User: My dog Max is a Golden Retriever.\nAssistant: Wonderful breed!',
      'User: Thanks for the help!\nAssistant: You are welcome!',
      'User: My favorite restaurant is actually Cheesecake Factory now.\nAssistant: Good choice!',
      'User: I completed a Data Science certification last month.\nAssistant: Congratulations!',
    ];

    for (const turn of turns) {
      const result = await observer.observe({ content: turn, documentDate: '2023-05-20T10:00:00Z' });
      if (result.observation) observations.push(result.observation);
    }

    // All meaningful turns produce observations; at least 4 must be captured
    assert.ok(observations.length >= 4, `At least 4 observations, got ${observations.length}`);

    // Run reflector
    const reflector = new Reflector();
    const reflected = await reflector.reflect(observations);

    // Final log
    const log = mergeObservationLogs(reflected.observations);
    const originalTokens = estimateTokens(turns.join('\n'));
    const compressedTokens = estimateTokens(log);

    console.log(`  Turns: ${turns.length}, Observations: ${observations.length}, After reflect: ${reflected.observations.length}`);
    console.log(`  Compression: ${originalTokens} → ${compressedTokens} tokens (${(originalTokens / Math.max(compressedTokens, 1)).toFixed(1)}x)`);
    console.log(`  Superseded: ${reflected.superseded.length}, Merged: ${reflected.merged}, Pruned: ${reflected.pruned}`);

    assert.ok(compressedTokens < originalTokens, 'Compressed should be smaller');
  });
});
