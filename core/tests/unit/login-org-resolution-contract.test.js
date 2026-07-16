import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('login reuses an active session organization before selecting the newest active membership', () => {
  const source = fs.readFileSync(new URL('../../src/control-plane-server.js', import.meta.url), 'utf8');
  const resolver = source.match(/async function resolveCurrentOrg[\s\S]*?\n}\n\nasync function upsertUserFromZitadel/);

  assert.ok(resolver, 'organization resolver must exist');
  assert.match(resolver[0], /userId_orgId: \{ userId, orgId: preferredOrgId \}/);
  assert.match(resolver[0], /preferred\?\.isActive/);
  assert.match(resolver[0], /where: \{ userId, isActive: true \}/);
  assert.match(resolver[0], /joinedAt: 'desc'/);
  assert.match(source, /buildBootstrapPayload\(user, req, current\.session\.orgId\)/);
});
