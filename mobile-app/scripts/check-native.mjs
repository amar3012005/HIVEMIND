import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const config = await readFile('capacitor.config.ts', 'utf8');
const manifest = await readFile('android/app/src/main/AndroidManifest.xml', 'utf8');
const plist = await readFile('ios/App/App/Info.plist', 'utf8');
assert.match(config, /cleartext: false/);
assert.match(config, /allowMixedContent: false/);
assert.doesNotMatch(config, /allowNavigation/);
assert.match(manifest, /android:allowBackup="false"/);
assert.match(manifest, /android:usesCleartextTraffic="false"/);
assert.match(manifest, /android.permission.RECORD_AUDIO/);
assert.match(manifest, /android:host="auth" android:path="\/callback"/);
assert.match(plist, /NSMicrophoneUsageDescription/);
assert.doesNotMatch(plist, /NSAllowsArbitraryLoads/);
if (process.argv.includes('--release')) {
  assert.ok(!process.env.SINGULANCE_MOBILE_REMOTE_URL, 'Remote server.url must not be used for a store build.');
  const html = await readFile('www/index.html', 'utf8');
  assert.match(html, /<script[^>]+src=/i, 'Package the compiled frontend first.');
  const provenance = JSON.parse(await readFile('www/mobile-build.json', 'utf8'));
  assert.match(provenance.frontendSha || '', /^[a-f0-9]{40}$/, 'Pin the exact reviewed frontend SHA.');
  const nativeConfig = JSON.parse(await readFile('android/app/src/main/assets/capacitor.config.json', 'utf8'));
  assert.ok(!nativeConfig.server?.url, 'Sync default packaged config before release.');
  const readiness = JSON.parse(await readFile('release-evidence.json', 'utf8'));
  for (const field of ['nativeAuthentication', 'deviceMicrophone', 'oauthReturn', 'accountDeletion', 'privacyReview', 'billingReview']) {
    assert.equal(readiness[field]?.verified, true, `Live verification missing: ${field}`);
    assert.ok(readiness[field]?.evidence, `Evidence missing: ${field}`);
  }
  if (!process.argv.includes('--ios')) for (const name of ['SINGULANCE_ANDROID_KEYSTORE', 'SINGULANCE_ANDROID_KEYSTORE_PASSWORD', 'SINGULANCE_ANDROID_KEY_ALIAS', 'SINGULANCE_ANDROID_KEY_PASSWORD']) assert.ok(process.env[name], `Signing configuration missing: ${name}`);
}
console.log('Native configuration checks passed' + (process.argv.includes('--release') ? '; release prerequisites supplied.' : '; this does not verify store readiness.'));
