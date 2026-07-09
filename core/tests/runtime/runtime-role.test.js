import test from 'node:test';
import assert from 'node:assert/strict';

async function loadRuntimeRole(query) {
  const moduleUrl = new URL(`../../src/runtime/runtime-role.js?${query}`, import.meta.url);
  return import(moduleUrl.href);
}

test('runtime role defaults to all-in-one', async () => {
  const prev = process.env.HIVEMIND_RUNTIME_ROLE;
  delete process.env.HIVEMIND_RUNTIME_ROLE;
  try {
    const mod = await loadRuntimeRole(`all=${Date.now()}`);
    assert.equal(mod.getRuntimeRole(), 'all');
    assert.equal(mod.shouldStartHttpServer(), true);
    assert.equal(mod.shouldRunRecurringMaintenanceJobs(), true);
    assert.equal(mod.shouldRunConnectorBackground(), true);
  } finally {
    if (prev === undefined) delete process.env.HIVEMIND_RUNTIME_ROLE;
    else process.env.HIVEMIND_RUNTIME_ROLE = prev;
  }
});

test('runtime role app disables recurring maintenance jobs', async () => {
  const prev = process.env.HIVEMIND_RUNTIME_ROLE;
  process.env.HIVEMIND_RUNTIME_ROLE = 'app';
  try {
    const mod = await loadRuntimeRole(`app=${Date.now()}`);
    assert.equal(mod.shouldStartHttpServer(), true);
    assert.equal(mod.shouldRunRecurringMaintenanceJobs(), false);
    assert.equal(mod.shouldRunConnectorBackground(), true);
    assert.equal(mod.shouldRunWarmupsAndSidecars(), false);
  } finally {
    if (prev === undefined) delete process.env.HIVEMIND_RUNTIME_ROLE;
    else process.env.HIVEMIND_RUNTIME_ROLE = prev;
  }
});

test('runtime role maintenance disables HTTP server and app-side background', async () => {
  const prev = process.env.HIVEMIND_RUNTIME_ROLE;
  process.env.HIVEMIND_RUNTIME_ROLE = 'maintenance';
  try {
    const mod = await loadRuntimeRole(`maintenance=${Date.now()}`);
    assert.equal(mod.shouldStartHttpServer(), false);
    assert.equal(mod.shouldRunRecurringMaintenanceJobs(), true);
    assert.equal(mod.shouldRunConnectorBackground(), false);
    assert.equal(mod.shouldRunWarmupsAndSidecars(), false);
  } finally {
    if (prev === undefined) delete process.env.HIVEMIND_RUNTIME_ROLE;
    else process.env.HIVEMIND_RUNTIME_ROLE = prev;
  }
});

test('runtime role sidecar disables HTTP and maintenance but runs warm paths', async () => {
  const prev = process.env.HIVEMIND_RUNTIME_ROLE;
  process.env.HIVEMIND_RUNTIME_ROLE = 'sidecar';
  try {
    const mod = await loadRuntimeRole(`sidecar=${Date.now()}`);
    assert.equal(mod.shouldStartHttpServer(), false);
    assert.equal(mod.shouldRunRecurringMaintenanceJobs(), false);
    assert.equal(mod.shouldRunConnectorBackground(), false);
    assert.equal(mod.shouldRunWarmupsAndSidecars(), true);
  } finally {
    if (prev === undefined) delete process.env.HIVEMIND_RUNTIME_ROLE;
    else process.env.HIVEMIND_RUNTIME_ROLE = prev;
  }
});
