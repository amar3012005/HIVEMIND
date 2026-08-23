import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchEntitiesLexical,
  hop0QueryTokens,
  remoteQueryEntityRegistry,
  resolveEntityRecallCandidates,
  HOP0_MAX_ENTITIES,
  HOP0_MAX_CANDIDATES,
} from '../../src/memory/entity-hop0.js';

test('remote tenant tag registry extracts bounded entity phrases without an LLM', () => {
  const conversational = remoteQueryEntityRegistry('What do you know about Kruti?');
  assert.ok(conversational.some((entry) => entry.slug === 'kruti'));
  assert.ok(conversational.length <= 24);

  const multiword = remoteQueryEntityRegistry('Tell me about Amar Sai Gadde');
  assert.ok(multiword.some((entry) => entry.slug === 'amar-sai-gadde'));

  const lowercase = remoteQueryEntityRegistry('tell me about kruti');
  assert.ok(lowercase.some((entry) => entry.slug === 'kruti'));
});

const REGISTRY = [
  { id: 'e-davinci', canonicalName: 'Davinci AI', aliases: ['DaVinci'], mentionCount: 36 },
  { id: 'e-solvis', canonicalName: 'SOLVIS', aliases: ['Solvis GmbH'], mentionCount: 103 },
  { id: 'e-lea', canonicalName: 'Solvis Lea', aliases: [], mentionCount: 12 },
  { id: 'e-hetzner', canonicalName: 'Hetzner', aliases: [], mentionCount: 31 },
  { id: 'e-bnb', canonicalName: 'B&B', aliases: ['B&B Markenagentur'], mentionCount: 32 },
];

// ── matcher (pure) ──────────────────────────────────────────────────────────

test('exact canonical name matches at highest score', () => {
  const m = matchEntitiesLexical(REGISTRY, 'what do we know about Davinci AI?');
  assert.equal(m[0].id, 'e-davinci');
  assert.equal(m[0].matchScore, 1.0);
});

test('exact alias matches at alias score', () => {
  const m = matchEntitiesLexical(REGISTRY, 'notes from Solvis GmbH');
  const solvis = m.find((x) => x.id === 'e-solvis');
  assert.ok(solvis);
  assert.ok(solvis.matchScore >= 0.9);
});

test('multi-word entity matches inside a longer question', () => {
  const m = matchEntitiesLexical(REGISTRY, 'when did we last talk to Solvis Lea about pricing');
  const lea = m.find((x) => x.id === 'e-lea');
  assert.ok(lea, 'multi-word "Solvis Lea" must exact-match via n-gram');
  assert.equal(lea.matchScore, 1.0);
  // "SOLVIS" also legitimately exact-matches (1-gram) — both must surface.
  assert.ok(m.find((x) => x.id === 'e-solvis'));
});

test('prefix query (>=3 chars) finds the entity', () => {
  const m = matchEntitiesLexical(REGISTRY, 'anything on hetz servers?');
  const h = m.find((x) => x.id === 'e-hetzner');
  assert.ok(h, 'prefix "hetz" should match Hetzner');
  assert.ok(h.matchScore >= 0.55);
});

test('five-char partial matches as weak fallback', () => {
  const m = matchEntitiesLexical(REGISTRY, 'the davinc report');
  const d = m.find((x) => x.id === 'e-davinci');
  assert.ok(d);
});

test('two-char tokens are never loose-matched (AI/IT guard)', () => {
  // "AI" alone must not fan out to every *-ai entity via token matching.
  const tokens = hop0QueryTokens('AI it am');
  assert.deepEqual(tokens, []);
  const m = matchEntitiesLexical(REGISTRY, 'ai');
  assert.equal(m.length, 0);
});

test('entity cap enforced at 12', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    id: `e${i}`, canonicalName: `acme unit ${i}`, aliases: [], mentionCount: i,
  }));
  const m = matchEntitiesLexical(many, 'acme');
  assert.ok(m.length <= HOP0_MAX_ENTITIES);
});

test('query token cap enforced at 8', () => {
  const tokens = hop0QueryTokens('one two three four five six seven eight nine ten eleven');
  assert.ok(tokens.length <= 8);
});

// ── resolver (fake store) ───────────────────────────────────────────────────

function makeMemory(id, over = {}) {
  return {
    id,
    org_id: 'org-1',
    user_id: 'user-1',
    scope: 'personal',
    tags: ['entity:davinci-ai'],
    is_latest: true,
    created_at: new Date().toISOString(),
    content: `memory ${id}`,
    ...over,
  };
}

function makeStore({ entities = REGISTRY, memoryIds = ['m1', 'm2'], links = [], canonical = [], memories = null } = {}) {
  const mems = memories || new Map(memoryIds.map((id) => [id, makeMemory(id)]));
  const calls = { entityWhere: null, memoryWhere: null };
  return {
    calls,
    client: {
      entity: {
        findMany: async (args) => { calls.entityWhere = args.where; return entities; },
      },
      canonicalEntity: canonical.length ? { findMany: async () => canonical } : undefined,
      memoryEntityLink: links.length ? { findMany: async () => links } : undefined,
      memory: {
        findMany: async (args) => { calls.memoryWhere = args.where; return memoryIds.map((id) => ({ id })); },
      },
    },
    getMemories: async (ids) => new Map(ids.filter((id) => mems.has(id)).map((id) => [id, mems.get(id)])),
  };
}

