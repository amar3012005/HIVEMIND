// Edge backfill: load an org's typed relationships from Postgres into its .amr shard's typed-edge
// graph (add_edge), so mneme can serve graph traversal. Maps memory_id -> slot via idmap.json and
// RelationshipType -> EDGE_* (1:1). Run while hm-core does NOT hold the shard flock (flag off +
// restarted). Usage: docker exec -e BACKFILL_ORG=<orgId> hm-core node /app/src/vector/mneme/edge_backfill.cjs
const fs = require('fs');
const path = require('path');
const { MnemeStore, sanitizeOrg } = require('./index.cjs');

const ORG = process.env.BACKFILL_ORG;
const DATA_ROOT = process.env.MNEME_DATA_ROOT || '/app/data/mneme';
const DIM = Number(process.env.EMBEDDING_DIMENSION || 1024);
const COLL = 'org_' + ORG;

// RelationshipType (Postgres) -> EDGE_* (mneme), exact 1:1.
const TYPE = { Mentions: 1, Updates: 2, Derives: 3, Contradicts: 4, PartOf: 5, Extends: 6 };

(async () => {
  if (!ORG) throw new Error('set BACKFILL_ORG');
  const shardDir = path.join(DATA_ROOT, sanitizeOrg(COLL));
  const idMap = JSON.parse(fs.readFileSync(path.join(shardDir, 'idmap.json'), 'utf8'));

  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  // all typed relationships whose FROM memory is in this org.
  const rels = await prisma.relationship.findMany({
    where: { fromMemory: { orgId: ORG } },
    select: { fromId: true, toId: true, type: true, confidence: true },
  });
  await prisma.$disconnect();

  const store = MnemeStore.open(DATA_ROOT, sanitizeOrg(COLL), DIM);
  let added = 0;
  let skipped = 0;
  for (const r of rels) {
    const fromSlot = idMap[r.fromId];
    const toSlot = idMap[r.toId];
    const et = TYPE[r.type];
    if (fromSlot == null || toSlot == null || !et) {
      skipped++;
      continue;
    }
    const weight = Math.max(1, Math.min(255, Math.round((r.confidence ?? 1) * 255)));
    store.addEdge(fromSlot, toSlot, et, weight);
    added++;
  }
  store.flush();
  console.log(`edge-backfill ${COLL}: added ${added} edges, skipped ${skipped} (no slot/type) of ${rels.length} relationships`);
})();
