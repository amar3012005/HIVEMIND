import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyEmailTurnstile } from '../../src/auth/email-turnstile.js';

const env = {
  TURNSTILE_EMAIL_AUTH_SECRET: 'test-secret',
  TURNSTILE_EMAIL_AUTH_HOSTNAMES: 'next.singulancelabs.com',
};

function response(body, { ok = true } = {}) {
  return { ok, json: async () => body };
}

test('accepts only the email_auth action on an allowed hostname', async () => {
  const valid = await verifyEmailTurnstile({
    token: 'valid-token', env,
    fetchImpl: async () => response({ success: true, action: 'email_auth', hostname: 'next.singulancelabs.com' }),
  });
  assert.equal(valid, true);

  for (const result of [
    { success: true, hostname: 'next.singulancelabs.com' },
    { success: true, action: 'other', hostname: 'next.singulancelabs.com' },
    { success: true, action: 'email_auth', hostname: 'attacker.example' },
    { success: false, action: 'email_auth', hostname: 'next.singulancelabs.com' },
  ]) {
    assert.equal(await verifyEmailTurnstile({ token: 'token', env, fetchImpl: async () => response(result) }), false);
  }
});

test('fails closed for missing configuration, oversized tokens, HTTP errors, and invalid JSON', async () => {
  assert.equal(await verifyEmailTurnstile({ token: 'token', env: {}, fetchImpl: async () => response({ success: true }) }), false);
  assert.equal(await verifyEmailTurnstile({ token: 'x'.repeat(2049), env, fetchImpl: async () => response({}) }), false);
  assert.equal(await verifyEmailTurnstile({ token: 'token', env, fetchImpl: async () => response({}, { ok: false }) }), false);
  assert.equal(await verifyEmailTurnstile({ token: 'token', env, fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }) }), false);
});

test('local bypass requires both explicit local mode and bypass switch', async () => {
  assert.equal(await verifyEmailTurnstile({ token: '', env: { HIVEMIND_LOCAL_MODE: 'true', EMAIL_AUTH_TURNSTILE_BYPASS: 'true' } }), true);
  assert.equal(await verifyEmailTurnstile({ token: '', env: { HIVEMIND_LOCAL_MODE: 'false', EMAIL_AUTH_TURNSTILE_BYPASS: 'true' } }), false);
});
