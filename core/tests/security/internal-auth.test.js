import test from 'node:test';
import assert from 'node:assert/strict';

async function loadInternalAuth(query) {
  const moduleUrl = new URL(`../../src/security/internal-auth.js?${query}`, import.meta.url);
  return import(moduleUrl.href);
}

test('internal auth allows explicit dev fallbacks outside production', async () => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    HIVEMIND_CONTROL_PLANE_SESSION_SECRET: process.env.HIVEMIND_CONTROL_PLANE_SESSION_SECRET,
    SESSION_SECRET: process.env.SESSION_SECRET,
  };
  delete process.env.HIVEMIND_CONTROL_PLANE_SESSION_SECRET;
  delete process.env.SESSION_SECRET;
  process.env.NODE_ENV = 'test';

  try {
    const mod = await loadInternalAuth(`dev-fallback=${Date.now()}`);
    assert.equal(
      mod.requireSessionSecret('HIVEMIND_CONTROL_PLANE_SESSION_SECRET', ['SESSION_SECRET']),
      'change-me',
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('internal auth rejects fallback secrets in production', async () => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    HIVEMIND_CONTROL_PLANE_SESSION_SECRET: process.env.HIVEMIND_CONTROL_PLANE_SESSION_SECRET,
    SESSION_SECRET: process.env.SESSION_SECRET,
  };
  process.env.NODE_ENV = 'production';
  delete process.env.HIVEMIND_CONTROL_PLANE_SESSION_SECRET;
  delete process.env.SESSION_SECRET;

  try {
    const mod = await loadInternalAuth(`prod-fail=${Date.now()}`);
    assert.throws(
      () => mod.requireSessionSecret('HIVEMIND_CONTROL_PLANE_SESSION_SECRET', ['SESSION_SECRET']),
      /must be configured in production/,
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('internal auth accepts configured master key and validates callers against it', async () => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    HIVEMIND_MASTER_API_KEY: process.env.HIVEMIND_MASTER_API_KEY,
    API_MASTER_KEY: process.env.API_MASTER_KEY,
  };
  process.env.NODE_ENV = 'production';
  process.env.HIVEMIND_MASTER_API_KEY = 'prod-master';
  delete process.env.API_MASTER_KEY;

  try {
    const mod = await loadInternalAuth(`master-key=${Date.now()}`);
    assert.equal(mod.getInternalApiKey({ allowDevFallback: false }), 'prod-master');
    assert.equal(mod.hasInternalApiKey('prod-master', { allowDevFallback: false }), true);
    assert.equal(mod.hasInternalApiKey('wrong', { allowDevFallback: false }), false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
