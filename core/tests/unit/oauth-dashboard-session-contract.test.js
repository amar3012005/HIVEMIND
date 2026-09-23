import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const coreSource = fs.readFileSync(path.resolve(here, '../../src/server.js'), 'utf8');
const controlPlaneSource = fs.readFileSync(path.resolve(here, '../../src/control-plane-server.js'), 'utf8');

test('remote MCP OAuth accepts the control-plane browser session on the SINGULANCE domain', () => {
  assert.match(coreSource, /HIVEMIND_CONTROL_PLANE_SESSION_SECRET/);
  assert.match(coreSource, /resolveDashboardSessionViaControlPlane/);
  assert.match(coreSource, /\/auth\/session/);
  assert.match(coreSource, /needsOAuthSession/);
  assert.match(controlPlaneSource, /pathname === '\/auth\/session'/);
  assert.match(controlPlaneSource, /'Set-Cookie': makeSessionCookie\(current\.sessionId\)/);
  assert.match(controlPlaneSource, /function defaultSessionCookieDomain/);
  assert.match(controlPlaneSource, /host\.endsWith\('\.singulancelabs\.com'\).*return '\.singulancelabs\.com'/);
});
