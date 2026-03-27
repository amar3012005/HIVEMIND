import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractFacts, buildAugmentedKey } from '../../src/memory/fact-extractor.js';

describe('extractFacts - keyphrases', () => {
  it('extracts keyphrases from technical content (PostgreSQL, MySQL should appear)', async () => {
    const content = 'We migrated our database from MySQL to PostgreSQL. ' +
      'PostgreSQL offers better support for JSON and advanced indexing. ' +
      'The MySQL migration took three days and required schema changes.';
    const facts = await extractFacts(content);
    assert.ok(Array.isArray(facts.keyphrases), 'keyphrases should be an array');
    const lower = facts.keyphrases.map(k => k.toLowerCase());
    const hasPostgres = lower.some(k => k.includes('postgresql') || k.includes('postgres'));
    const hasMysql = lower.some(k => k.includes('mysql'));
    assert.ok(hasPostgres, `Expected postgresql in keyphrases, got: ${facts.keyphrases.join(', ')}`);
    assert.ok(hasMysql, `Expected mysql in keyphrases, got: ${facts.keyphrases.join(', ')}`);
  });

  it('extracts multi-word topic phrases for compact benchmark-style facts', async () => {
    const content = 'The database migration improved advanced indexing and reduced schema changes. ' +
      'That database migration also simplified rollback planning.';
    const facts = await extractFacts(content);
    const lower = facts.keyphrases.map(k => k.toLowerCase());
    assert.ok(lower.some(k => k.includes('database migration')), `Expected "database migration" in keyphrases, got: ${facts.keyphrases.join(', ')}`);
    assert.ok(lower.some(k => k.includes('advanced indexing')), `Expected "advanced indexing" in keyphrases, got: ${facts.keyphrases.join(', ')}`);
  });

  it('returns at most 10 keyphrases', async () => {
    const content = Array.from({ length: 50 }, (_, i) => `word${i} token${i} item${i}`).join(' ');
    const facts = await extractFacts(content);
    assert.ok(facts.keyphrases.length <= 10, `Expected <=10 keyphrases, got ${facts.keyphrases.length}`);
  });
});

describe('extractFacts - temporal references', () => {
  it('extracts temporal refs: "last Tuesday" and "March 20th"', async () => {
    const content = 'Last Tuesday we had a sprint review. The deadline is March 20th for the release.';
    const facts = await extractFacts(content);
    assert.ok(Array.isArray(facts.temporalRefs), 'temporalRefs should be an array');
    const joined = facts.temporalRefs.join(' ').toLowerCase();
    assert.ok(joined.includes('last tuesday') || joined.includes('tuesday'), `Expected "last Tuesday" in temporal refs, got: ${facts.temporalRefs.join(', ')}`);
    assert.ok(joined.includes('march') || joined.includes('20'), `Expected "March 20th" in temporal refs, got: ${facts.temporalRefs.join(', ')}`);
  });

  it('extracts ISO date format "2026-03-15"', async () => {
    const content = 'The deployment is scheduled for 2026-03-15 at midnight.';
    const facts = await extractFacts(content);
    assert.ok(facts.temporalRefs.some(t => t.includes('2026-03-15')), `Expected ISO date in temporal refs, got: ${facts.temporalRefs.join(', ')}`);
  });

  it('extracts quarter references like "Q1 2026"', async () => {
    const content = 'Revenue targets for Q1 2026 were exceeded by 15 percent.';
    const facts = await extractFacts(content);
    assert.ok(facts.temporalRefs.some(t => t.toUpperCase().includes('Q1')), `Expected Q1 in temporal refs, got: ${facts.temporalRefs.join(', ')}`);
  });
});

