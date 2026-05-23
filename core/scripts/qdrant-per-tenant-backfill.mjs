#!/usr/bin/env node
/**
 * Qdrant per-tenant backfill.
 *
 * Reads every point from the legacy single collection (BUNDB AGENT or
 * QDRANT_COLLECTION env), partitions by payload.org_id (preferred) /
 * payload.user_id, and re-upserts into org_<orgId> / user_<userId>
 * collections. Idempotent — same point ID → upsert overwrites.
 *
 * Usage (inside hm-core container):
 *   docker exec hm-core node /app/scripts/qdrant-per-tenant-backfill.mjs --dry-run
 *   docker exec hm-core node /app/scripts/qdrant-per-tenant-backfill.mjs --commit
 *
 * After successful backfill, flip QDRANT_PER_TENANT=true to direct new
 * ingests to per-tenant collections. The legacy collection stays intact
 * as a fallback / rollback target.
 */

const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const SOURCE = process.env.QDRANT_COLLECTION || 'BUNDB AGENT';
const DIM = Number(process.env.EMBEDDING_DIMENSION) || 1536;
const BATCH = Number(process.env.BACKFILL_BATCH || 256);
const COMMIT = process.argv.includes('--commit');

if (!QDRANT_URL) {
  console.error('QDRANT_URL env required');
  process.exit(2);
}

const headers = {
  'Content-Type': 'application/json',
  ...(QDRANT_API_KEY ? { 'api-key': QDRANT_API_KEY } : {}),
};

async function qdrant(method, pathSeg, body) {
  const url = `${QDRANT_URL}${pathSeg}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Qdrant ${method} ${pathSeg} ${res.status}: ${t.slice(0, 300)}`);
  }
  return res.json();
}

async function ensureCollection(name) {
  try {
    await qdrant('GET', `/collections/${encodeURIComponent(name)}`);
    return;
  } catch (_) {
    // create
  }
  await qdrant('PUT', `/collections/${encodeURIComponent(name)}`, {
    vectors: { size: DIM, distance: 'Cosine' },
  });
  console.log(`  + created collection ${name} (dim=${DIM})`);
}

function targetCollectionFor(payload) {
  const orgId = payload?.org_id;
  const userId = payload?.user_id;
  if (orgId) return `org_${orgId}`;
  if (userId) return `user_${userId}`;
  return null;
}

async function scrollAll() {
  // Use Qdrant scroll endpoint to walk every point.
  let offset = null;
  let total = 0;
  const buckets = new Map();
  while (true) {
    const body = { limit: BATCH, with_payload: true, with_vector: true };
    if (offset) body.offset = offset;
    const resp = await qdrant('POST', `/collections/${encodeURIComponent(SOURCE)}/points/scroll`, body);
    const points = resp?.result?.points || [];
    if (points.length === 0) break;
    for (const p of points) {
      const tgt = targetCollectionFor(p.payload);
      if (!tgt) {
        // skip orphaned points without tenant
        continue;
      }
      if (!buckets.has(tgt)) buckets.set(tgt, []);
      buckets.get(tgt).push({ id: p.id, vector: p.vector, payload: p.payload });
    }
    total += points.length;
    offset = resp?.result?.next_page_offset;
    if (!offset) break;
  }
  return { total, buckets };
}

async function flushBucket(name, points) {
  if (points.length === 0) return;
  await ensureCollection(name);
  // Chunk upserts to avoid huge payloads.
  for (let i = 0; i < points.length; i += BATCH) {
    const slice = points.slice(i, i + BATCH);
    await qdrant('PUT', `/collections/${encodeURIComponent(name)}/points?wait=true`, { points: slice });
  }
}

(async () => {
  console.log(`[qdrant-backfill] source="${SOURCE}" dim=${DIM} batch=${BATCH} commit=${COMMIT}`);
  const { total, buckets } = await scrollAll();
  console.log(`[qdrant-backfill] scanned ${total} points → ${buckets.size} tenant collections`);
  for (const [name, pts] of buckets.entries()) {
    console.log(`  → ${name}: ${pts.length} points`);
  }
  if (!COMMIT) {
    console.log('\nDRY RUN — pass --commit to write.');
    process.exit(0);
  }
  let written = 0;
  for (const [name, pts] of buckets.entries()) {
    process.stdout.write(`  flushing ${name} (${pts.length})... `);
    await flushBucket(name, pts);
    written += pts.length;
    console.log('done');
  }
  console.log(`[qdrant-backfill] DONE — ${written}/${total} points written across ${buckets.size} collections`);
  console.log('Next: set QDRANT_PER_TENANT=true and restart hm-core to direct new writes to per-tenant collections.');
})().catch((e) => {
  console.error('[qdrant-backfill] FAIL:', e.message);
  process.exit(1);
});
