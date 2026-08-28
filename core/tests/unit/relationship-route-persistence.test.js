import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../../src/server.js', import.meta.url), 'utf8');
const storeSource = fs.readFileSync(new URL('../../src/memory/prisma-graph-store.js', import.meta.url), 'utf8');

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

test('dual storage relationship writes await durable AMR admission', () => {
  const dualStart = storeSource.indexOf("if (mnemeMode() === 'dual')");
  const dualEnd = storeSource.indexOf('\n    return mapRelationshipRecord(created);', dualStart);
  assert.ok(dualStart > -1 && dualEnd > dualStart, 'dual storage relationship branch must exist');

  const dualBranch = storeSource.slice(dualStart, dualEnd);
  assert.match(dualBranch, /await amrAddEdge\(\{/);
  assert.doesNotMatch(dualBranch, /Promise\.resolve\(amrAddEdge/);
  assert.doesNotMatch(dualBranch, /\.catch\(\(\) => \{\}\)/);
});
