// Dogfood comparison: mneme typed traversal vs Postgres relationship BFS on the SAME org graph.
// Runs in hm-core while the shard is free (flag off). Read-only on Postgres.
const fs = require('fs');
const path = require('path');
const { MnemeStore, sanitizeOrg } = require('./index.cjs');

const ORG = process.env.BACKFILL_ORG;
const DATA_ROOT = process.env.MNEME_DATA_ROOT || '/app/data/mneme';
const DIM = Number(process.env.EMBEDDING_DIMENSION || 1024);
const COLL = 'org_' + ORG;
const TYPE = { Mentions: 1, Updates: 2, Derives: 3, Contradicts: 4, PartOf: 5, Extends: 6 };

(async () => {
  const dir = path.join(DATA_ROOT, sanitizeOrg(COLL));
  const id2slot = JSON.parse(fs.readFileSync(path.join(dir, 'idmap.json'), 'utf8'));
  const slot2id = {};
  for (const [id, s] of Object.entries(id2slot)) slot2id[s] = id;
  const store = MnemeStore.open(DATA_ROOT, sanitizeOrg(COLL), DIM);

  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  // find a seed: a relationship whose BOTH endpoints are in the shard (so mneme has the edge).
  const rels = await prisma.relationship.findMany({
    where: { fromMemory: { orgId: ORG } },
    select: { fromId: true, toId: true, type: true },
  });
  const seedRel = rels.find((r) => id2slot[r.fromId] != null && id2slot[r.toId] != null);
  if (!seedRel) {
    console.log('no in-shard seed edge found');
    await prisma.$disconnect();
    return;
  }
  const seedId = seedRel.fromId;
  const seedSlot = id2slot[seedId];
  const et = TYPE[seedRel.type];

  // mneme traverse (2-hop, this type) — timed.
  for (let i = 0; i < 20; i++) store.traverseTyped(seedSlot, et, 2); // warm
  let t = process.hrtime.bigint();
  let mnemeReached = [];
  for (let i = 0; i < 50; i++) mnemeReached = store.traverseTyped(seedSlot, et, 2);
  const mnemeMs = Number(process.hrtime.bigint() - t) / 1e6 / 50;
  const mnemeIds = new Set(mnemeReached.map((s) => slot2id[s]).filter(Boolean));

  // Postgres BFS (same 2-hop, same type) — timed, the relationship.findMany-per-hop path.
  async function pgBfs() {
    const visited = new Set([seedId]);
    let frontier = [seedId];
    const reached = new Set();
    for (let d = 0; d < 2 && frontier.length; d++) {
      const recs = await prisma.relationship.findMany({
        where: { type: seedRel.type, fromId: { in: frontier } },
        select: { toId: true },
      });
      const next = [];
      for (const r of recs) if (!visited.has(r.toId)) { visited.add(r.toId); reached.add(r.toId); next.push(r.toId); }
      frontier = next;
    }
    return reached;
  }
  await pgBfs(); // warm
  t = process.hrtime.bigint();
  let pgReached;
  for (let i = 0; i < 50; i++) pgReached = await pgBfs();
  const pgMs = Number(process.hrtime.bigint() - t) / 1e6 / 50;
  await prisma.$disconnect();

  // overlap: do they reach the same memories?
  const inter = [...mnemeIds].filter((id) => pgReached.has(id)).length;
  const union = new Set([...mnemeIds, ...pgReached]).size;
  console.log(`seed type=${seedRel.type} hops=2`);
  console.log(`mneme reached=${mnemeIds.size}  postgres reached=${pgReached.size}  overlap=${inter}/${union}`);
  console.log(`mneme_traverse_ms=${mnemeMs.toFixed(4)}  postgres_traverse_ms=${pgMs.toFixed(4)}  speedup=${(pgMs / mnemeMs).toFixed(0)}x`);
})();
