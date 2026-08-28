import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../../src/server.js', import.meta.url), 'utf8');

test('public relationship writes use the canonical validated dispatcher', () => {
  const routeStart = source.indexOf("case '/api/relationships':");
  const routeEnd = source.indexOf("case '/api/temporal/as-of':", routeStart);
  assert.ok(routeStart > -1 && routeEnd > routeStart, 'relationship route must exist');

  const route = source.slice(routeStart, routeEnd);
  assert.match(route, /await persistentMemoryEngine\.applyValidatedRelationship\(\{/);
  assert.match(route, /store:\s*persistentMemoryStore/);
  assert.match(route, /org_id:\s*orgId/);
  assert.doesNotMatch(route, /await engine\.createRelationship\(/);
});
