import test from 'node:test';
import assert from 'node:assert/strict';
import { CognitionLoop } from '../../src/memory/cognition-loop.js';

// Build a stub `this` whose prisma returns controlled rows. The exact-match
// fast path is forced to miss (findFirst → null) so we exercise the
// drift-tolerant normalized fallback (findMany).
function ctx(recentSynthTags) {
  return {
    prisma: {
      memory: {
        findFirst: async () => null,                       // no exact-tag hit
        findMany: async () => recentSynthTags.map((tags) => ({ tags })),
      },
    },
  };
}
const guard = (c, tag) => CognitionLoop.prototype._entityRecentlyDreamed.call(c, 'org', tag);

test('over-dream guard collapses entity-tag drift (alias spellings) to one key', async () => {
  // A recent dream tagged "Solvis GmbH"; a new cluster tagged the drifted slug.
  const c = ctx([['synthesis:canonical', 'entity:Solvis GmbH', 'topic:heat']]);
  assert.equal(await guard(c, 'entity:solvis-gmbh'), true, 'drifted alias must count as recently dreamed');
  assert.equal(await guard(c, 'entity:SOLVIS'), true, 'case + suffix drift must collapse too');
});

test('over-dream guard does NOT false-merge distinct entities', async () => {
  const c = ctx([['entity:Solvis']]);
  assert.equal(await guard(c, 'entity:Viessmann'), false, 'different entity must not be suppressed');
});

test('over-dream guard keeps entity vs person prefixes distinct', async () => {
  const c = ctx([['person:John Smith']]);
  assert.equal(await guard(c, 'entity:John Smith'), false, 'person: must not match entity:');
  assert.equal(await guard(c, 'person:john-smith'), true, 'same person under drift collapses');
});

test('over-dream guard only gates entity/person tags', async () => {
  const c = ctx([['topic:transformation']]);
  assert.equal(await guard(c, 'topic:transformation'), false, 'topic tags are not gated');
});

test('over-dream guard disabled when cooldownHours<=0', async () => {
  const c = ctx([['entity:Solvis']]);
  const res = await CognitionLoop.prototype._entityRecentlyDreamed.call(c, 'org', 'entity:solvis', 0);
  assert.equal(res, false, 'cooldownHours=0 disables the guard');
});
