import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const server = fs.readFileSync(path.resolve('core/src/server.js'), 'utf8');
const hosted = fs.readFileSync(path.resolve('core/src/mcp/hosted-service.js'), 'utf8');

test('production MCP discovery and installers use the canonical SINGULANCE origin', () => {
  assert.match(server, /https:\/\/core\.singulancelabs\.com\/api\/mcp/);
  assert.match(hosted, /https:\/\/core\.singulancelabs\.com/);
  assert.doesNotMatch(server, /core\.hivemind\.davinciai\.eu:8050/);
  assert.doesNotMatch(hosted, /core\.hivemind\.davinciai\.eu:8050/);
});
