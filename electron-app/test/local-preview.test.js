const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

test('local preview has a separate identity, profile namespace and protocol without weakening MAS signing', () => {
  const local = require('../electron-builder.local.cjs'); const mas = require('../electron-builder.mas.cjs');
  assert.equal(local.appId, 'com.singulancelabs.desktop.localtest');
  assert.equal(local.productName, 'SINGULANCE Local Test');
  assert.equal(local.extraMetadata.singulanceReleaseChannel, 'local-test');
  assert.equal(local.extraMetadata.main, 'src/local-preview-main.js');
  assert.deepEqual(local.protocols[0].schemes, ['singulance-local-test']);
  assert.equal(local.publish, null); assert.equal(local.afterSign, null);
  assert.equal(mas.forceCodeSigning, true); assert.equal(mas.mas.type, 'distribution');
  assert.ok(mas.files.includes('!src/local-preview-main.js'));
  const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
  assert.match(main, /app\.setPath\('userData', directory\)/);
  assert.match(main, /path\.join\(app\.getPath\('appData'\), 'SINGULANCE Local Test'\)/);
  assert.match(main, /isLocalTest \? 'singulance-local-test' : 'singulance'/);
});
test('a local app test cannot be identified as a signed TestFlight artifact', () => {
  const source = fs.readFileSync(path.join(root, 'scripts/verify-mas-signature.cjs'), 'utf8');
  assert.match(source, /packaged\.singulanceReleaseChannel === 'local-test'/);
  assert.match(source, /local test build cannot be promoted as a TestFlight artifact/);
});
