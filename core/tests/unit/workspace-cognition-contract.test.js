import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync(new URL('../../src/server.js', import.meta.url), 'utf8');
const governance = fs.readFileSync(new URL('../../src/resident/governance-routes.js', import.meta.url), 'utf8');

test('cognition entitlement applies to the real cognition route namespace', () => {
  assert.match(server, /pathname\.startsWith\('\/api\/cognition'\)/);
});

test('tenant governance response does not read global agent state', () => {
  assert.doesNotMatch(governance, /governanceAgentState\.findMany\(\{\}\)/);
});

test('cognitive settings are owner/admin gated for reads and writes', () => {
  assert.match(governance, /if \(!await requireAdmin\(\)\) return ok\(\{ error: 'Resource not found' \}, 404\)/);
});

test('every tenant-visible cognition route uses the canonical admin policy', () => {
  for (const route of ['recent', 'runs', 'run-dreams', 'run-delete', 'synthesize-now', 'derivation']) {
    const routeStart = server.indexOf(`case '/api/cognition/${route}'`);
    assert.ok(routeStart >= 0, `missing cognition route ${route}`);
    const nextCase = server.indexOf("case '/api/", routeStart + 1);
    const body = server.slice(routeStart, nextCase < 0 ? undefined : nextCase);
    assert.match(body, /canManageCognition\(prisma, \{ orgId, userId, principal \}\)/, `${route} must use canonical cognition access`);
  }
});

test('private cognition input requires explicit individual consent', () => {
  const loop = fs.readFileSync(new URL('../../src/memory/cognition-loop.js', import.meta.url), 'utf8');
  assert.match(loop, /cognition_personal_opt_in = true/);
  assert.match(loop, /visibility: 'private', userId: \{ in: personalUserIds \}/);
});
