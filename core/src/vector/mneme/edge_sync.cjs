// Incremental edge-mirror: keep an org's .amr typed-edge graph in sync with Postgres relationships
// as they are created by the LLM pipeline (extraction, cognition synthesis, save path — any source).
// Watermark on relationship.createdAt makes it a cheap delta sync; relationships are immutable so a
// createdAt cursor never re-adds an edge. Run after each ingest batch or on a timer.
// Usage: docker exec -e SYNC_ORG=<orgId> hm-core node /app/src/vector/mneme/edge_sync.cjs
const fs = require('fs');
const path = require('path');
const { MnemeStore, sanitizeOrg } = require('./index.cjs');

const ORG = process.env.SYNC_ORG;
const DATA_ROOT = process.env.MNEME_DATA_ROOT || '/app/data/mneme';
const DIM = Number(process.env.EMBEDDING_DIMENSION || 1024);
const COLL = 'org_' + ORG;
const TYPE = { Mentions: 1, Updates: 2, Derives: 3, Contradicts: 4, PartOf: 5, Extends: 6 };

(async () => {
  if (!ORG) throw new Error('set SYNC_ORG');
  const shardDir = path.join(DATA_ROOT, sanitizeOrg(COLL));
  const wmPath = path.join(shardDir, 'edgesync.json');
  const idMap = JSON.parse(fs.readFileSync(path.join(shardDir, 'idmap.json'), 'utf8'));
  const watermark = fs.existsSync(wmPath)
    ? new Date(JSON.parse(fs.readFileSync(wmPath, 'utf8')).lastCreatedAt)
    : new Date(0);

  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  // new relationships since the watermark whose FROM memory is in this org.
  const rels = await prisma.relationship.findMany({
    where: { fromMemory: { orgId: ORG }, createdAt: { gt: watermark } },
    select: { fromId: true, toId: true, type: true, confidence: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  await prisma.$disconnect();

  if (rels.length === 0) {
    console.log(`edge-sync ${COLL}: up to date (watermark ${watermark.toISOString()})`);
    return;
  }

  const store = MnemeStore.open(DATA_ROOT, sanitizeOrg(COLL), DIM);
  let added = 0;
  let skipped = 0;
  let maxTs = watermark;
  for (const r of rels) {
    if (r.createdAt > maxTs) maxTs = r.createdAt;
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
  fs.writeFileSync(wmPath, JSON.stringify({ lastCreatedAt: maxTs.toISOString() }));
  console.log(
    `edge-sync ${COLL}: +${added} edges, ${skipped} skipped (slot not yet mirrored), watermark -> ${maxTs.toISOString()}`
  );
})();
