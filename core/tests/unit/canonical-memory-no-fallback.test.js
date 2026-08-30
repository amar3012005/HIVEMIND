import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../../src/server.js', import.meta.url), 'utf8');

test('canonical API memory saves never retry through the legacy persistence tree', () => {
  const start = source.indexOf('async function ingestRoutedPayloadCanonical');
  const marker = source.indexOf('// V5 Phase 5C', start);
  const end = marker > start ? marker : -1;
  assert.ok(start > -1 && end > start, 'canonical dispatcher must exist');
  const dispatcher = source.slice(start, end);
  assert.match(dispatcher, /await ingestCanonicalPayload/);
  assert.match(dispatcher, /if \(!v5 \|\| routedPayload\?\.__ingest_tree\) return ingestRoutedPayload/);
  assert.doesNotMatch(dispatcher, /catch\s*\(/);
});
