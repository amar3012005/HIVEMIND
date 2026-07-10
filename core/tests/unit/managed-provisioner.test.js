import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

describe('managed provisioner', () => {
  it('reuses a completed registration without rotating credentials', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'hm-managed-'));
    const registry = path.join(dir, 'agents.json');
    const orgId = '11111111-1111-4111-8111-111111111111';
    await writeFile(registry, JSON.stringify({
      [orgId]: { kind: 'managed', url: 'http://agent:8787', token: 'existing-token' },
    }));
    const previousEnabled = process.env.MANAGED_AGENT_PROVISION;
    const previousRegistry = process.env.MNEME_AGENT_REGISTRY_FILE;
    try {
      process.env.MANAGED_AGENT_PROVISION = 'true';
      process.env.MNEME_AGENT_REGISTRY_FILE = registry;
      const { provisionManagedAgent } = await import(`../../src/selfhost/managed-provisioner.js?test=${Date.now()}`);
      const result = await provisionManagedAgent({ orgId });
      assert.deepEqual(result, {
        provisioned: true,
        registered: true,
        reused: true,
        url: 'http://agent:8787',
      });
    } finally {
      if (previousEnabled == null) delete process.env.MANAGED_AGENT_PROVISION;
      else process.env.MANAGED_AGENT_PROVISION = previousEnabled;
      if (previousRegistry == null) delete process.env.MNEME_AGENT_REGISTRY_FILE;
      else process.env.MNEME_AGENT_REGISTRY_FILE = previousRegistry;
    }
  });
});
