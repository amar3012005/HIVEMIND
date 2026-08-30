import test from 'node:test';
import assert from 'node:assert/strict';

import { Toolkit } from '../../src/agent/toolkit.js';
import { registerHivemindTools } from '../../src/agent/connector-toolkits/hivemind-tools.js';

test('native HIVEMIND tools use AgentScope-style inactive groups and annotations', () => {
  const toolkit = new Toolkit();
  registerHivemindTools(toolkit, { selectedGroups: ['hivemind-recall'] });
  const catalog = toolkit.getToolGroupCatalog();
  const recall = catalog.find((group) => group.name === 'hivemind-recall');
  assert.ok(recall);
  assert.equal(recall.active, false);
  assert.ok(recall.tools.some((tool) => tool.name === 'hivemind_recall' && tool.readOnly));
  assert.equal(toolkit.getJsonSchemas().length, 0);
  toolkit.resetEquippedTools(['hivemind-recall']);
  assert.ok(toolkit.getActiveToolNames().includes('hivemind_recall'));
});

test('tool execution rejects unknown/missing model arguments and server presets win', async () => {
  const toolkit = new Toolkit();
  let received;
  toolkit.registerToolFunction({
    name: 'scoped_read', description: 'Scoped read', readOnly: true,
    parameters: { type: 'object', properties: { query: { type: 'string' }, org_id: { type: 'string' } }, required: ['query', 'org_id'] },
    presetKwargs: { org_id: 'server-org' },
    handler: async (args) => { received = args; return args; },
  });
  const unknown = await toolkit.execute('scoped_read', { query: 'x', injected: true });
  assert.equal(unknown.status, 'error');
  const missing = await toolkit.execute('scoped_read', {});
  assert.equal(missing.status, 'error');
  const ok = await toolkit.execute('scoped_read', { query: 'x', org_id: 'attacker-org' });
  assert.equal(ok.status, 'ok');
  assert.equal(received.org_id, 'server-org');
});

test('approval token is rejected unless the server marks an approval flow', async () => {
  const toolkit = new Toolkit();
  toolkit.registerToolFunction({
    name: 'external_write', description: 'write', readOnly: false, external: true,
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    handler: async () => ({ ok: true }),
  });
  const denied = await toolkit.execute('external_write', { value: 'x', _approval_token: 'draft' }, {});
  assert.equal(denied.status, 'error');
});

test('toolkit accepts only allowlisted server-owned recall controls', async () => {
  const toolkit = new Toolkit();
  let received;
  toolkit.registerToolFunction({
    name: 'recall_read', description: 'recall', readOnly: true,
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    handler: async (args) => { received = args; return args; },
  });

  const ok = await toolkit.execute('recall_read', {
    query: 'SolvisPia',
    _structured_intent: true,
    _explicit_mode: false,
    _include_full_memory_content: true,
    _event_range: true,
    semantic_recovery: true,
    allow_semantic_source_recovery: true,
    reliability_v1: true,
  }, {}, { trustedInternalArgs: true });
  assert.equal(ok.status, 'ok');
  assert.equal(received._structured_intent, true);
  assert.equal(received._include_full_memory_content, true);
  assert.equal(received._event_range, true);
  assert.equal(received.semantic_recovery, true);
  assert.equal(received.reliability_v1, true);

  const denied = await toolkit.execute('recall_read', { query: 'SolvisPia', _unsafe_internal: true });
  assert.equal(denied.status, 'error');

  const untrusted = await toolkit.execute('recall_read', { query: 'SolvisPia', _explicit_mode: true });
  assert.equal(untrusted.status, 'error');
});
