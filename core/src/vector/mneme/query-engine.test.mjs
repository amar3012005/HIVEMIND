// Local test for the .amr query engine — exercises the real HIVEMIND query shapes (the 22 the
// pipeline issues) against synthetic records. Run: node core/src/vector/mneme/query-engine.test.mjs
import { findMany, findFirst, findUnique, count, groupBy, aggregate, evalWhere } from './query-engine.js';
import assert from 'node:assert';

const ORG = 'org-sai';
const now = Date.now();
const recs = [
  { id: 'm1', orgId: ORG, userId: 'u1', content: 'implicit memory', tags: ['extracted-fact', 'entity:hippocampus'], memoryType: 'fact', isLatest: true, deletedAt: null, createdAt: new Date(now - 5000), confidence: 0.9, layer: 'memory', cognitiveLayerRole: null, tier: 2 },
  { id: 'm2', orgId: ORG, userId: 'u1', content: 'raw chunk dump', tags: ['promoted-from-segment'], memoryType: 'fact', isLatest: true, deletedAt: null, createdAt: new Date(now - 4000), confidence: 0.5, layer: 'evidence', cognitiveLayerRole: null, tier: 1 },
  { id: 'm3', orgId: ORG, userId: 'u2', content: 'old version', tags: ['extracted-fact'], memoryType: 'fact', isLatest: false, deletedAt: null, createdAt: new Date(now - 3000), confidence: 0.8, layer: 'memory', cognitiveLayerRole: null, tier: 2 },
  { id: 'm4', orgId: ORG, userId: 'u1', content: 'a synthesis', tags: ['dream'], memoryType: 'fact', isLatest: true, deletedAt: null, createdAt: new Date(now - 2000), confidence: 1.0, layer: 'cognitive', cognitiveLayerRole: 'canonical', tier: 2 },
  { id: 'm5', orgId: ORG, userId: 'u1', content: 'deleted one', tags: [], memoryType: 'fact', isLatest: true, deletedAt: new Date(now - 1000), createdAt: new Date(now - 1500), confidence: 0.7, layer: 'memory', cognitiveLayerRole: null, tier: 2 },
  { id: 'mx', orgId: 'org-other', userId: 'u9', content: 'other org', tags: ['extracted-fact'], memoryType: 'fact', isLatest: true, deletedAt: null, createdAt: new Date(now), confidence: 0.9, layer: 'memory', cognitiveLayerRole: null, tier: 2 },
];
const ctx = { records: recs };
let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };

// 1. the canonical list query: org-scoped, latest, not deleted, non-evidence layer, ordered, paginated
t('findMany: orgId + isLatest + deletedAt:null + layer!=evidence + orderBy createdAt desc + take', () => {
  const r = findMany(ctx, {
    where: { orgId: ORG, isLatest: true, deletedAt: null, NOT: { layer: 'evidence' } },
    orderBy: { createdAt: 'desc' }, take: 10,
  });
  assert.deepEqual(r.map((x) => x.id), ['m4', 'm1']); // m2=evidence excluded, m3=not latest, m5=deleted
});

// 2. tags hasSome (filename/entity recall)
t('findMany: tags hasSome', () => {
  const r = findMany(ctx, { where: { orgId: ORG, tags: { hasSome: ['entity:hippocampus', 'dream'] } } });
  assert.deepEqual(r.map((x) => x.id).sort(), ['m1', 'm4']);
});

// 3. id IN list
t('findMany: id in [...]', () => {
  const r = findMany(ctx, { where: { id: { in: ['m1', 'm3', 'nope'] } } });
  assert.deepEqual(r.map((x) => x.id).sort(), ['m1', 'm3']);
});

// 4. createdAt gt (temporal range)
t('findMany: createdAt gt', () => {
  const r = findMany(ctx, { where: { orgId: ORG, createdAt: { gt: new Date(now - 2500) } } });
  assert.deepEqual(r.map((x) => x.id).sort(), ['m4', 'm5']);
});

// 5. count with filter
t('count: org + isLatest', () => {
  assert.equal(count(ctx, { where: { orgId: ORG, isLatest: true, deletedAt: null } }), 3); // m1,m2,m4
});

// 6. findUnique by id
t('findUnique by id', () => {
  assert.equal(findUnique(ctx, { where: { id: 'm4' } }).content, 'a synthesis');
  assert.equal(findUnique(ctx, { where: { id: 'zzz' } }), null);
});

// 7. findFirst filtered top-1
t('findFirst: cognitiveLayerRole set, latest', () => {
  const r = findFirst(ctx, { where: { orgId: ORG, cognitiveLayerRole: { not: null } } });
  assert.equal(r.id, 'm4');
});

// 8. groupBy memoryType / layer
t('groupBy layer + _count', () => {
  const g = groupBy(ctx, { by: ['layer'], where: { orgId: ORG }, _count: true });
  const byLayer = Object.fromEntries(g.map((x) => [x.layer, x._count]));
  assert.equal(byLayer.memory, 3); // m1,m3,m5
  assert.equal(byLayer.evidence, 1);
  assert.equal(byLayer.cognitive, 1);
});

// 9. aggregate _count + _max
t('aggregate: _count + _max confidence', () => {
  const a = aggregate(ctx, { where: { orgId: ORG }, _count: true, _max: { confidence: true } });
  assert.equal(a._count, 5);
  assert.equal(a._max.confidence, 1.0);
});

// 10. select projection
t('findMany: select projects only requested fields', () => {
  const r = findMany(ctx, { where: { id: 'm1' }, select: { id: true, content: true } });
  assert.deepEqual(Object.keys(r[0]).sort(), ['content', 'id']);
});

// 11. tenant isolation — org filter never leaks other orgs
t('tenant isolation: org filter excludes other org', () => {
  const r = findMany(ctx, { where: { orgId: ORG } });
  assert.ok(!r.some((x) => x.id === 'mx'));
});

// 12. relation filter via resolver (relationship.findMany where fromMemory:{orgId})
t('relation filter resolver (fromMemory:{orgId})', () => {
  const memById = new Map(recs.map((m) => [m.id, m]));
  const rels = [{ id: 'r1', fromId: 'm1', toId: 'm3', type: 'Updates' }, { id: 'r2', fromId: 'mx', toId: 'm1', type: 'Mentions' }];
  const relResolve = (rel, key, cond) => {
    if (key === 'fromMemory') return evalWhere(memById.get(rel.fromId) || {}, cond);
    return undefined;
  };
  const out = rels.filter((rel) => evalWhere(rel, { fromMemory: { orgId: ORG }, type: 'Updates' }, relResolve));
  assert.deepEqual(out.map((x) => x.id), ['r1']);
});

console.log(`\n.amr query-engine: ${pass}/12 query shapes PASS`);
