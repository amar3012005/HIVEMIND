import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('TARA token mint requires privileged agent access', () => {
  const source = fs.readFileSync(new URL('../../src/control-plane-server.js', import.meta.url), 'utf8');
  const route = source.match(/if \(pathname === '\/v1\/tara\/cartesia-token'[\s\S]*?const apiKey/);

  assert.ok(route, 'TARA token route must exist');
  assert.match(route[0], /requireSession\(req, res\)/);
  assert.match(route[0], /requirePrivilegedAgentAccess\(req, res, current\)/);
});
