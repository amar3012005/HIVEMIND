import test from 'node:test';
import assert from 'node:assert/strict';
import { ProfileDreamer } from '../../src/memory/profile-dreamer.js';

// 5 raw memories with known ids (>= PROFILE_DREAM_MIN_MEMORIES).
const RAW = ['m1', 'm2', 'm3', 'm4', 'm5'].map((id) => ({
  id, content: `memory ${id}`, title: '', createdAt: new Date('2026-06-01').toISOString(),
}));

function dreamer() {
  const d = new ProfileDreamer({ prisma: { memory: { findMany: async () => RAW } }, logger: { warn() {}, log() {} } });
  return d;
}

test('profile-dreamer drops fabricated-evidence, ungrounded, and low-confidence facts (poisoned-preference defense)', async () => {
  const d = dreamer();
  d._llmPersona = async () => [
    { category: 'static', key: 'role', value: 'CEO of Acme', evidence_memory_ids: ['m1'], confidence: 0.9 },          // KEEP
    { category: 'preference', key: 'pref:mondays', value: 'hates Mondays', evidence_memory_ids: ['FAKE'], confidence: 0.95 }, // DROP — evidence not in set
    { category: 'preference', key: 'pref:async', value: 'likes async', evidence_memory_ids: [], confidence: 0.9 },     // DROP — ungrounded
    { category: 'goal', key: 'goal:raise', value: 'raise a round', evidence_memory_ids: ['m2'], confidence: 0.3 },     // DROP — below floor
  ];
  const res = await d._dreamUser('org', 'user', false); // dry-run
  assert.equal(res.dryRun, true);
  const keys = res.proposals.map((p) => p.key);
  assert.deepEqual(keys, ['role'], 'only the grounded, confident fact survives');
  assert.deepEqual(res.proposals[0].evidence_memory_ids, ['m1']);
});

test('profile-dreamer keeps only evidence ids that exist in the member set', async () => {
  const d = dreamer();
  d._llmPersona = async () => [
    { category: 'static', key: 'company', value: 'Acme', evidence_memory_ids: ['m1', 'FAKE', 'm3'], confidence: 0.8 },
  ];
  const res = await d._dreamUser('org', 'user', false);
  assert.deepEqual(res.proposals[0].evidence_memory_ids, ['m1', 'm3'], 'fabricated id stripped, real ids kept');
});

test('profile-dreamer skips a member with too few memories', async () => {
  const d = new ProfileDreamer({ prisma: { memory: { findMany: async () => RAW.slice(0, 2) } }, logger: { warn() {} } });
  const res = await d._dreamUser('org', 'user', false);
  assert.equal(res.skipped, 'below_min_memories');
});

test('profile-dreamer dreamProfilesForOrg is inert unless PROFILE_DREAM_ENABLED', async () => {
  // Default env in CI has the flag unset → must no-op without touching prisma.
  const d = new ProfileDreamer({ prisma: { $queryRawUnsafe: async () => { throw new Error('should not query'); } } });
  const res = await d.dreamProfilesForOrg('org', { apply: true });
  assert.equal(res.skipped, true);
  assert.match(res.reason, /PROFILE_DREAM_ENABLED/);
});
