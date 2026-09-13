import test from 'node:test';
import assert from 'node:assert/strict';
import { entityDiscoveryCanaryFor } from '../../src/employees/cloudflare-hyper-planner-client.js';

test('entity discovery explicit deployment flag enables the generic local capability', async () => {
  const previous = process.env.HIVEMIND_ENTITY_DISCOVERY_ENABLED;
  process.env.HIVEMIND_ENTITY_DISCOVERY_ENABLED = 'true';
  try {
    assert.equal(await entityDiscoveryCanaryFor({}), true);
  } finally {
    if (previous === undefined) delete process.env.HIVEMIND_ENTITY_DISCOVERY_ENABLED;
    else process.env.HIVEMIND_ENTITY_DISCOVERY_ENABLED = previous;
  }
});

test('entity discovery remains fail closed without an explicit flag or Flagship configuration', async () => {
  const previous = process.env.HIVEMIND_ENTITY_DISCOVERY_ENABLED;
  delete process.env.HIVEMIND_ENTITY_DISCOVERY_ENABLED;
  try {
    assert.equal(await entityDiscoveryCanaryFor({ orgId: 'org', userId: 'user', email: 'user@example.com' }), false);
  } finally {
    if (previous !== undefined) process.env.HIVEMIND_ENTITY_DISCOVERY_ENABLED = previous;
  }
});

