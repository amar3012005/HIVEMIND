import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../../src/server.js', import.meta.url), 'utf8');

test('canonical API memory saves never retry through the legacy persistence tree', () => {
  const start = source.indexOf('async function ingestRoutedPayloadCanonical');
  const marker = source.indexOf('async function taraCanonicalSave', start);
  const end = marker > start ? marker : -1;
  assert.ok(start > -1 && end > start, 'canonical dispatcher must exist');
  const dispatcher = source.slice(start, end);
  assert.match(dispatcher, /await ingestCanonicalPayload/);
  assert.match(dispatcher, /if \(routedPayload\?\.__ingest_tree\) return ingestRoutedPayload/);
  assert.doesNotMatch(dispatcher, /V5_MEMORIES_CANONICAL/);
  assert.doesNotMatch(dispatcher, /catch\s*\(/);
});

test('TARA memory saves have no raw-store persistence fallback', () => {
  const start = source.indexOf('async function taraCanonicalSave');
  const end = source.indexOf('async function ingestCanonicalPayload', start);
  assert.ok(start > -1 && end > start);
  const dispatcher = source.slice(start, end);
  assert.match(dispatcher, /mode: 'atomic'/);
  assert.doesNotMatch(dispatcher, /persistentMemoryStore\.createMemory/);
  assert.doesNotMatch(dispatcher, /catch\s*\(/);
});
