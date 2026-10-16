const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { preflight } = require('./mas-preflight.cjs');
const { verifyApp, verifyPackageSignature } = require('./verify-mas-signature.cjs');
const root = path.resolve(__dirname, '..');

if (require.main === module) {
  try {
    const receipt = preflight();
    const cli = path.join(root, 'node_modules/electron-builder/cli.js');
    if (!fs.existsSync(cli)) throw new Error('Install the frozen app dependencies with npm ci before MAS packaging');
    const started = Date.now();
    execFileSync(process.execPath, [cli, 'build', '--config', 'electron-builder.mas.cjs', '--mac', 'mas', '--universal', '--publish', 'never'], {
      cwd: root, stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'true' },
    });
    const output = path.join(root, 'dist');
    const files = [];
    const collect = (directory, depth) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink() && depth < 2 && !entry.name.endsWith('.app')) collect(file, depth + 1);
        else if (entry.isFile() && fs.statSync(file).mtimeMs >= started - 1000) files.push(file);
      }
    };
    collect(output, 0);
    const packages = files.filter(file => file.endsWith('.pkg'));
    if (packages.length !== 1) throw new Error('Expected exactly one newly signed universal MAS package');
    // Verify the final installer independently of intermediate signing hooks.
    const appPath = path.join(output, 'mas-universal', 'SINGULANCE.app');
    const verified = verifyApp(appPath);
    fs.writeFileSync(path.join(path.dirname(appPath), 'SINGULANCE-mas-signing-receipt.json'), JSON.stringify(verified, null, 2) + '\n');
    if (verified.buildNumber !== receipt.buildNumber || verified.version !== receipt.version) throw new Error('The signed app identity changed during packaging');
    verifyPackageSignature(packages[0], verified.teamId);
    const packageReceipt = { ...verified, packagePath: packages[0], packageSha256: createHash('sha256').update(fs.readFileSync(packages[0])).digest('hex'), status: 'signed-mas-package-not-uploaded' };
    fs.writeFileSync(path.join(output, 'SINGULANCE-testflight-package.json'), JSON.stringify(packageReceipt, null, 2) + '\n');
    console.log(`Prepared SINGULANCE ${receipt.version} (${receipt.buildNumber}) for App Store validation. This does not upload or approve a TestFlight build.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
