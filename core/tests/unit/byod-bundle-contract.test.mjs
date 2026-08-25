import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const backup = fs.readFileSync(new URL('../../../byod/backup.sh', import.meta.url), 'utf8');
const doctor = fs.readFileSync(new URL('../../../byod/doctor.sh', import.meta.url), 'utf8');
const publisher = fs.readFileSync(new URL('../../../scripts/publish-byod.sh', import.meta.url), 'utf8');
const checker = fs.readFileSync(new URL('../../../scripts/check-byod-sync.sh', import.meta.url), 'utf8');
const staging = fs.readFileSync(new URL('../../../scripts/stage-byod-bundle.sh', import.meta.url), 'utf8');
const restore = fs.readFileSync(new URL('../../../byod/restore-drill.sh', import.meta.url), 'utf8');
const agentWorkflow = fs.readFileSync(
  new URL('../../../.github/workflows/publish-memory-box-agent.yml', import.meta.url),
  'utf8',
);

test('standalone BYOD publisher includes the storage manifest verifier', () => {
  assert.match(publisher, /stage-byod-bundle\.sh/);
  assert.match(checker, /stage-byod-bundle\.sh/);
  assert.match(staging, /storage-manifest\.mjs/);
  assert.match(staging, /storage-restore-drill\.sh/);
  assert.match(backup, /MANIFEST_TOOL="\$HERE\/storage-manifest\.mjs"/);
  assert.match(doctor, /MANIFEST_TOOL="\$HERE\/storage-manifest\.mjs"/);
});

test('shared staging builds the complete bundle and removes unexpected files', (t) => {
  const repositoryRoot = fs.realpathSync(new URL('../../..', import.meta.url));
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'byod-bundle-'));
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  fs.writeFileSync(path.join(destination, 'unexpected.txt'), 'drift');

  execFileSync(path.join(repositoryRoot, 'scripts/stage-byod-bundle.sh'), [repositoryRoot, destination]);

  assert.equal(fs.existsSync(path.join(destination, 'unexpected.txt')), false);
  assert.equal(
    fs.readFileSync(path.join(destination, 'storage-manifest.mjs'), 'utf8'),
    fs.readFileSync(path.join(repositoryRoot, 'scripts/storage-manifest.mjs'), 'utf8'),
  );
  assert.equal(
    fs.readFileSync(path.join(destination, 'storage-restore-drill.sh'), 'utf8'),
    fs.readFileSync(path.join(repositoryRoot, 'scripts/storage-restore-drill.sh'), 'utf8'),
  );
  assert.ok(fs.statSync(path.join(destination, 'storage-manifest.mjs')).mode & 0o100);
  assert.ok(fs.statSync(path.join(destination, 'storage-restore-drill.sh')).mode & 0o100);
});

test('standalone BYOD restore wrapper resolves generated and monorepo layouts', () => {
  assert.match(restore, /DRILL="\$HERE\/storage-restore-drill\.sh"/);
  assert.match(restore, /\.\.\/scripts\/storage-restore-drill\.sh/);
  assert.match(restore, /--mode byod/);
});

test('monorepo BYOD commands retain repository-helper compatibility', () => {
  assert.match(backup, /\.\.\/scripts\/storage-manifest\.mjs/);
  assert.match(doctor, /\.\.\/scripts\/storage-manifest\.mjs/);
});

test('agent publishing emits only a multi-architecture immutable candidate', () => {
  assert.match(agentWorkflow, /platforms: linux\/amd64,linux\/arm64/);
  assert.match(agentWorkflow, /tags: \$\{\{ env\.IMAGE \}\}:sha-\$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(agentWorkflow, /:latest/);
  assert.doesNotMatch(agentWorkflow, /packages\/container\/.*visibility/);
  assert.match(agentWorkflow, /docker logout ghcr\.io/);
  assert.match(agentWorkflow, /imagetools inspect/);
  assert.match(agentWorkflow, /actions\/upload-artifact@v4/);
});
