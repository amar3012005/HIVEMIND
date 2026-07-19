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
