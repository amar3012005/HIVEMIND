import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../../src/server.js', import.meta.url), 'utf8');

test('idempotent interactive saves defer entity linking until after persistence', () => {
  const syncStart = source.indexOf('// --- Synchronous ingest');
  const syncEnd = source.indexOf("case '/api/memories/ingest/status'", syncStart);
  assert.ok(syncStart > -1 && syncEnd > syncStart, 'sync memory ingest route must exist');
  const syncRoute = source.slice(syncStart, syncEnd);

  assert.match(syncRoute, /if \(saveKey\) \{\s*p\.defer_entity_linking = true;/);
  assert.match(syncRoute, /p\.skip_fact_extraction = true;/);
  assert.match(syncRoute, /p\.tree\.parent\.skip_fact_extraction = true;/);
  assert.match(syncRoute, /c\.skip_fact_extraction = true;/);
  assert.match(syncRoute, /persistentMemoryEngine\.linkEntitiesForMemories\(\[memory \|\| \{ id: result\.memoryId \}\]\)/);
  assert.match(syncRoute, /if \(saveKey\) \{\s*indexTask\.catch/);
  assert.match(syncRoute, /if \(saveKey\) \{\s*indexFactMemories\(\)\.catch/);
  assert.match(syncRoute, /if \(saveKey\) \{\s*projection = \{ mode: canonicalMode, status: 'queued' \}/);
  assert.match(syncRoute, /status: 'completed'/);
});
