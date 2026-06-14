import test from 'node:test';
import assert from 'node:assert/strict';
import { stripIngestStamp } from '../../src/memory/cognition-loop.js';

test('strips the ingest timestamp suffix so the LLM never treats it as an event date', () => {
  assert.equal(stripIngestStamp('SOLVIS copyrighted the manual. (2026-06-14T18:57Z)'), 'SOLVIS copyrighted the manual.');
  assert.equal(stripIngestStamp('A fact. (2026-06-14)'), 'A fact.');
  assert.equal(stripIngestStamp('A fact. (2026-06-14T18:57:03Z)'), 'A fact.');
});

test('leaves real content + real in-sentence dates untouched', () => {
  assert.equal(stripIngestStamp('Launched on 2025-01-01 per the plan.'), 'Launched on 2025-01-01 per the plan.');
  assert.equal(stripIngestStamp('No stamp here'), 'No stamp here');
  assert.equal(stripIngestStamp(''), '');
});

test('strips repeated trailing stamps', () => {
  assert.equal(stripIngestStamp('Fact. (2026-06-14T18:57Z) (2026-06-14T18:57Z)'), 'Fact.');
});
