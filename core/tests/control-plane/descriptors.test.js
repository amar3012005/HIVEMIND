import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAllClientDescriptors, buildClientDescriptor } from '../../src/control-plane/descriptors.js';

test('control-plane client descriptors use env-driven core API base URL', () => {
  const descriptor = buildClientDescriptor('claude', {
    coreApiBaseUrl: 'https://api.hivemind.davinciai.eu',
    userId: 'user-123',
    apiKey: 'hmk_live_test'
  });

  assert.equal(descriptor.config.mcpServers.hivemind.env.HIVEMIND_API_URL, 'https://api.hivemind.davinciai.eu');
  assert.equal(descriptor.config.mcpServers.hivemind.env.HIVEMIND_API_KEY, 'hmk_live_test');
});

test('control-plane can build all supported client descriptors', () => {
  const descriptors = buildAllClientDescriptors({
    coreApiBaseUrl: 'https://api.hivemind.davinciai.eu',
    userId: 'user-123'
  });

  assert.equal(descriptors.length, 4);
  assert.deepEqual(descriptors.map(item => item.client), ['claude', 'antigravity', 'vscode', 'remote-mcp']);
});
