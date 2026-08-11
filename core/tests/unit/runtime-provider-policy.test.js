import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getHyperagentsRuntimeConnectorProvider,
  listRuntimeConnectedCapabilities,
  runtimeConnectorConnectPath,
  toComposioToolkit,
} from '../../src/connectors/runtime-provider-policy.js';

test('runtime connector provider defaults safely to nango and accepts composio', () => {
  assert.equal(getHyperagentsRuntimeConnectorProvider({}), 'nango');
  assert.equal(getHyperagentsRuntimeConnectorProvider({ HYPERAGENTS_RUNTIME_CONNECTORS: 'composio' }), 'composio');
  assert.equal(getHyperagentsRuntimeConnectorProvider({ HYPERAGENTS_RUNTIME_CONNECTORS: 'invalid' }), 'nango');
});

test('Composio toolkit aliases preserve stable Runtime capability names', () => {
  assert.equal(toComposioToolkit('gmail'), 'gmail');
  assert.equal(toComposioToolkit('google-docs'), 'googledocs');
  assert.equal(toComposioToolkit('notion'), 'notion');
  const path = runtimeConnectorConnectPath('google-docs', 'composio');
  assert.match(path, /runtime_connector_provider=composio/);
  assert.match(path, /composio_toolkit=googledocs/);
});

test('Nango remains selectable and tenant scoped', async () => {
  const calls = [];
  const capabilities = await listRuntimeConnectedCapabilities({
    provider: 'nango', orgId: 'org-1', userId: 'user-1',
    prisma: { nangoConnection: { findMany: async (query) => {
      calls.push(query);
      return [{ providerKey: 'gmail' }, { providerKey: 'notion' }];
    } } },
  });
  assert.deepEqual(capabilities, ['gmail', 'notion']);
  assert.deepEqual(calls[0].where, { orgId: 'org-1', userId: 'user-1', status: 'active' });
});
