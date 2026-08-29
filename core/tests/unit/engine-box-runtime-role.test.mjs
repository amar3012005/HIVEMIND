import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

async function loadRoleModule(env) {
  const before = { ENGINE_BOX_MODE: process.env.ENGINE_BOX_MODE, HIVEMIND_RUNTIME_ROLE: process.env.HIVEMIND_RUNTIME_ROLE };
  Object.assign(process.env, env);
  const module = await import(`../../src/runtime/runtime-role.js?engine-box-test=${crypto.randomUUID()}`);
  for (const [key, value] of Object.entries(before)) value === undefined ? delete process.env[key] : (process.env[key] = value);
  return module;
}

test('Engine Box never starts hosted connector, maintenance, or deep-research sidecars', async () => {
  const role = await loadRoleModule({ ENGINE_BOX_MODE: 'true', HIVEMIND_RUNTIME_ROLE: 'all' });
  assert.equal(role.shouldStartHttpServer(), true);
  assert.equal(role.shouldRunConnectorBackground(), false);
  assert.equal(role.shouldRunRecurringMaintenanceJobs(), false);
  assert.equal(role.shouldRunWarmupsAndSidecars(), false);
});
