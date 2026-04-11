import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryProcessor } from '../../src/memory/memory-processor.js';

// --- Heuristic tests (no API key) ---

test('heuristic: detects UPDATE with change words + similar memories', () => {
  const processor = new MemoryProcessor({ groqApiKey: null });
  const newMemory = { content: 'I switched to TypeScript now' };
  const similarMemories = [{ id: 'mem-123', content: 'I use JavaScript' }];
  const result = processor._heuristicProcess(newMemory, similarMemories);
  assert.equal(result.relationship.action, 'UPDATE');
  assert.equal(result.relationship.targetId, 'mem-123');
  assert.equal(result.relationship.reason, 'change_words');
});

test('heuristic: returns ADD for no similar memories', () => {
  const processor = new MemoryProcessor({ groqApiKey: null });
  const newMemory = { content: 'I love hiking on weekends' };
  const result = processor._heuristicProcess(newMemory, []);
  assert.equal(result.relationship.action, 'ADD');
  assert.equal(result.relationship.targetId, null);
});

test('heuristic: assigns high priority for personal facts', () => {
  const processor = new MemoryProcessor({ groqApiKey: null });
  const newMemory = { content: 'My name is Alice and I work at Acme' };
  const result = processor._heuristicProcess(newMemory, []);
  assert.equal(result.priority, 'high');
});

test('heuristic: assigns low priority for greetings', () => {
  const processor = new MemoryProcessor({ groqApiKey: null });
  const newMemory = { content: 'Hello there, bye!' };
  const result = processor._heuristicProcess(newMemory, []);
  assert.equal(result.priority, 'low');
});

// --- _parseOutput tests ---

test('_parseOutput: parses well-formed 5-line output correctly', () => {
  const processor = new MemoryProcessor({ groqApiKey: null });
  const similarMemories = [{ id: 'abc-999', content: 'old job info' }];
  const output = [
    'UPDATE: abc-999 supersedes old job entry',
    'HIGH',
    '🔴 User works at Google as a software engineer.',
    'ENTITIES: Google, Alice',
    'DATES: 2025-01-15',
  ].join('\n');

  const result = processor._parseOutput(output, similarMemories);

  assert.equal(result.relationship.action, 'UPDATE');
  assert.equal(result.relationship.targetId, 'abc-999');
  assert.equal(result.priority, 'high');
  assert.ok(result.observation && result.observation.includes('Google'));
  assert.deepEqual(result.facts.entities, ['Google', 'Alice']);
  assert.deepEqual(result.facts.dates, ['2025-01-15']);
});

test('_parseOutput: handles missing lines gracefully', () => {
  const processor = new MemoryProcessor({ groqApiKey: null });
  const output = 'ADD: brand new topic';

  const result = processor._parseOutput(output, []);

  assert.equal(result.relationship.action, 'ADD');
  assert.equal(result.priority, 'medium');
  assert.equal(result.observation, null);
  assert.deepEqual(result.facts.entities, []);
  assert.deepEqual(result.facts.dates, []);
});

test('_parseOutput: parses DERIVE output with source ids', () => {
  const processor = new MemoryProcessor({ groqApiKey: null });
  const similarMemories = [{ id: 'src-a', content: 'source a' }, { id: 'src-b', content: 'source b' }];
  const output = [
    'DERIVE: src-a, src-b synthesis from multiple sources',
    'MEDIUM',
    '🟡 Synthesized claim.',
    'ENTITIES: NONE',
    'DATES: NONE',
    'FACT_SENTENCES:',
    '- Synthesized claim.',
  ].join('\n');

  const result = processor._parseOutput(output, similarMemories);

  assert.equal(result.relationship.action, 'DERIVE');
  assert.deepEqual(result.relationship.sourceIds, ['src-a', 'src-b']);
});
