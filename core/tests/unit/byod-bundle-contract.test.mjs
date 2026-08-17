import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const backup = fs.readFileSync(new URL('../../../byod/backup.sh', import.meta.url), 'utf8');
const doctor = fs.readFileSync(new URL('../../../byod/doctor.sh', import.meta.url), 'utf8');
const publisher = fs.readFileSync(new URL('../../../scripts/publish-byod.sh', import.meta.url), 'utf8');

test('standalone BYOD publisher includes the storage manifest verifier', () => {
  assert.match(publisher, /storage-manifest\.mjs.*WT\/storage-manifest\.mjs/);
  assert.match(backup, /MANIFEST_TOOL="\$HERE\/storage-manifest\.mjs"/);
  assert.match(doctor, /MANIFEST_TOOL="\$HERE\/storage-manifest\.mjs"/);
});

test('monorepo BYOD commands retain repository-helper compatibility', () => {
  assert.match(backup, /\.\.\/scripts\/storage-manifest\.mjs/);
  assert.match(doctor, /\.\.\/scripts\/storage-manifest\.mjs/);
});
