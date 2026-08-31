import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../../src/server.js', import.meta.url), 'utf8');
const storeSource = fs.readFileSync(new URL('../../src/memory/prisma-graph-store.js', import.meta.url), 'utf8');
const engineSource = fs.readFileSync(new URL('../../src/memory/graph-engine.js', import.meta.url), 'utf8');

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

test('BYOD relationship writes route before every central relationship query', () => {
  const start = storeSource.indexOf('async createRelationship(edge)');
  const end = storeSource.indexOf('async createMemoryVersion', start);
  const method = storeSource.slice(start, end);
  const remoteBranch = method.indexOf('if (remoteLatched || orgIsRemote(_remoteOrg))');
  const centralLookup = method.indexOf('this.client.relationship.findFirst');
  assert.ok(remoteBranch > -1 && centralLookup > -1 && remoteBranch < centralLookup);
  assert.match(method.slice(remoteBranch, centralLookup), /await amrAddEdge/);
  assert.match(method.slice(remoteBranch, centralLookup), /remote relationship write was not acknowledged/);
});

test('central semantic edge lookup and budget are tenant-scoped through memory endpoints', () => {
  const start = storeSource.indexOf('async createRelationship(edge)');
  const end = storeSource.indexOf('async createMemoryVersion', start);
  const method = storeSource.slice(start, end);
  assert.doesNotMatch(method, /relationship\.findUnique/);
  assert.match(method, /fromMemory:\s*\{ orgId: _remoteOrg \}/);
  assert.match(method, /toMemory:\s*\{ orgId: _remoteOrg \}/);
  assert.match(method, /relationship\.count\([\s\S]*?fromMemory:\s*\{ orgId: _remoteOrg \}/);
});

test('semantic edge constructors carry explicit tenant scope into storage adapters', () => {
  const graphSource = fs.readFileSync(new URL('../../src/memory/graph-engine.js', import.meta.url), 'utf8');
  for (const marker of ['async applyUpdate(', 'async applyExtends(', 'async applyDerivesFromSources(']) {
    const start = graphSource.indexOf(marker);
    const end = graphSource.indexOf('\n  async ', start + marker.length);
    const method = graphSource.slice(start, end > start ? end : undefined);
    assert.match(method, /createRelationship\(\{[\s\S]*?org_id,/);
  }
});

test('remote memory hydration latches the agent backend through relationship persistence', () => {
  assert.match(storeSource, /function mapAgentRow[\s\S]*?_storage_backend:\s*'agent'/);
  assert.match(storeSource, /const remoteLatched = edge\.storage_backend === 'agent'/);
  assert.match(storeSource, /if \(remoteLatched \|\| orgIsRemote\(_remoteOrg\)\)/);
  assert.match(engineSource, /storage_backend:[^\n]+orgIsRemote\(org_id\) \? 'agent'/);
});
