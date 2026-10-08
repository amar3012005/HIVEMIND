import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
if (process.env.SINGULANCE_ANDROID_KEYSTORE) throw Error('Preparation is unsigned only; use android:release for signed release.');
for (const [cmd, args] of [['node', ['scripts/check-native.mjs', '--packaged']], ['npx', ['cap', 'sync', 'android']], ['android/gradlew', ['-p', 'android', '--no-daemon', ':app:bundleRelease']]]) {
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
await writeFile('android/app/build/outputs/bundle/release/PREPARATION_ONLY.txt', 'UNSIGNED COMPILATION ARTIFACT. Not store ready. Run android:release with platform-specific verified evidence and real signing credentials before submission.\n');
console.log('Unsigned AAB prepared. Device evidence, privacy review and signed release remain required.');
