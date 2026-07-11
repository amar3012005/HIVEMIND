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
  });
});
