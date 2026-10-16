const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { regularFile, validateUploadEnvironment } = require('./mas-preflight.cjs');
const { verifyApp, verifyPackageSignature } = require('./verify-mas-signature.cjs');

if (require.main === module) {
  try {
    if (process.platform !== 'darwin') throw new Error('TestFlight upload requires the verified macOS signing environment');
    const packagePath = path.resolve(process.argv[2] || '');
    if (!process.argv[2] || !packagePath.endsWith('.pkg')) throw new Error('Pass the exact signed MAS .pkg path, not a DMG or ZIP');
    regularFile(packagePath, 'MAS distribution package');
    const receiptPath = path.resolve(__dirname, '../dist/SINGULANCE-testflight-package.json');
    const previous = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    if (previous.status !== 'signed-mas-package-not-uploaded' || previous.packagePath !== packagePath || previous.packageSha256 !== createHash('sha256').update(fs.readFileSync(packagePath)).digest('hex')) throw new Error('The selected package does not match the verified build receipt');
    const receipt = verifyApp(previous.appPath);
    if (previous.version !== receipt.version || previous.buildNumber !== receipt.buildNumber || previous.teamId !== receipt.teamId) throw new Error('The package signing receipt does not match the current verified app');
    verifyPackageSignature(packagePath, receipt.teamId);
    const key = validateUploadEnvironment();
    const auth = ['--api-key', key.keyId, '--api-issuer', key.issuerId, '--p8-file-path', key.keyPath, '--output-format', 'json'];
    execFileSync('/usr/bin/xcrun', ['altool', '--validate-app', packagePath, ...auth], { stdio: 'inherit' });
    execFileSync('/usr/bin/xcrun', ['altool', '--upload-package', packagePath, ...auth], { stdio: 'inherit' });
    console.log('Upload accepted by the Apple delivery tool. Wait for App Store Connect processing and any required beta review before claiming TestFlight availability.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
