const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateProfile, validateUploadEnvironment } = require('../scripts/mas-preflight.cjs');
const team = 'ABCDEFGHIJ';
const now = new Date('2026-10-16T00:00:00Z');
const profile = () => ({ Name: 'SINGULANCE App Store', Platform: ['OSX'], TeamIdentifier: [team],
  ExpirationDate: '2027-10-16T00:00:00Z', Entitlements: { 'com.apple.application-identifier': `${team}.com.singulancelabs.desktop` } });

test('App Store provisioning matches the exact macOS app and Apple team', () => {
  assert.deepEqual(validateProfile(profile(), team, undefined, now), { appId: 'com.singulancelabs.desktop', teamId: team,
    profileName: 'SINGULANCE App Store', expiresAt: '2027-10-16T00:00:00.000Z' });
});
test('iOS, wildcard, wrong-team and expired profiles never qualify a Mac TestFlight package', () => {
  for (const change of [
    value => { value.Platform = ['iOS']; },
    value => { value.Entitlements['com.apple.application-identifier'] = `${team}.*`; },
    value => { value.TeamIdentifier = ['WRONGTEAM1']; },
    value => { value.ExpirationDate = '2025-01-01T00:00:00Z'; },
    value => { value.ExpirationDate = 'invalid'; },
  ]) {
    const value = profile(); change(value); assert.throws(() => validateProfile(value, team, undefined, now));
  }
});
test('development, registered-device and Developer ID provisioning are rejected', () => {
  for (const change of [
    value => { value.Entitlements['get-task-allow'] = true; },
    value => { value.Entitlements['com.apple.security.get-task-allow'] = true; },
    value => { value.ProvisionedDevices = ['private-device']; },
    value => { value.ProvisionsAllDevices = true; },
  ]) {
    const value = profile(); change(value); assert.throws(() => validateProfile(value, team, undefined, now), /distribution provisioning/);
  }
});
test('upload accepts only explicit owner-private regular key files and never reads their contents', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'singulance-upload-test-'));
  try {
    const file = path.join(directory, 'fixture.p8'); fs.writeFileSync(file, 'not-a-real-credential', { mode: 0o600 });
    const env = { SINGULANCE_ASC_KEY_ID: 'ABC123DEF456', SINGULANCE_ASC_ISSUER_ID: '12345678-1234-1234-1234-123456789abc', SINGULANCE_ASC_KEY_PATH: file };
    const result = validateUploadEnvironment(env);
    assert.equal(result.keyPath, file); assert.doesNotMatch(JSON.stringify(result), /not-a-real-credential/);
    fs.chmodSync(file, 0o644); assert.throws(() => validateUploadEnvironment(env), /owner/);
    fs.chmodSync(file, 0o600);
    const link = path.join(directory, 'link.p8'); fs.symlinkSync(file, link);
    assert.throws(() => validateUploadEnvironment({ ...env, SINGULANCE_ASC_KEY_PATH: link }), /regular file/);
    assert.throws(() => validateUploadEnvironment({ ...env, SINGULANCE_ASC_KEY_ID: '' }));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
