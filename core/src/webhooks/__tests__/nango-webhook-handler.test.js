/**
 * RED + REGRESSION tests for T2: nango-webhook-handler.js
 *
 * RED tests (will fail):
 *   T2-2: personio-v2 not in PROVIDER_ADAPTERS yet
 *   T2-3: 'personio' alias not in PROVIDER_ADAPTERS yet
 *
 * GREEN tests (should already pass — regression guards):
 *   T2-1: verifyNangoSignature fail-close when secret is undefined
 *   T2-4: google-mail resolves
 *   T2-5: slack resolves
 *   T2-6: invalid HMAC rejected
 *
 * NOTE: verifyNangoSignature is not exported. We test it via the full
 * handleNangoWebhook entry point by sending requests with known signatures.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';

// We need to test the internal PROVIDER_ADAPTERS map and signature
// verification without starting a real server. Import the handler directly.
import { handleNangoWebhook } from '../nango-webhook-handler.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a raw + parsed body pair and optionally a valid HMAC signature
 * using the given secret.
 */
function buildRequest(body, secret = '') {
  const rawBody = JSON.stringify(body);
  let sig = '';
  if (secret) {
    sig = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  }
  return { rawBody, body, sig };
}

/** Minimal deps object — we're testing routing logic, not full sync. */
function makeDeps(overrides = {}) {
  return {
    prisma: {
      nangoConnection: {
        findFirst: vi.fn().mockResolvedValue({
          userId: 'user-001',
          orgId: 'org-001',
          providerKey: 'test',
        }),
      },
    },
    persistentMemoryStore: {},
    persistentMemoryEngine: {},
    smartIngestRouter: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// T2-1: verifyNangoSignature fail-CLOSE when NANGO_WEBHOOK_SECRET is not set
// ---------------------------------------------------------------------------
describe('nango-webhook-handler — signature verification', () => {
  it('T2-1: SECURITY — when NANGO_WEBHOOK_SECRET is empty, handler should NOT silently accept (fail-close)', async () => {
    // The CURRENT implementation accepts all requests when secret is not set
    // (it logs a warning and returns true). This test documents that the
    // DESIRED behaviour is fail-close (return false / reject).
    //
    // This test will FAIL against the current implementation because the
    // current code does: if (!NANGO_WEBHOOK_SECRET) { return true; }
    // The correct behaviour is: if (!NANGO_WEBHOOK_SECRET) { return false; }

    const originalSecret = process.env.NANGO_WEBHOOK_SECRET;
    const originalSecretKey = process.env.NANGO_SECRET_KEY;
    delete process.env.NANGO_WEBHOOK_SECRET;
    delete process.env.NANGO_SECRET_KEY;

    try {
      // The module caches NANGO_WEBHOOK_SECRET at import time, so we test
      // via the exported function with an empty-secret scenario.
      // We simulate an empty-secret handler by checking the response:
      // when no secret is set, ANY signature (including empty) would be
      // accepted by the current code — which is the security flaw.
      const { rawBody, body } = buildRequest({
        type: 'sync.completed',
        providerConfigKey: 'google-mail',
        connectionId: 'user_user-001',
      });

      // Send with NO signature header — should be rejected when fail-close
      const result = await handleNangoWebhook({
        rawBody,
        body,
        headers: {}, // no x-nango-signature
        deps: makeDeps(),
      });

      // DESIRED (RED): fail-close means empty secret → reject → 'error'
      // CURRENT (will make this test RED): returns 'ok' or 'skipped' because
      // the module-level NANGO_WEBHOOK_SECRET was already loaded as ''
      // and the code says "skip verification" → passes through.
      //
      // This test is intentionally strict: no-secret-configured must return error.
      expect(result.status).toBe('error');
      expect(result.reason).toMatch(/invalid-signature|no-secret/);
    } finally {
      if (originalSecret !== undefined) process.env.NANGO_WEBHOOK_SECRET = originalSecret;
      if (originalSecretKey !== undefined) process.env.NANGO_SECRET_KEY = originalSecretKey;
    }
  });

  it('T2-6: request with invalid HMAC signature is rejected (regression guard)', async () => {
    // This SHOULD already pass — existing implementation validates HMAC.
    // Set a known secret in env. Since the module caches at load time,
    // we test with the already-loaded module state.
    // We craft a body with a WRONG signature to verify rejection.
    const secret = process.env.NANGO_WEBHOOK_SECRET || process.env.NANGO_SECRET_KEY || 'test-secret-for-tests';

    const { rawBody, body } = buildRequest({
      type: 'sync.completed',
      providerConfigKey: 'google-mail',
      connectionId: 'user_user-001',
    }, secret);

    const tamperedSig = 'deadbeef'.repeat(8); // wrong sig

    const result = await handleNangoWebhook({
      rawBody,
      body,
      headers: { 'x-nango-signature': tamperedSig },
      deps: makeDeps(),
    });

    // Must be rejected — tampered signature
    expect(result.status).toBe('error');
    expect(result.reason).toBe('invalid-signature');
  });
});

// ---------------------------------------------------------------------------
// T2-2: personio-v2 resolves to a non-null adapter (RED — not wired yet)
// T2-3: personio alias also resolves (RED — alias missing)
// ---------------------------------------------------------------------------
describe('nango-webhook-handler — PROVIDER_ADAPTERS routing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('T2-2: RED — providerConfigKey=personio-v2 resolves to an adapter (fails: not in PROVIDER_ADAPTERS)', async () => {
    // We need a valid signature. Since the module loaded with env NANGO_WEBHOOK_SECRET
    // potentially unset (returns true), we exploit that to test routing.
    // If secret IS set, we provide the correct sig.
    const secret = process.env.NANGO_WEBHOOK_SECRET || process.env.NANGO_SECRET_KEY || '';
    const body = {
      type: 'auth.created',
      providerConfigKey: 'personio-v2',
      connectionId: 'user_user-001',
    };
    const rawBody = JSON.stringify(body);
    const sig = secret
      ? crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
      : 'aabbccdd'.repeat(8); // placeholder when no secret (handler accepts all)

    // Mock dynamic import so we don't need real adapter file
    // The test expects routing to find personio-v2 in PROVIDER_ADAPTERS.
    // Currently it's missing → triggerIncrementalSync throws "Unknown Nango provider"
    // → handler returns { status: 'error', reason: 'Unknown Nango provider: personio-v2' }
    const result = await handleNangoWebhook({
      rawBody,
      body,
      headers: { 'x-nango-signature': sig },
      deps: makeDeps(),
    });

    // DESIRED: result.status === 'ok' (adapter found and sync triggered)
    // CURRENT: result.status === 'error', reason includes 'Unknown Nango provider'
    // → test is RED
    expect(result.status).toBe('ok');
  });

  it('T2-3: RED — providerConfigKey=personio (alias) resolves to same adapter', async () => {
    const secret = process.env.NANGO_WEBHOOK_SECRET || process.env.NANGO_SECRET_KEY || '';
    const body = {
      type: 'auth.created',
      providerConfigKey: 'personio',
      connectionId: 'user_user-001',
    };
    const rawBody = JSON.stringify(body);
    const sig = secret
      ? crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
      : 'aabbccdd'.repeat(8);

    const result = await handleNangoWebhook({
      rawBody,
      body,
      headers: { 'x-nango-signature': sig },
      deps: makeDeps(),
    });

    // DESIRED: ok (alias resolves). CURRENT: error 'Unknown Nango provider: personio' → RED
    expect(result.status).toBe('ok');
  });

  it('T2-4: REGRESSION — google-mail still resolves (must stay GREEN)', async () => {
    const secret = process.env.NANGO_WEBHOOK_SECRET || process.env.NANGO_SECRET_KEY || '';
    const body = {
      type: 'auth.created',
      providerConfigKey: 'google-mail',
      connectionId: 'user_user-001',
    };
    const rawBody = JSON.stringify(body);
    const sig = secret
      ? crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
      : 'aabbccdd'.repeat(8);

    const result = await handleNangoWebhook({
      rawBody,
      body,
      headers: { 'x-nango-signature': sig },
      deps: makeDeps(),
    });

    // google-mail IS in PROVIDER_ADAPTERS → should resolve.
    // It may fail dynamic import in test env (no real file system) but
    // the error should NOT be "Unknown Nango provider".
    if (result.status === 'error') {
      expect(result.reason).not.toMatch(/Unknown Nango provider/);
    }
    // Acceptable outcomes: 'ok' (full sync ran) or 'error' with adapter-import/runtime error
    expect(['ok', 'error', 'skipped']).toContain(result.status);
  });

  it('T2-5: REGRESSION — slack still resolves (must stay GREEN)', async () => {
    const secret = process.env.NANGO_WEBHOOK_SECRET || process.env.NANGO_SECRET_KEY || '';
    const body = {
      type: 'auth.created',
      providerConfigKey: 'slack',
      connectionId: 'user_user-001',
    };
    const rawBody = JSON.stringify(body);
    const sig = secret
      ? crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
      : 'aabbccdd'.repeat(8);

    const result = await handleNangoWebhook({
      rawBody,
      body,
      headers: { 'x-nango-signature': sig },
      deps: makeDeps(),
    });

    // slack IS in PROVIDER_ADAPTERS → not "Unknown Nango provider"
    if (result.status === 'error') {
      expect(result.reason).not.toMatch(/Unknown Nango provider/);
    }
    expect(['ok', 'error', 'skipped']).toContain(result.status);
  });
});