test('exact entity query returns linked memories as additive candidates', async () => {
  const store = makeStore();
  const r = await resolveEntityRecallCandidates({ store, query: 'Davinci AI', org_id: 'org-1', user_id: 'user-1' });
  assert.equal(r.candidates.length, 2);
  assert.equal(r.candidates[0]._entity_lexical, true);
  assert.equal(r.candidates[0]._entity_match_score, 1.0);
  assert.equal(r.candidates[0].score, 0, 'candidates enter fusion unscored (additive)');
  assert.ok(r.matchedEntities.length >= 1);
});

test('registry query is organization-scoped', async () => {
  const store = makeStore();
  await resolveEntityRecallCandidates({ store, query: 'Davinci AI', org_id: 'org-1', user_id: 'user-1' });
  assert.equal(store.calls.entityWhere.orgId, 'org-1');
  assert.equal(store.calls.memoryWhere.orgId, 'org-1');
});

test('cross-org memories never leak even if linked', async () => {
  const mems = new Map([
    ['m1', makeMemory('m1')],
    ['m2', makeMemory('m2', { org_id: 'org-EVIL' })],
  ]);
  const store = makeStore({ memoryIds: ['m1', 'm2'], memories: mems });
  const r = await resolveEntityRecallCandidates({ store, query: 'Davinci AI', org_id: 'org-1', user_id: 'user-1' });
  assert.deepEqual(r.candidates.map((c) => c.memory.id), ['m1']);
});

test('access_context excludes other-user personal + inaccessible project memories', async () => {
  const mems = new Map([
    ['m1', makeMemory('m1')],
    ['m2', makeMemory('m2', { user_id: 'someone-else' })],
    ['m3', makeMemory('m3', { scope: 'project', project_ids: ['p-locked'] })],
  ]);
  const store = makeStore({ memoryIds: ['m1', 'm2', 'm3'], memories: mems });
  const r = await resolveEntityRecallCandidates({
    store, query: 'Davinci AI', org_id: 'org-1', user_id: 'user-1',
    access_context: { orgRole: 'member', projectIds: [], teamIds: [] },
  });
  assert.deepEqual(r.candidates.map((c) => c.memory.id), ['m1']);
});

test('superseded memories excluded under default is_latest', async () => {
  const mems = new Map([
    ['m1', makeMemory('m1')],
    ['m2', makeMemory('m2', { is_latest: false })],
  ]);
  const store = makeStore({ memoryIds: ['m1', 'm2'], memories: mems });
  const r = await resolveEntityRecallCandidates({ store, query: 'Davinci AI', org_id: 'org-1', user_id: 'user-1', is_latest: true });
  assert.deepEqual(r.candidates.map((c) => c.memory.id), ['m1']);
});

test('candidate cap enforced at 40', async () => {
  const ids = Array.from({ length: 80 }, (_, i) => `m${i}`);
  const store = makeStore({ memoryIds: ids });
  const r = await resolveEntityRecallCandidates({ store, query: 'Davinci AI', org_id: 'org-1', user_id: 'user-1' });
  assert.ok(r.candidates.length <= HOP0_MAX_CANDIDATES);
});

test('canonical link registry (MemoryEntityLink) contributes candidates', async () => {
  const mems = new Map([['m1', makeMemory('m1')], ['mL', makeMemory('mL', { tags: [] })]]);
  const store = makeStore({
    memoryIds: ['m1'],
    memories: mems,
    canonical: [{ id: 'ce-1', canonicalName: 'Davinci AI', aliases: [] }],
    links: [{ memoryId: 'mL', entityId: 'ce-1' }],
  });
  const r = await resolveEntityRecallCandidates({ store, query: 'Davinci AI', org_id: 'org-1', user_id: 'user-1' });
  assert.deepEqual(new Set(r.candidates.map((c) => c.memory.id)), new Set(['m1', 'mL']));
});

test('deadline returns empty lane without blocking recall', async () => {
  const store = makeStore();
  store.client.entity.findMany = () => new Promise(() => {}); // hangs forever
  const t0 = Date.now();
  const r = await resolveEntityRecallCandidates({ store, query: 'Davinci AI', org_id: 'org-1', user_id: 'user-1', deadlineMs: 60 });
  assert.ok(Date.now() - t0 < 1000, 'must not block');
  assert.deepEqual(r.candidates, []);
  assert.equal(r.cutoff, true);
});

test('storage failure fails open to empty', async () => {
  const store = makeStore();
  store.client.memory.findMany = async () => { throw new Error('db down'); };
  const r = await resolveEntityRecallCandidates({ store, query: 'Davinci AI', org_id: 'org-1', user_id: 'user-1' });
  assert.deepEqual(r.candidates, []);
});

test('no registry models available (BYOD without parity) → empty, no throw', async () => {
  const store = { client: {}, getMemories: async () => new Map() };
  const r = await resolveEntityRecallCandidates({ store, query: 'Davinci AI', org_id: 'org-1', user_id: 'user-1' });
  assert.deepEqual(r.candidates, []);
});
