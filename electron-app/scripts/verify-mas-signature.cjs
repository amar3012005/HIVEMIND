const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { APP_ID, parsePlist, validateProfile, regularFile } = require('./mas-preflight.cjs');

function entitlements(bundle) {
  return parsePlist(execFileSync('/usr/bin/codesign', ['-d', '--entitlements', ':-', bundle], { stdio: ['ignore', 'pipe', 'pipe'] }));
}
function verifyApp(appPath, env = process.env) {
  if (process.platform !== 'darwin') throw new Error('MAS signature verification requires macOS');
  const info = parsePlist(fs.readFileSync(path.join(appPath, 'Contents/Info.plist')));
  if (info.CFBundleIdentifier !== APP_ID || info.CFBundleName !== 'SINGULANCE' || info.ElectronTeamID !== env.SINGULANCE_APPLE_TEAM_ID) throw new Error('Unexpected MAS application identity or signing team');
  if (info.CFBundleVersion !== env.SINGULANCE_MAS_BUILD_NUMBER) throw new Error('MAS build number does not match the requested TestFlight build');
  if (!info.NSHumanReadableCopyright) throw new Error('The uploaded app must declare its copyright');
  const profile = parsePlist(execFileSync('/usr/bin/security', ['cms', '-D', '-i', path.join(appPath, 'Contents/embedded.provisionprofile')], { stdio: ['ignore', 'pipe', 'pipe'] }));
  const metadata = validateProfile(profile, env.SINGULANCE_APPLE_TEAM_ID);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  const result = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', appPath], { encoding: 'utf8' });
  const authority = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.status !== 0 || !/^Authority=(?:Apple Distribution:|3rd Party Mac Developer Application:)/m.test(authority) || !authority.includes(`TeamIdentifier=${metadata.teamId}`) || /adhoc/i.test(authority)) throw new Error('An App Store distribution signature is required; development, ad-hoc and Developer ID builds are not TestFlight artifacts');
  const certificateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'singulance-mas-certificate-'));
  try {
    const prefix = path.join(certificateDirectory, 'distribution-');
    execFileSync('/usr/bin/codesign', ['-d', '--extract-certificates', prefix, appPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    const fingerprint = createHash('sha256').update(fs.readFileSync(`${prefix}0`)).digest('hex');
    if (!Array.isArray(profile.DeveloperCertificates) || !profile.DeveloperCertificates.some(certificate => certificate?.sha256 === fingerprint)) throw new Error('The application signing certificate is not included in this provisioning profile');
  } finally { fs.rmSync(certificateDirectory, { recursive: true, force: true }); }
  const checkEntitlements = (bundle, inherited) => {
    const value = entitlements(bundle);
    if (value['com.apple.security.app-sandbox'] !== true || inherited && value['com.apple.security.inherit'] !== true || value['com.apple.security.cs.disable-library-validation'] === true) throw new Error('MAS parent/child sandbox entitlements are invalid');
  };
  checkEntitlements(appPath, false);
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const nested = path.join(directory, entry.name);
      if (entry.name.endsWith('.app')) checkEntitlements(nested, true);
      walk(nested);
    }
  };
  walk(path.join(appPath, 'Contents'));
  const executable = path.join(appPath, 'Contents/MacOS', info.CFBundleExecutable);
  const architectures = execFileSync('/usr/bin/lipo', ['-archs', executable], { encoding: 'utf8' });
  if (!architectures.includes('arm64') || !architectures.includes('x86_64')) throw new Error('The TestFlight package must include both Apple silicon and Intel architectures');
  const attributes = execFileSync('/usr/bin/xattr', ['-r', appPath], { encoding: 'utf8' });
  if (attributes.includes('com.apple.quarantine')) throw new Error('App Store uploads must not contain quarantined files');
  const archive = path.join(appPath, 'Contents/Resources/app.asar');
  regularFile(archive, 'Packaged application archive');
  const asar = require('@electron/asar');
  const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  if (packaged.main !== 'src/main.js' || packaged.singulanceReleaseChannel === 'local-test') throw new Error('A local test build cannot be promoted as a TestFlight artifact');
  const entries = asar.listPackage(archive);
  if (!entries.some(name => name.endsWith('/src/in-app-browser.js')) || !entries.some(name => name.endsWith('/src/electron-browser-page.js'))) throw new Error('The bundled MAS browser adapter is missing');
  if (entries.some(name => /\/src\/(?:managed-agent-browser\.js|agent-browser-mcp\.mjs|notch[^/]*)$|\/node_modules\/(?:electron-updater|playwright(?:-core)?|@modelcontextprotocol)(?:\/|$)/.test(name))) throw new Error('The MAS archive contains an external runtime installer, legacy updater or browser worker');
  return { ...metadata, version: info.CFBundleShortVersionString, buildNumber: info.CFBundleVersion, architectures: architectures.trim().split(/\s+/), appPath, status: 'signed-mas-app-verified-not-uploaded' };
}
function verifyPackageSignature(packagePath, teamId) {
  regularFile(packagePath, 'MAS distribution package');
  const signature = execFileSync('/usr/sbin/pkgutil', ['--check-signature', packagePath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' } });
  if (!/(?:3rd Party Mac Developer Installer|Mac Installer Distribution):/.test(signature) || !signature.includes(`(${teamId})`) || !/Status:\s+signed by (?:a certificate trusted by (?:Mac OS X|macOS)|a developer certificate issued by Apple for distribution)/.test(signature)) throw new Error('The App Store installer package must have a trusted Mac distribution signature from the expected team');
}
exports.verifyApp = verifyApp;
exports.verifyPackageSignature = verifyPackageSignature;
exports.default = async context => {
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const receipt = verifyApp(appPath);
  fs.writeFileSync(path.join(context.appOutDir, 'SINGULANCE-mas-signing-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log('Verified App Store distribution identity, universal architectures, sandbox inheritance and bundled browser. Apple processing has not started.');
};