describe('extractFacts - entities', () => {
  it('extracts named entities: "Sarah proposed... Jake approved..."', async () => {
    const content = 'Sarah proposed the new architecture design last week. ' +
      'Jake approved the proposal and sent it to the Engineering Team for review.';
    const facts = await extractFacts(content);
    assert.ok(Array.isArray(facts.entities), 'entities should be an array');
    assert.ok(facts.entities.some(e => e.includes('Sarah')), `Expected "Sarah" in entities, got: ${facts.entities.join(', ')}`);
    assert.ok(facts.entities.some(e => e.includes('Jake')), `Expected "Jake" in entities, got: ${facts.entities.join(', ')}`);
  });

  it('extracts acronyms like "API", "NASA", "HTTP"', async () => {
    const content = 'The REST API uses HTTP protocol. NASA released new data via their API endpoint.';
    const facts = await extractFacts(content);
    const joined = facts.entities.join(' ');
    assert.ok(joined.includes('API') || joined.includes('HTTP') || joined.includes('NASA'), `Expected acronym in entities, got: ${facts.entities.join(', ')}`);
  });

  it('extracts mixed-case technical entities like OpenAI and PostgreSQL', async () => {
    const content = 'OpenAI reviewed the PostgreSQL integration and the GitHub rollout plan.';
    const facts = await extractFacts(content);
    const joined = facts.entities.join(' ');
    assert.ok(joined.includes('OpenAI'), `Expected OpenAI in entities, got: ${facts.entities.join(', ')}`);
    assert.ok(joined.includes('PostgreSQL'), `Expected PostgreSQL in entities, got: ${facts.entities.join(', ')}`);
  });
});

describe('extractFacts - edge cases', () => {
  it('returns empty arrays for very short content (<10 chars)', async () => {
    const facts = await extractFacts('Hi');
    assert.deepEqual(facts.keyphrases, []);
    assert.deepEqual(facts.entities, []);
    assert.deepEqual(facts.temporalRefs, []);
  });

  it('returns expected shape for normal content', async () => {
    const facts = await extractFacts('Some normal content about things.');
    assert.ok('keyphrases' in facts, 'missing keyphrases');
    assert.ok('entities' in facts, 'missing entities');
    assert.ok('temporalRefs' in facts, 'missing temporalRefs');
    assert.ok('summary' in facts, 'missing summary');
  });
});

describe('buildAugmentedKey', () => {
  it('produces a string longer than the raw content', async () => {
    const content = 'PostgreSQL migration from MySQL completed last Tuesday by the Database Team.';
    const facts = await extractFacts(content);
    const augmented = buildAugmentedKey(content, facts);
    assert.ok(typeof augmented === 'string', 'should return a string');
    assert.ok(augmented.length > content.length, `Augmented key (${augmented.length}) should be longer than raw content (${content.length})`);
  });

  it('starts with the raw content', async () => {
    const content = 'Sarah and Jake reviewed the PostgreSQL schema on 2026-03-15.';
    const facts = await extractFacts(content);
    const augmented = buildAugmentedKey(content, facts);
    assert.ok(augmented.startsWith(content), 'Augmented key should start with the raw content');
  });

  it('contains key topics section when keyphrases are present', async () => {
    const content = 'PostgreSQL and MySQL are popular relational database systems used widely in production.';
    const facts = await extractFacts(content);
    const augmented = buildAugmentedKey(content, facts);
    if (facts.keyphrases.length > 0) {
      assert.ok(augmented.includes('Key topics:'), 'Should include Key topics section');
    }
  });

  it('contains entities section when entities are present', async () => {
    const content = 'Sarah and Jake from Engineering Team approved the REST API design.';
    const facts = await extractFacts(content);
    const augmented = buildAugmentedKey(content, facts);
    if (facts.entities.length > 0) {
      assert.ok(augmented.includes('Entities:'), 'Should include Entities section');
    }
  });

  it('contains dates section when temporal refs are present', async () => {
    const content = 'The project deadline is 2026-03-15 and started last Tuesday.';
    const facts = await extractFacts(content);
    const augmented = buildAugmentedKey(content, facts);
    if (facts.temporalRefs.length > 0) {
      assert.ok(augmented.includes('Dates:'), 'Should include Dates section');
    }
  });

  it('carries multi-word topic phrases into the augmented key', async () => {
    const content = 'The database migration improved advanced indexing and reduced schema changes.';
    const facts = await extractFacts(content);
    const augmented = buildAugmentedKey(content, facts).toLowerCase();
    assert.ok(augmented.includes('database migration') || augmented.includes('advanced indexing'), `Expected richer phrase content in augmented key, got: ${augmented}`);
  });
});
