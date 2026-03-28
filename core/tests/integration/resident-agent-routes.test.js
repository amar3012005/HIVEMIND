import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { RESIDENT_AGENT_ENDPOINTS } from '../../src/resident/contract.js';

const serverSource = readFileSync(new URL('../../src/server.js', import.meta.url), 'utf8');
const residentRoutesSource = readFileSync(new URL('../../src/resident/routes.js', import.meta.url), 'utf8');

test('resident-agent HTTP routes are registered in core server', () => {
  assert.ok(serverSource.includes('createResidentRoutes'));
  assert.ok(serverSource.includes('residentRoutes'));

  const expectedSnippets = [
    RESIDENT_AGENT_ENDPOINTS.listAgents.path,
    'runAgentMatch',
    '^\\/api\\/swarm\\/resident\\/agents\\/([^/]+)\\/run$',
    '^\\/api\\/swarm\\/resident\\/runs\\/([^/]+)$',
    '^\\/api\\/swarm\\/resident\\/runs\\/([^/]+)\\/observations$',
    '^\\/api\\/swarm\\/resident\\/runs\\/([^/]+)\\/cancel$',
  ];

  for (const snippet of expectedSnippets) {
    assert.ok(
      residentRoutesSource.includes(snippet),
      `Missing resident route snippet in core/src/resident/routes.js: ${snippet}`,
    );
  }
});
