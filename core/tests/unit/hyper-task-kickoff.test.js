import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('HyperAgents task kickoff contract', () => {
  it('creates and dispatches the first turn from the task-open route', async () => {
    const source = await readFile(new URL('../../src/control-plane-server.js', import.meta.url), 'utf8');
    const route = source.slice(source.indexOf("if (pathname === '/v1/hyper/tasks/open'"), source.indexOf('// GET/PATCH /v1/hyper-rooms/:id/connectors'));

    assert.match(route, /const startTaskKickoff = async/);
    assert.match(route, /userMessage: visibleKickoff/);
    assert.match(route, /user_message: executionBrief/);
    assert.match(route, /const turn = await startTaskKickoff\(\{ \.\.\.taskRoom, goal \}\)/);
    assert.match(route, /const capacity = await getHyperRoomCapacity\(current\.session\.orgId\)/);
    assert.match(route, /hyperRoomLimitResponse\(capacity\), 402/);
  });

  it('uses one non-HQ room capacity rule for every creation path', async () => {
    const source = await readFile(new URL('../../src/control-plane-server.js', import.meta.url), 'utf8');
    assert.match(source, /async function getHyperRoomCapacity/);
    assert.match(source, /COALESCE\("agent_connectors", '\{\}'::jsonb\) \? '_company'/);
    assert.equal((source.match(/getHyperRoomCapacity\(/g) || []).length >= 4, true);
  });
});
