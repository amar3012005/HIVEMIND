const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');

test('official app packaging retains SINGULANCE identity and excludes upstream preview helpers', () => {
  const product = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(product.build.appId, 'com.singulancelabs.desktop');
  assert.equal(product.build.productName, 'SINGULANCE');
  assert.equal(product.build.dmg.title, 'SINGULANCE');
  assert.doesNotMatch(JSON.stringify(product.build.extraResources ?? []), /OpenClicky|Hermes|BrandedNotchSource/i);
});
test('app icon and splash use the supplied current SINGULANCE orbit brand', () => {
  const icon = fs.readFileSync(path.join(root, 'assets/icon.png'));
  assert.equal(createHash('sha256').update(icon).digest('hex'), '033984a1c9fed721defbf2fa6ea8b3d708abd2e3038e26d0ebb06599b4659ac8');
  assert.match(fs.readFileSync(path.join(root, 'src/splash.html'), 'utf8'), /src="\.\.\/assets\/icon\.png" alt="SINGULANCE orbit logo"/);
});
test('shipped app UI and browser setup contain only SINGULANCE or HIVEMIND product labels', () => {
  const files = fs.readdirSync(path.join(root, 'src')).filter(name => /\.(html|js|mjs)$/.test(name));
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, 'src', file), 'utf8');
    assert.doesNotMatch(text, /OpenClicky|Hermes Desktop|HermesDesktop/, file);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'src/main.js'), 'utf8'), /Open Dot|Hey.?Clicky|OpenClicky/);
  const preload = fs.readFileSync(path.join(root, 'src/preload.js'), 'utf8');
  assert.match(preload, /frames\[0\]\.title = 'HIVEMIND workspace'/);
  const setup = fs.readFileSync(path.join(root, 'src/agent-browser.html'), 'utf8');
  assert.match(setup, /Choose Agent Browser/);
  assert.doesNotMatch(setup, /Choose Agent Tools/);
});
