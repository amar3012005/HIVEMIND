import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../../src/server.js'), 'utf8');

test('unauthenticated remote MCP OAuth redirects to the canonical HIVEMIND login', () => {
  assert.match(source, /const dashboardLoginUrl = .*hivemind\/login\?cli_return_to/);
  assert.match(source, /res\.writeHead\(302, \{ Location: dashboardLoginUrl \}\)/);
  assert.match(source, /OAuth clients must use the product's canonical, authenticated login\s+\/\/ surface/);
});
