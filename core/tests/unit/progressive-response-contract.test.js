import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Source contracts only: these protect route wiring without booting the
// production HTTP server. Runtime execution is covered in the harness suite.
const agent = await readFile(new URL('../../src/agent/react-agent-v2.js', import.meta.url), 'utf8');
const server = await readFile(new URL('../../src/server.js', import.meta.url), 'utf8');
const helper = agent.slice(agent.indexOf('const serveDurableAgent = async'), agent.indexOf('\n  try {', agent.indexOf('const serveDurableAgent = async')));

test('enabled progressive routing precedes legacy capability discovery and requires both gates', () => {
  const early = agent.indexOf('if (isProgressiveHarnessEnabled(process.env, ctx)');
  const catalog = agent.indexOf('const groupCatalog = await getCapabilityCatalogForUser');
  assert.ok(early > 0 && catalog > early);
  const gate = agent.slice(agent.lastIndexOf('if (useTools === true)', early), catalog);
  assert.match(gate, /isProgressiveHarnessEnabled\(process\.env, ctx\) && await isUseToolsDurableAgentEnabled\(\)/);
  assert.match(gate, /return await serveDurableAgent\(\)/);
  assert.ok(agent.indexOf('if (await isUseToolsDurableAgentEnabled()) return await serveDurableAgent();', catalog) > catalog);
});

test('initial response exposes presentation marker and execution receipt metadata', () => {
  assert.equal((helper.match(/harness_version: durable\.run\?\.scratch\?\.harness_version/g) || []).length, 2);
  assert.match(helper, /execution: \{[\s\S]*status: durable\.status/);
  assert.match(helper, /run_id: durable\.run\?\.id/);
  assert.match(helper, /threadId: ctx\.threadId \|\| ctx\.conversationId \|\| ctx\._conversationId \|\| null/);
  assert.match(helper, /\.\.\.ctx,\s+language,/);
  assert.match(helper, /conversationHistory: history/);
  assert.match(helper, /conversationHistory: durable\.run\?\.scratch\?\.conversation_context \|\| \[\]/);
});

test('both durable continuation branches retain locale, thread identity and response marker', () => {
  const enable = server.indexOf("if (stored.resumeState?.kind === 'enable_tools')");
  const durable = server.indexOf("if (stored.resumeState?.kind === 'durable_agent')", enable);
  const end = server.indexOf("const { runCompoundOrchestrator }", durable);
  for (const section of [server.slice(enable, durable), server.slice(durable, end)]) {
    assert.match(section, /language: stored\.language/);
    assert.match(section, /conversationHistory: stored\.conversationHistory \|\| \[\]/);
    assert.match(section, /conversationHistory: durable\.run\?\.scratch\?\.conversation_context \|\| stored\.conversationHistory \|\| \[\]/);
    assert.equal((section.match(/threadId: body\?\.thread_id \|\| body\?\.conversation_id \|\| stored\.threadId \|\| null/g) || []).length, 2);
    assert.equal((section.match(/harness_version: durable\.run\?\.scratch\?\.harness_version/g) || []).length, 2);
    assert.match(section, /execution: \{[\s\S]*status: durable\.status/);
  }
});

test('initial and continuation streaming done events preserve the full response object', () => {
  assert.match(server, /emit\(\{ type: 'done', \.\.\.result \}\)/);
  assert.match(server, /emit\(\{ type: 'done', \.\.\.continued \}\)/);
});
