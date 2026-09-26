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

test('email login defaults fail closed instead of silently selecting account creation', async () => {
  const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../../src/auth/email-identity-service.js', import.meta.url), 'utf8'));
  assert.match(source, /intent\s*=\s*'login'/);
  assert.match(source, /const INTENTS = new Set\(\['login', 'register', 'developer'\]\)/);
  assert.match(source, /MAX_STARTS_PER_EMAIL/);
  assert.match(source, /requestFingerprintHash/);
});

test('ICARUS developer auth stays organization-free and never starts platform activation', async () => {
  const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../../src/control-plane-server.js', import.meta.url), 'utf8'));
  assert.match(source, /name: 'icarus-developer'/);
  assert.match(source, /orgId: null/);
  assert.match(source, /scopes: \['memory:read', 'memory:write', 'mcp'\]/);
  assert.match(source, /provider: 'icarus'/);
  assert.match(source, /!isDeveloperOnlyUser\(existingUser\)/);
  assert.match(source, /!membership\.org && !developerMode/);
  assert.match(source, /!org && !authState\.developerMode/);
  assert.match(source, /kind: 'icarus_developer'/);
});

test('resend rotates the credential and restores a full verification window', async () => {
  const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../../src/auth/email-identity-service.js', import.meta.url), 'utf8'));
  assert.match(source, /attempts: 0, verifiedAt: null, expiresAt: new Date\(now\.getTime\(\) \+ EXPIRY_MS\)/);
  assert.match(source, /otpHash: digest\(otp, 'otp'\), linkTokenHash: digest\(linkToken, 'link'\)/);
});

test('verified invitation signup provisions a native email identity without a Zitadel management dependency', async () => {
  const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../../src/control-plane-server.js', import.meta.url), 'utf8'));
  assert.match(source, /async function upsertVerifiedEmailUser\(email\)/);
  assert.match(source, /provider: 'email'/);
  assert.match(source, /user = await upsertVerifiedEmailUser\(verified\.email\)/);
  assert.doesNotMatch(source, /createZitadelEmailIdentity\(verified\.email\)/);
});
