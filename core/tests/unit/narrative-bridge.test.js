import test from 'node:test';
import assert from 'node:assert/strict';
import { CognitionLoop } from '../../src/memory/cognition-loop.js';

// Build a cluster {tag, members} where every member carries the given entity tags.
const cluster = (tag, entityTags, n = 2) => ({
  tag,
  members: Array.from({ length: n }, (_, i) => ({
    id: `${tag}-m${i}`, userId: 'u1', project: null,
    content: `content for ${tag} ${i}`, title: tag,
    createdAt: new Date('2026-06-01').toISOString(),
    tags: [tag, ...entityTags],
  })),
  centroid: tag,
});

// Stub `this` for _narrativeBridgePass: no existing synth, no cooldown, LLM
// returns a usable narrative, writes captured.
function ctx() {
  const writeCalls = [];
  return {
    writeCalls,
    prisma: { memory: { findFirst: async () => null } },
    _onCooldown: async () => false,
    _isRestatement: () => false,
    _llmNarrativeBridge: async (hubKey, clusters) => ({
      narrative: `Across ${clusters.length} clusters, ${hubKey} ties them together into one emergent thought with enough detail.`,
      bridge_type: 'temporal_arc',
      supporting_memory_ids: clusters.flatMap((c) => c.members.map((m) => m.id)).slice(0, 4),
      confidence: 0.8,
      actionable_next_step: 'do the thing',
    }),
    _writeSynthMemory: async (args) => { writeCalls.push(args); return { id: `synth-${writeCalls.length}`, tags: ['synthesis:bridge', args.tag] }; },
    clusterIndex: { upsertOnSynthesis: async () => {} },
    logger: { log() {}, warn() {} },
  };
}
const run = (c, tagList, crossProject = false) => CognitionLoop.prototype._narrativeBridgePass.call(c, 'org', tagList, crossProject);

// cluster whose members live in a specific project (for cross-project tests).
const projectCluster = (tag, entityTags, project, n = 2) => ({
  tag,
  members: Array.from({ length: n }, (_, i) => ({
    id: `${tag}-m${i}`, userId: 'u1', project,
    content: `content for ${tag} ${i}`, title: tag,
    createdAt: new Date('2026-06-01').toISOString(),
    tags: [tag, ...entityTags],
  })),
  centroid: tag,
});

test('narrative bridge fires for a hub entity spanning ≥3 clusters (drift-collapsed)', async () => {
  const c = ctx();
  // Same real entity under 3 drifted spellings across 3 separate topic clusters.
  const tagList = [
    cluster('topic:visa', ['entity:Acme Inc']),
    cluster('topic:acquisition', ['entity:acme']),
    cluster('topic:github-stars', ['entity:ACME']),
    cluster('topic:unrelated', ['entity:Globex']), // only 1 cluster → ignored
  ];
  const writes = await run(c, tagList);
  assert.equal(writes, 1, 'exactly one narrative for the 3-cluster hub');
  const call = c.writeCalls[0];
  assert.equal(call.extraMeta.hub_entity, 'entity:acme', 'hub key normalized (drift collapsed)');
  assert.equal(call.extraMeta.narrative, true);
  assert.deepEqual(call.extraMeta.cluster_tags, ['topic:acquisition', 'topic:github-stars', 'topic:visa']);
  assert.equal(call.sourceType, 'synthesis-bridge');
});

test('narrative bridge does NOT fire for a hub spanning only 2 clusters', async () => {
  const c = ctx();
  const tagList = [
    cluster('topic:a', ['entity:Acme']),
    cluster('topic:b', ['entity:acme']),
  ];
  const writes = await run(c, tagList);
  assert.equal(writes, 0, 'two clusters is below NARRATIVE_MIN_CLUSTERS');
});

test('narrative bridge skips on confidence below floor', async () => {
  const c = ctx();
  c._llmNarrativeBridge = async () => ({ narrative: 'x'.repeat(40), confidence: 0.1, bridge_type: 'causal' });
  const tagList = [
    cluster('topic:a', ['entity:Acme']),
    cluster('topic:b', ['entity:acme']),
    cluster('topic:c', ['entity:ACME']),
  ];
  const writes = await run(c, tagList);
  assert.equal(writes, 0, 'low-confidence narrative dropped');
});

test('narrative bridge SKIPS a hub spanning >1 project when cross-project is OFF', async () => {
  const c = ctx();
  const tagList = [
    projectCluster('topic:a', ['entity:Acme'], 'proj-1'),
    projectCluster('topic:b', ['entity:acme'], 'proj-1'),
    projectCluster('topic:c', ['entity:ACME'], 'proj-2'), // different project → spans
  ];
  const writes = await run(c, tagList, false); // cross-project OFF
  assert.equal(writes, 0, 'cross-project narrative blocked when toggle off');
});

test('narrative bridge ALLOWS a cross-project hub when cross-project is ON', async () => {
  const c = ctx();
  const tagList = [
    projectCluster('topic:a', ['entity:Acme'], 'proj-1'),
    projectCluster('topic:b', ['entity:acme'], 'proj-1'),
    projectCluster('topic:c', ['entity:ACME'], 'proj-2'),
  ];
  const writes = await run(c, tagList, true); // cross-project ON
  assert.equal(writes, 1, 'cross-project narrative allowed when toggle on');
});
