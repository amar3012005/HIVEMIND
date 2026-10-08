import assert from 'node:assert/strict';
import { validateReleaseEvidence } from './release-evidence.mjs';
import { readFile, stat } from 'node:fs/promises';
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
const privacy = await readFile('ios/App/App/PrivacyInfo.xcprivacy', 'utf8');
assert.match(privacy, /NSPrivacyAccessedAPITypes/);
assert.match(await readFile('ios/App/App.xcodeproj/project.pbxproj', 'utf8'), /PrivacyInfo.xcprivacy in Resources/);
assert.doesNotMatch(plist, /NSAllowsArbitraryLoads/);
const androidBridge = await readFile('android/app/src/main/java/com/singulancelabs/mobile/SingulanceNativePlugin.java', 'utf8');
const iosBridge = await readFile('ios/App/App/SingulanceNativePlugin.swift', 'utf8');
assert.match(androidBridge, /AndroidKeyStore/);
assert.match(androidBridge, /cookieJar\(runnerCookies\)/);
assert.doesNotMatch(androidBridge, /CookieManager/);
assert.match(iosBridge, /configuration.httpShouldSetCookies = false/);
assert.match(iosBridge, /request.httpShouldHandleCookies = false/);
assert.match(androidBridge, /ACTION_CREATE_DOCUMENT/);
assert.match(iosBridge, /UIDocumentPickerViewController\(forExporting/);
assert.match(androidBridge, /WEB_MESSAGE_LISTENER/);
const activity = await readFile('android/app/src/main/java/com/singulancelabs/mobile/MainActivity.java', 'utf8');
assert.match(activity, /removeJavascriptInterface\("androidBridge"\)/);
assert.match(activity, /registerPlugin\(SingulanceNativePlugin.class\)/);
const scene = await readFile('ios/App/App/SceneDelegate.swift', 'utf8');
assert.match(scene, /SingulanceViewController\(\)/);
assert.match(androidBridge, /wss:\/\/next.singulancelabs.com\/api\/remote.mux/);
assert.match(iosBridge, /kSecAttrAccessibleWhenUnlockedThisDeviceOnly/);
assert.match(iosBridge, /message.frameInfo.isMainFrame/);
assert.match(iosBridge, /completionHandler\(nil\)/);

if (process.argv.includes('--release') || process.argv.includes('--packaged')) {
  assert.ok(!process.env.SINGULANCE_MOBILE_REMOTE_URL, 'Remote server.url must not be used for a store build.');
  const html = await readFile('www/index.html', 'utf8');
  assert.match(html, /<script[^>]+src=/i, 'Package the compiled frontend first.');
  const provenance = JSON.parse(await readFile('www/mobile-build.json', 'utf8'));
  assert.match(provenance.frontendSha || '', /^[a-f0-9]{40}$/, 'Pin the exact reviewed frontend SHA.');
  const nativeConfig = JSON.parse(await readFile(process.argv.includes('--ios') ? 'ios/App/App/capacitor.config.json' : 'android/app/src/main/assets/capacitor.config.json', 'utf8'));
  assert.ok(!nativeConfig.server?.url, 'Sync default packaged config before release.');
  if (process.argv.includes('--release')) {
  const readiness = JSON.parse(await readFile('release-evidence.json', 'utf8'));
  validateReleaseEvidence(readiness, provenance.frontendSha, process.argv.includes('--ios') ? 'ios' : 'android');
  if (!process.argv.includes('--ios')) {
    assert.ok((await stat(process.env.SINGULANCE_ANDROID_KEYSTORE || '/nonexistent-signing-keystore')).isFile(), 'Signing keystore must be a real file.');
    assert.match(process.env.SINGULANCE_ANDROID_VERSION_CODE || '', /^[1-9][0-9]*$/, 'Supply the intended positive Play version code.');
    assert.match(process.env.SINGULANCE_MOBILE_VERSION || '', /^[0-9]+\.[0-9]+\.[0-9]+$/, 'Supply the intended release version.');
  }
  if (!process.argv.includes('--ios')) for (const name of ['SINGULANCE_ANDROID_KEYSTORE', 'SINGULANCE_ANDROID_KEYSTORE_PASSWORD', 'SINGULANCE_ANDROID_KEY_ALIAS', 'SINGULANCE_ANDROID_KEY_PASSWORD']) assert.ok(process.env[name], `Signing configuration missing: ${name}`);
  }
}
console.log('Native configuration checks passed' + (process.argv.includes('--release') ? '; release prerequisites supplied.' : '; this does not verify store readiness.'));
