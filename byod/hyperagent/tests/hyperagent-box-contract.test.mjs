import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('BYOD Harness reuses the existing image and unlocks every shipped mode', () => {
  const dockerfile = read('Dockerfile.hyperagent');
  const compose = read('docker-compose.hyperagent.yml');
  const readme = read('README.md');
  const ensure = read('ensure-org-fs.mjs');
  assert.match(dockerfile, /FROM \$\{HARNESS_BASE\}/);
  assert.match(dockerfile, /hivemind-chat, hyperagents, hivemind, standard, ptc, cordis, minimal/);
  assert.match(dockerfile, /includeUserRoot: false/);
  assert.match(dockerfile, /cloudflare-openrouter still in patch/);
  assert.match(dockerfile, /force host settings persistence/);
  assert.match(dockerfile, /force isLoopback/);
  assert.match(read('brand-rewrite.mjs'), /SINGULANCE/);
  assert.match(read('brand/singulance.css'), /Space Grotesk/);
  assert.match(read('virtual-workspace-box.js'), /org-sandbox/);
  assert.doesNotMatch(dockerfile, /singulance-main/);
  assert.match(compose, /container_name: hm-byod-harness/);
  assert.match(ensure, /users', userId, 'workspace'/);
  assert.match(readme, /Connect to HIVEMIND/);
  assert.match(readme, /Not Da-vinci/);
});
