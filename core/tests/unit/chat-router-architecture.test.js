import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('canonical V2 entry has no reachable phrase intent calls or legacy downgrade', async () => {
  const source = await readFile(new URL('../../src/agent/react-agent-v2.js', import.meta.url), 'utf8');
  const entry = source.slice(source.indexOf('export async function runReactAgentV2'));
  for (const forbidden of ['quickGateClassify(', 'detectReadIntents(', 'detectWriteIntent(', 'rescueAutoSaveIntent(', '_isSaveImperative(']) {
    assert.equal(entry.includes(forbidden), false, forbidden);
  }
  const server = await readFile(new URL('../../src/server.js', import.meta.url), 'utf8');
  const routeStart = server.indexOf("case '/api/chat':");
  const route = server.slice(routeStart, server.indexOf('// ─── Assistant identity onboarding', routeStart));
  assert.equal(route.includes('HIVEMIND_AGENT_V1'), false);
  assert.equal(route.includes('falling back to legacy'), false);
  assert.equal(route.includes('extractNameIfIntent(message)'), false);
  assert.match(route, /chat_orchestration_failed/);
});
