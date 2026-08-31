import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEmail, resolveEmailIdentityMode, safeReturnTo } from '../../src/auth/email-identity-service.js';

test('normalizes valid email and rejects malformed input', () => {
  assert.equal(normalizeEmail('  Person@Example.COM '), 'person@example.com');
  assert.equal(normalizeEmail('not-an-email'), null);
  assert.equal(normalizeEmail('a@b'), null);
});

test('feature mode is fail-closed', () => {
  const previousEnabled = process.env.EMAIL_IDENTITY_V1_ENABLED;
  const previousMode = process.env.EMAIL_IDENTITY_V1_MODE;
  process.env.EMAIL_IDENTITY_V1_ENABLED = 'true';
  process.env.EMAIL_IDENTITY_V1_MODE = 'unexpected';
  assert.equal(resolveEmailIdentityMode(), 'off');
  process.env.EMAIL_IDENTITY_V1_MODE = 'email_only';
  assert.equal(resolveEmailIdentityMode(), 'email_only');
  process.env.EMAIL_IDENTITY_V1_ENABLED = 'false';
  assert.equal(resolveEmailIdentityMode(), 'off');
  if (previousEnabled === undefined) delete process.env.EMAIL_IDENTITY_V1_ENABLED; else process.env.EMAIL_IDENTITY_V1_ENABLED = previousEnabled;
  if (previousMode === undefined) delete process.env.EMAIL_IDENTITY_V1_MODE; else process.env.EMAIL_IDENTITY_V1_MODE = previousMode;
});

test('return destinations require an exact origin and hivemind path', () => {
  const previous = process.env.EMAIL_AUTH_ALLOWED_ORIGINS;
  process.env.EMAIL_AUTH_ALLOWED_ORIGINS = 'https://next.singulancelabs.com,https://next.preview.singulancelabs.com';
  const fallback = 'https://next.singulancelabs.com/hivemind/login';
  assert.equal(safeReturnTo('https://next.preview.singulancelabs.com/hivemind/app/overview', fallback), 'https://next.preview.singulancelabs.com/hivemind/app/overview');
  assert.equal(safeReturnTo('https://evil.example/hivemind/app', fallback), fallback);
  assert.equal(safeReturnTo('https://next.singulancelabs.com/admin', fallback), fallback);
  assert.equal(
    safeReturnTo('https://next.singulancelabs.com/hivemind/app/overview', fallback, ['https://next.preview.singulancelabs.com']),
    fallback,
  );
  if (previous === undefined) delete process.env.EMAIL_AUTH_ALLOWED_ORIGINS; else process.env.EMAIL_AUTH_ALLOWED_ORIGINS = previous;
});
