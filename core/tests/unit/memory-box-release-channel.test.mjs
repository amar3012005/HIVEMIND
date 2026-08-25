import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import worker from '../../../byod/release-channel/worker.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const objects = new Map([
  ['bootstrap/memory-box', '#!/bin/sh\n'],
  ['bootstrap/release.pub', 'PUBLIC KEY'],
  ['channels/stable.json', JSON.stringify({ version: 1, release: 'agent-abcdef1' })],
  ['releases/agent-abcdef1/release.json', JSON.stringify({ version: 2 })],
  ['releases/agent-abcdef1/release.sig', 'signature'],
  ['releases/agent-abcdef1/bundle.tar.gz', 'bundle'],
]);
const env = { RELEASES: { get: async (key) => objects.has(key) ? {
  body: objects.get(key), httpEtag: `"${key}"`, writeHttpMetadata() {}, json: async () => JSON.parse(objects.get(key)),
} : null } };

test('release channel resolves stable pointers and immutable assets without listing storage', async () => {
  const stable = await worker.fetch(new Request('https://get.singulancelabs.com/memory-box/releases/stable/release.json'), env);
  assert.equal(stable.status, 200);
  assert.deepEqual(await stable.json(), { version: 2 });
  assert.equal(stable.headers.get('cache-control'), 'no-cache, no-store, must-revalidate');

  const immutable = await worker.fetch(new Request('https://get.singulancelabs.com/memory-box/releases/agent-abcdef1/bundle.tar.gz'), env);
  assert.equal(immutable.status, 200);
  assert.match(immutable.headers.get('cache-control'), /immutable/);
  assert.equal(await immutable.text(), 'bundle');

  assert.equal((await worker.fetch(new Request('https://get.singulancelabs.com/memory-box/releases'), env)).status, 404);
  assert.equal((await worker.fetch(new Request('https://get.singulancelabs.com/memory-box', { method: 'POST' }), env)).status, 405);
});

test('release promotion requires recovery evidence and renders the bootstrap key pin', () => {
  const publisher = fs.readFileSync(path.join(ROOT, 'scripts/publish-memory-box-release.sh'), 'utf8');
  const installer = fs.readFileSync(path.join(ROOT, 'byod/install.sh'), 'utf8');
  assert.match(publisher, /BYOD_RESTORE_DRILL_RECEIPT/);
  assert.match(publisher, /BYOD_CANARY_RECEIPT/);
  assert.match(publisher, /DOCKER_CONFIG="\$ANON_DOCKER_CONFIG" docker pull/);
  assert.match(publisher, /__HIVEMIND_RELEASE_PUBLIC_KEY_SHA256__/);
  assert.match(installer, /PINNED_PUBLIC_KEY_SHA256/);
  assert.match(installer, /fingerprint!==process\.argv\[4\]/);
  assert.ok(publisher.lastIndexOf('put "channels/$CHANNEL.json"') > publisher.lastIndexOf('put "bootstrap/memory-box"'));
});
