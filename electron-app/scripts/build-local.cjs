const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This local preview target is for this Apple-silicon Mac');
execFileSync(process.execPath, [path.join(root, 'node_modules/electron-builder/cli.js'), 'build', '--config', 'electron-builder.local.cjs', '--mac', 'dir', '--arm64', '--publish', 'never'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
});
console.log('Prepared a separately identified local test app. It is not a TestFlight or notarized distribution build.');