// ---------------------------------------------------------------------------
// T2-STRUCTURE: PROVIDER_ADAPTERS map is accessible for white-box inspection
// ---------------------------------------------------------------------------
describe('nango-webhook-handler — PROVIDER_ADAPTERS map contents', () => {
  it('T2-7: RED — PROVIDER_ADAPTERS must contain personio-v2 key after wiring', async () => {
    // We re-import the module to inspect its internals.
    // Since PROVIDER_ADAPTERS is not exported, we do a text-based check.
    const fs = await import('fs');
    const path = await import('path');
    const handlerPath = path.resolve(
      new URL('.', import.meta.url).pathname,
      '../nango-webhook-handler.js'
    );
    const source = fs.readFileSync(handlerPath, 'utf8');

    // This will FAIL until personio-v2 is added to PROVIDER_ADAPTERS
    expect(source).toMatch(/'personio-v2'/);
  });

  it('T2-8: RED — PROVIDER_ADAPTERS must contain personio alias after wiring', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const handlerPath = path.resolve(
      new URL('.', import.meta.url).pathname,
      '../nango-webhook-handler.js'
    );
    const source = fs.readFileSync(handlerPath, 'utf8');

    // This will FAIL until 'personio' alias is added
    // (check it's a key, not part of 'personio-v2')
    expect(source).toMatch(/['"]personio['"]\s*:/);
  });
});
