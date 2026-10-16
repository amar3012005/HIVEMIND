import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const file = process.argv[2];
assert.ok(file, 'usage: node validate-release-manifest.mjs <manifest.json>');
const manifest = JSON.parse(await readFile(file, 'utf8'));

const allowed = new Set([
  'contractVersion', 'environment', 'changeClass', 'source', 'artifacts',
  'configurationRevision', 'featureFlag', 'rollback', 'canaries',
]);
for (const key of Object.keys(manifest)) assert.ok(allowed.has(key), `unsupported field: ${key}`);
assert.equal(manifest.contractVersion, 1, 'unsupported contractVersion');
assert.ok(['singulance_local', 'enigma', 'singulance_production'].includes(manifest.environment), 'invalid environment');
assert.ok(['worker', 'runner', 'core', 'hyperagents', 'tara'].includes(manifest.changeClass), 'invalid changeClass');
assert.deepEqual(Object.keys(manifest.source ?? {}).sort(), ['branch', 'commit', 'repository']);
assert.match(manifest.source.commit, /^[0-9a-f]{7,64}$/);
assert.ok(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0, 'at least one artifact is required');
for (const artifact of manifest.artifacts) {
  assert.deepEqual(Object.keys(artifact).sort(), ['identity', 'kind', 'previousIdentity']);
  assert.ok(['worker', 'container_image', 'database_migration', 'runtime'].includes(artifact.kind), 'invalid artifact kind');
  assert.ok(artifact.identity && artifact.previousIdentity, 'artifact identities are required');
}
assert.ok(manifest.configurationRevision, 'configurationRevision is required');
assert.ok(manifest.rollback, 'rollback is required');
assert.ok(Array.isArray(manifest.canaries) && manifest.canaries.length > 0, 'at least one canary is required');
if (manifest.featureFlag) {
  assert.deepEqual(Object.keys(manifest.featureFlag).sort(), ['key', 'target']);
  assert.ok(manifest.featureFlag.key, 'feature flag key is required');
  assert.ok(['legacy', 'harness'].includes(manifest.featureFlag.target), 'invalid feature flag target');
}

console.log(`release manifest: valid (${manifest.environment}/${manifest.changeClass})`);
