import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');

test('central document list and search select the persisted ingest mode', () => {
  const source = read('../../src/server.js');
  const route = source.slice(source.indexOf("case '/api/documents':"), source.indexOf('default:', source.indexOf("case '/api/documents':")));
  assert.equal((route.match(/ingestMode:\s*true/g) || []).length, 2);
});

test('embedded and BYOD document projections preserve unknown mode as null', () => {
  for (const relative of [
    '../../src/vector/mneme/embedded-agent.mjs',
    '../../../byod/agent/server.mjs',
  ]) {
    const source = read(relative);
    assert.match(source, /SELECT d\.id[^\n]+d\.ingest_mode/);
    assert.match(source, /ingestMode:\s*d\.ingest_mode \?\? d\.metadata\?\.ingest_mode \?\? null/);
  }
});
