const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const APP_ID = 'com.singulancelabs.desktop';

function parsePlist(contents) {
  return JSON.parse(execFileSync('/usr/bin/python3', ['-I', '-c', 'import sys,plistlib,json,datetime,hashlib; data=plistlib.loads(sys.stdin.buffer.read()); json.dump(data,sys.stdout,default=lambda value: value.replace(tzinfo=datetime.timezone.utc).isoformat() if isinstance(value,datetime.datetime) else {"sha256":hashlib.sha256(value).hexdigest()} if isinstance(value,bytes) else None)'], { input: contents, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
}
function validateProfile(profile, teamId, appId = APP_ID, now = new Date()) {
  if (!/^[A-Z0-9]{10}$/.test(teamId || '')) throw new Error('Set SINGULANCE_APPLE_TEAM_ID to the app’s Apple team identifier');
  const entitlements = profile?.Entitlements || {};
  const identifier = entitlements['com.apple.application-identifier'] || entitlements['application-identifier'];
  if (!Array.isArray(profile.Platform) || !profile.Platform.some(value => ['OSX', 'macOS'].includes(value))) throw new Error('A macOS App Store provisioning profile is required; iOS profiles are not compatible');
  if (!profile.TeamIdentifier?.includes(teamId) || identifier !== `${teamId}.${appId}`) throw new Error('The provisioning profile must match this Apple team and com.singulancelabs.desktop exactly');
  if (profile.ProvisionsAllDevices || profile.ProvisionedDevices?.length || entitlements['get-task-allow'] === true || entitlements['com.apple.security.get-task-allow'] === true) throw new Error('Use App Store distribution provisioning, not development, ad-hoc or Developer ID provisioning');
  if (!profile.ExpirationDate || new Date(profile.ExpirationDate) <= now || !Number.isFinite(new Date(profile.ExpirationDate).getTime())) throw new Error('The macOS distribution provisioning profile has expired or lacks an expiry');
  return { appId, teamId, profileName: String(profile.Name || ''), expiresAt: new Date(profile.ExpirationDate).toISOString() };
}
function regularFile(file, description) {
  if (!file || !path.isAbsolute(file)) throw new Error(`${description} must be an explicit absolute path`);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${description} must be a regular file, not a symlink`);
  return stat;
}
function validateUploadEnvironment(env = process.env) {
  if (!/^[A-Z0-9]{8,20}$/.test(env.SINGULANCE_ASC_KEY_ID || '') || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(env.SINGULANCE_ASC_ISSUER_ID || '')) throw new Error('Set the App Store Connect API key ID and issuer ID without putting private key contents in arguments');
  const stat = regularFile(env.SINGULANCE_ASC_KEY_PATH, 'App Store Connect private-key path');
  if (stat.mode & 0o077) throw new Error('The App Store Connect private-key file must be readable only by its owner');
  return { keyId: env.SINGULANCE_ASC_KEY_ID, issuerId: env.SINGULANCE_ASC_ISSUER_ID, keyPath: env.SINGULANCE_ASC_KEY_PATH };
}
function verifyAppleTools() {
  if (process.platform !== 'darwin') throw new Error('MAS signing requires macOS');
  const version = execFileSync('/usr/bin/xcodebuild', ['-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const major = Number(version.match(/^Xcode\s+(\d+)/m)?.[1]);
  if (!Number.isFinite(major) || major < 27) throw new Error('Select Xcode 27 or newer with DEVELOPER_DIR for this versioned TestFlight upload pipeline');
  const tool = spawnSync('/usr/bin/xcrun', ['altool', '--help'], { encoding: 'utf8' });
  if (tool.status !== 0) throw new Error('The selected Xcode delivery tool is unavailable');
  const help = `${tool.stdout || ''}${tool.stderr || ''}`;
  for (const option of ['--validate-app', '--upload-package', '--api-key', '--api-issuer', '--p8-file-path']) if (!help.includes(option)) throw new Error(`The selected Apple delivery tool does not support ${option}`);
  return { xcode: version.split('\n')[0], uploadInterface: 'altool-27' };
}
function preflight(env = process.env) {
  if (process.platform !== 'darwin') throw new Error('MAS signing and packaging must run on a Mac with Xcode');
  verifyAppleTools();
  if (!/^[1-9]\d{0,8}$/.test(env.SINGULANCE_MAS_BUILD_NUMBER || '')) throw new Error('Set a new positive SINGULANCE_MAS_BUILD_NUMBER for this TestFlight build');
  if (env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') throw new Error('TestFlight signing cannot be disabled');
  regularFile(env.SINGULANCE_MAS_PROVISIONING_PROFILE, 'macOS distribution provisioning profile');
  const profile = parsePlist(execFileSync('/usr/bin/security', ['cms', '-D', '-i', env.SINGULANCE_MAS_PROVISIONING_PROFILE], { stdio: ['ignore', 'pipe', 'pipe'] }));
  const metadata = validateProfile(profile, env.SINGULANCE_APPLE_TEAM_ID);
  let identities = '';
  try { identities = execFileSync('/usr/bin/security', ['find-identity', '-v'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch {}
  const lines = identities.split('\n').filter(line => line.includes(`(${metadata.teamId})`));
  if (!env.CSC_LINK && !lines.some(line => /Apple Distribution:|3rd Party Mac Developer Application:/.test(line))) throw new Error('An Apple Distribution application certificate/private key is required; Apple Development and Developer ID cannot sign TestFlight builds');
  if (!env.CSC_INSTALLER_LINK && !lines.some(line => /3rd Party Mac Developer Installer:|Mac Installer Distribution:/.test(line))) throw new Error('A Mac Installer Distribution certificate/private key is required for the signed App Store package');
  const product = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (product.build.appId !== APP_ID || product.build.productName !== 'SINGULANCE') throw new Error('Unexpected official product identity');
  execFileSync('/usr/bin/xcrun', ['--find', 'codesign'], { stdio: ['ignore', 'pipe', 'pipe'] });
  return { ...metadata, version: product.version, buildNumber: env.SINGULANCE_MAS_BUILD_NUMBER };
}
if (require.main === module) {
  try { console.log(JSON.stringify(preflight(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { APP_ID, parsePlist, validateProfile, regularFile, validateUploadEnvironment, verifyAppleTools, preflight };
