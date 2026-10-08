import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
test('native navigation delegates only the exact application origin to its privileged WebView', async () => {
  const source = await readFile('android/app/src/main/java/com/singulancelabs/mobile/MainActivity.java', 'utf8');
  assert.match(source, /if \(!request.isForMainFrame\(\)\)/);
  assert.match(source, /NavigationPolicy.sameOrigin/);
  const policy = await readFile('android/app/src/main/java/com/singulancelabs/mobile/NavigationPolicy.java', 'utf8');
  assert.match(policy, /uri.getPort\(\) == origin.getPort\(\)/);
  assert.match(policy, /uri.getUserInfo\(\) == null/);
  assert.match(source, /ActivityNotFoundException/);
});
test('release guard rejects the development placeholder', async () => {
  const source = await readFile('scripts/check-native.mjs', 'utf8');
  assert.match(source, /Package the compiled frontend first/);
  assert.match(source, /nativeAuthentication/);
  assert.match(source, /Signing configuration missing/);
});
