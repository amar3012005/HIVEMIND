import { spawnSync } from 'node:child_process';
if (process.platform !== 'darwin') throw Error('iOS archive requires macOS with Xcode 26 or newer.');
const xcode = spawnSync('xcodebuild', ['-version'], { encoding: 'utf8' });
const major = Number(xcode.stdout?.match(/Xcode (\d+)/)?.[1]);
if (xcode.status !== 0 || major < 26) throw Error('Xcode 26 or newer is required.');
if (!process.env.SINGULANCE_APPLE_TEAM_ID) throw Error('Set your Apple Developer team ID; signing is not fabricated.');
for (const [cmd, args] of [['node', ['scripts/check-native.mjs', '--release', '--ios']], ['npx', ['cap', 'sync', 'ios']], ['xcodebuild', ['-project', 'ios/App/App.xcodeproj', '-scheme', 'App', '-configuration', 'Release', '-destination', 'generic/platform=iOS', '-archivePath', 'ios/App/output/SINGULANCE.xcarchive', `DEVELOPMENT_TEAM=${process.env.SINGULANCE_APPLE_TEAM_ID}`, 'archive']]]) {
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
