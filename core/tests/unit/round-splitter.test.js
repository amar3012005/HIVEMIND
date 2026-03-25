import test from 'node:test';
import assert from 'node:assert/strict';
import { splitIntoRounds } from '../../src/memory/round-splitter.js';

test('splits 4-message conversation into 2 rounds', () => {
  const messages = [
    { role: 'user', content: 'What is the capital of France?' },
    { role: 'assistant', content: 'The capital of France is Paris.' },
    { role: 'user', content: 'What about Germany?' },
    { role: 'assistant', content: 'The capital of Germany is Berlin.' },
  ];

  const rounds = splitIntoRounds(messages);

  assert.equal(rounds.length, 2);

  assert.equal(rounds[0].roundIndex, 0);
  assert.equal(rounds[0].userContent, 'What is the capital of France?');
  assert.equal(rounds[0].assistantContent, 'The capital of France is Paris.');
  assert.equal(rounds[0].content, 'User: What is the capital of France?\nAssistant: The capital of France is Paris.');

  assert.equal(rounds[1].roundIndex, 1);
  assert.equal(rounds[1].userContent, 'What about Germany?');
  assert.equal(rounds[1].assistantContent, 'The capital of Germany is Berlin.');
  assert.equal(rounds[1].content, 'User: What about Germany?\nAssistant: The capital of Germany is Berlin.');
});

test('handles single user message without assistant response', () => {
  const messages = [
    { role: 'user', content: 'Hello, are you there?' },
  ];

  const rounds = splitIntoRounds(messages);

  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].roundIndex, 0);
  assert.equal(rounds[0].userContent, 'Hello, are you there?');
  assert.equal(rounds[0].assistantContent, '');
  assert.equal(rounds[0].content, 'User: Hello, are you there?\nAssistant: ');
});

test('skips system messages', () => {
  const messages = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Tell me a joke.' },
    { role: 'assistant', content: 'Why did the chicken cross the road?' },
    { role: 'system', content: 'Another system message mid-conversation.' },
    { role: 'user', content: 'Why?' },
    { role: 'assistant', content: 'To get to the other side!' },
  ];

  const rounds = splitIntoRounds(messages);

  assert.equal(rounds.length, 2);
  assert.equal(rounds[0].userContent, 'Tell me a joke.');
  assert.equal(rounds[0].assistantContent, 'Why did the chicken cross the road?');
  assert.equal(rounds[1].userContent, 'Why?');
  assert.equal(rounds[1].assistantContent, 'To get to the other side!');
});

test('preserves timestamps when provided', () => {
  const messages = [
    { role: 'user', content: 'What time is it?', timestamp: '2024-01-01T10:00:00Z' },
    { role: 'assistant', content: 'I do not have real-time information.', timestamp: '2024-01-01T10:00:05Z' },
  ];

  const rounds = splitIntoRounds(messages);

  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].timestamp, '2024-01-01T10:00:00Z');
});

test('returns empty array for empty input', () => {
  const rounds = splitIntoRounds([]);
  assert.deepEqual(rounds, []);
});
