import test from 'node:test';
import assert from 'node:assert/strict';

// Keep the public return contract documented here.  The dispatch implementation
// persists both IDs, but callers need the AgentScope session id—not the agent
// id—to attach a stream or a workspace.
test('dispatch contract names sessionId as the AgentScope session identifier', async () => {
  const source = await import('node:fs/promises').then((fs) => fs.readFile(
    new URL('../../src/employees/work-runs.js', import.meta.url),
    'utf8',
  ));
  assert.match(source, /runtimeSessionId = payload\.session_id \|\| null/);
  assert.match(source, /sessionId: runtimeSessionId/);
  assert.doesNotMatch(source, /sessionId: agentId/);
});
