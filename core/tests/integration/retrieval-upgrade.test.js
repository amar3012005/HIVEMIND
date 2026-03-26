import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitIntoRounds } from '../../src/memory/round-splitter.js';
import { extractFacts, buildAugmentedKey } from '../../src/memory/fact-extractor.js';
import { expandTemporalQuery } from '../../src/search/time-aware-expander.js';
import { formatChainOfNotePayload } from '../../src/memory/operator-layer.js';

describe('Retrieval Engine Upgrade — Integration', () => {
  it('full pipeline: round-split → fact-extract → time-expand → chain-of-note', async () => {
    // 1. Split conversation into rounds
    const conversation = [
      { role: 'user', content: 'We decided to use PostgreSQL for the new project on March 10th.' },
      { role: 'assistant', content: 'Good choice! PostgreSQL has excellent JSONB support.' },
      { role: 'user', content: 'Sarah will lead the migration starting next week.' },
      { role: 'assistant', content: 'Got it. I will remind you about the migration timeline.' },
    ];
    const rounds = splitIntoRounds(conversation);
    assert.equal(rounds.length, 2);

    // 2. Extract facts from each round
    for (const round of rounds) {
      const facts = await extractFacts(round.content, { useLLM: false });
      const augmented = buildAugmentedKey(round.content, facts);
      assert.ok(augmented.length >= round.content.length);
    }

    // 3. Time-aware query expansion
    const temporal = expandTemporalQuery('What did we decide last week about the database?');
    assert.ok(temporal.hasTemporalFilter);

    // 4. Chain-of-note formatting
    const mockMemories = rounds.map((r, i) => ({
      id: `round-${i}`, content: r.content, memory_type: 'event', created_at: new Date().toISOString(),
    }));
    const payload = formatChainOfNotePayload(mockMemories, 'What did we decide about the database?');
    assert.ok(payload.includes('<chain-of-note>'));
    assert.ok(payload.includes('PostgreSQL') || payload.includes('postgresql'));
  });
});
