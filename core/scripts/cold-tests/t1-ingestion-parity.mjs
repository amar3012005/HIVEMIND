/**
 * T1 — Canonical ingestion parity (the user's #1 requirement).
 *
 * Ingest a unique fact through the canonical HTTP path (/api/memories) and PROVE
 * the canonical createMemory pipeline produced the full structural footprint:
 *   - memory row
 *   - source_metadata row with a content_hash (dedup contract)
 *   - ts:* temporal stamp tag
 *   - entity:* tag (async entity-co-mention linker — polled)
 *   - >= 1 relationship edge (entity co-mention / operator inference)
 *
 * This is the difference between "we think canonical ingestion works" and
 * "we proved it end-to-end against the live engine".
 *
 * NON-DESTRUCTIVE: writes only to the canonical test user/org, tagged `coldtest`.
 */
import { createRequire } from 'module';
import { api, makeReport, uniqueFact, USER_ID, ORG_ID, COLDTEST_TAG } from './lib.mjs';

const require = createRequire(import.meta.url);

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const r = makeReport('T1-ingestion-parity');
  const fact = uniqueFact('Aurelia Vance leads the Meridian platform project at HIVEMIND');

  // 1. Ingest via canonical HTTP path.
  const ingest = await api('POST', '/api/memories', {
    content: fact,
    memory_type: 'fact',
    tags: [COLDTEST_TAG],
    project: 'coldtest',
  });
  const created = r.check('canonical POST /api/memories 2xx', ingest.ok, `status=${ingest.status}`);
  if (!created) { return r.finish(); }

  const memId = ingest.json?.memory?.id || ingest.json?.id || ingest.json?.memory_id;
  r.check('returns a memory id', !!memId, memId || ingest.text?.slice(0, 120));

  // 2-5. Verify structural footprint via Prisma (poll for async entity linker).
  let prisma;
  try {
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient();
  } catch (e) {
    r.check('prisma client available', false, String(e).slice(0, 120));
    return r.finish();
  }

  try {
    // Resolve the row by id (fallback: newest coldtest row for this user).
    let mem = null;
    for (let i = 0; i < 12 && !mem; i++) {
      mem = memId
        ? await prisma.memory.findFirst({ where: { id: memId } }).catch(() => null)
        : await prisma.memory.findFirst({
            where: { userId: USER_ID, tags: { has: COLDTEST_TAG } },
            orderBy: { createdAt: 'desc' },
          }).catch(() => null);
      if (!mem) await sleep(1500);
    }
    r.check('memory row persisted', !!mem, mem ? `id=${mem.id}` : 'not found');
    if (!mem) return r.finish();

    // source_metadata row + content_hash
    const sm = await prisma.sourceMetadata.findFirst({ where: { memoryId: mem.id } }).catch(() => null);
    r.check('source_metadata row exists', !!sm, sm ? 'ok' : 'missing');
    const hash = sm?.contentHash || sm?.metadata?.content_hash || sm?.metadata?.contentHash;
    r.check('content_hash present (dedup contract)', !!hash, hash ? String(hash).slice(0, 16) : 'none');

    // Poll for async tags (entity linker is fire-and-forget post-write).
    let tags = mem.tags || [];
    let hasTs = false, hasEntity = false;
    for (let i = 0; i < 14; i++) {
      const fresh = await prisma.memory.findFirst({ where: { id: mem.id } }).catch(() => null);
      tags = fresh?.tags || tags;
      hasTs = tags.some((t) => t.startsWith('ts:'));
      hasEntity = tags.some((t) => t.startsWith('entity:') || t.startsWith('person:'));
      if (hasTs && hasEntity) break;
      await sleep(2000);
    }
    r.check('ts:* temporal stamp tag', hasTs, tags.filter((t) => t.startsWith('ts:')).join(',') || 'none');
    r.check('entity:* tag (async linker fired)', hasEntity,
      tags.filter((t) => t.startsWith('entity:') || t.startsWith('person:')).join(',') || 'none');

    // >= 1 relationship edge from this memory.
    let edges = 0;
    for (let i = 0; i < 8; i++) {
      edges = await prisma.relationship.count({ where: { fromMemoryId: mem.id } }).catch(() => 0);
      if (edges > 0) break;
      await sleep(2000);
    }
    r.check('>= 1 relationship edge created', edges > 0, `edges=${edges}`);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }

  return r.finish();
}

main().then((result) => {
  console.log(JSON.stringify(result));
  process.exit(result.green ? 0 : 1);
}).catch((e) => {
  console.error('T1 crashed:', e);
  process.exit(2);
});
