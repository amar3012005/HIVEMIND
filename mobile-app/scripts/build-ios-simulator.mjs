import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const simulator = process.argv[2];
const team = process.env.SINGULANCE_APPLE_TEAM_ID;
if (!/^[A-F0-9-]{36}$/i.test(simulator || '')) throw Error('Supply the booted simulator device ID.');
if (!/^[A-Z0-9]{10}$/.test(team || '')) throw Error('Set SINGULANCE_APPLE_TEAM_ID to the team selected in Xcode.');
const derived = resolve('ios/App/output/SimulatorDerivedData');
const run = (command, args) => {
  const result = spawnSync(command, args, {stdio: 'inherit'});
  if (result.status !== 0) throw Error(`${command} failed; no app installed.`);
};
run('node', ['scripts/check-native.mjs', '--packaged', '--ios']);
run('xcodebuild', ['-project', 'ios/App/App.xcodeproj', '-scheme', 'App', '-configuration', 'Debug', '-destination', `platform=iOS Simulator,id=${simulator}`, '-derivedDataPath', derived, `DEVELOPMENT_TEAM=${team}`, 'CODE_SIGNING_ALLOWED=YES', 'build']);
// Simulator Keychain authorization comes from the linked simulated entitlements.
// An unsigned build can compile and launch while all credential reads fail.
const entitlements = readFileSync(resolve(derived, 'Build/Intermediates.noindex/App.build/Debug-iphonesimulator/App.build/App.app-Simulated.xcent'), 'utf8');
if (!entitlements.includes(`${team}.com.singulancelabs.mobile`)) throw Error('Simulator identity is missing; Keychain access cannot be verified.');
console.log(`Signed simulator app: ${resolve(derived, 'Build/Products/Debug-iphonesimulator/App.app')}`);
console.log('Build only. Install and inspect the app before claiming authenticated acceptance.');
