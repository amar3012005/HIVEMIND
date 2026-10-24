import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const hetzner = fs.readFileSync(new URL('../../../.github/workflows/singulance-production-hetzner.yml', import.meta.url), 'utf8');
const deploy = fs.readFileSync(new URL('../../../.github/workflows/deploy.yml', import.meta.url), 'utf8');

function runBlocks(source) {
  // Every `run: |` and `script: |` block body, up to the next less-indented key.
  const blocks = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(\s*)(?:- )?(?:run|script): \|\s*$/.exec(lines[i]);
    if (!match) continue;
    const indent = match[1].length;
    const body = [];
    for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || lines[j].search(/\S/) > indent); j += 1) body.push(lines[j]);
    blocks.push(body.join('\n'));
  }
  return blocks;
}

test('production Hetzner dispatch inputs never reach shell through expression interpolation', () => {
  const blocks = runBlocks(hetzner);
  assert.ok(blocks.length >= 3);
  for (const block of blocks) assert.doesNotMatch(block, /\$\{\{/);
});

test('production Hetzner dispatch inputs are allowlisted and the job is environment-gated', () => {
  assert.match(hetzner, /environment: singulance-production/);
  assert.match(hetzner, /SERVICE_RE='\^\(core\|control-plane\|control\|employees\|/);
  assert.match(hetzner, /IMAGE_RE='\^\[a-z0-9\]\[a-z0-9\._\/:-\]\*@sha256:\[0-9a-f\]\{64\}\$'/);
  assert.match(hetzner, /INPUT_SERVICES: \$\{\{ github\.event\.inputs\.services \}\}/);
  assert.match(hetzner, /IFS=',' read -r -a services <<< "\$RELEASE_SERVICES"/);
});

test('manual production deploys run only from main', () => {
  assert.match(deploy, /github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main' && github\.event\.inputs\.environment == 'production'/);
});
