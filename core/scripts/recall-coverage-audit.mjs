#!/usr/bin/env node
/**
 * Per-tenant recall-coverage audit: does every is_latest memory have BOTH
 *   - a VECTOR (a Qdrant point with id == memory.id in the org's routed collection), and
 *   - LEXICAL searchability (non-empty content → live Postgres FTS derives from it)?
 *
 * Lexical note: FTS is computed at query time from the content/title columns, so
 * a memory is lexically retrievable iff content (or title) is non-empty — there
 * is no separate lexical index to be "missing". So we report content-presence as
 * the lexical proxy, and Qdrant point existence as the vector check.
 *
 * Routing mirrors recall: enterprise org → org_<id>; free/no-plan → HIVEMIND_PERSONAL.
 *
 * Usage (inside hm-core):
 *   docker exec hm-core node /app/scripts/recall-coverage-audit.mjs
 *   VERBOSE=1 docker exec -e VERBOSE hm-core node /app/scripts/recall-coverage-audit.mjs   # list missing ids
 */

import { PrismaClient } from '@prisma/client';
import { resolveCollectionForOrg } from '/app/src/vector/container-router.js';

const prisma = new PrismaClient();
const QURL = process.env.QDRANT_URL;
const QKEY = process.env.QDRANT_API_KEY;
const VERBOSE = process.env.VERBOSE === '1';
const headers = { 'Content-Type': 'application/json', ...(QKEY ? { 'api-key': QKEY } : {}) };

// Which of `ids` exist as points in `collection` (id == memory.id). Batched.
async function existingPointIds(collection, ids) {
  const found = new Set();
  for (let i = 0; i < ids.length; i += 256) {
    const batch = ids.slice(i, i + 256);
    const r = await fetch(`${QURL}/collections/${encodeURIComponent(collection)}/points`, {
      method: 'POST', headers,
      body: JSON.stringify({ ids: batch, with_payload: false, with_vector: false }),
    });
    if (!r.ok) continue;
    const j = await r.json();
    for (const p of (j.result || [])) found.add(String(p.id));
  }
  return found;
}

async function main() {
  const orgs = await prisma.$queryRawUnsafe(
    `SELECT m.org_id, count(*)::int total
       FROM hivemind.memories m
      WHERE m.deleted_at IS NULL AND m.is_latest = true AND m.org_id IS NOT NULL
      GROUP BY m.org_id ORDER BY total DESC`,
  );
  console.log(`[audit] ${orgs.length} org tenants with is_latest memories\n`);

  let gTotal = 0, gContent = 0, gVector = 0, gMissingVec = 0, gNoContent = 0;
  const problemOrgs = [];

  for (const { org_id } of orgs) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, (content IS NOT NULL AND length(trim(content)) > 0) AS has_content
         FROM hivemind.memories
        WHERE deleted_at IS NULL AND is_latest = true AND org_id = $1::uuid`,
      org_id,
    );
    const total = rows.length;
    const withContent = rows.filter(r => r.has_content);
    const noContent = total - withContent.length;
    const collection = await resolveCollectionForOrg(org_id);
    // Only content-bearing memories are expected to have a vector.
    const found = await existingPointIds(collection, withContent.map(r => r.id));
    const vectored = withContent.filter(r => found.has(String(r.id))).length;
    const missingVec = withContent.length - vectored;

    gTotal += total; gContent += withContent.length; gVector += vectored;
    gMissingVec += missingVec; gNoContent += noContent;

    const pct = withContent.length ? ((vectored / withContent.length) * 100).toFixed(1) : '100.0';
    const flag = missingVec > 0 ? ' ⚠' : '';
    console.log(`${org_id.slice(0, 8)} → ${collection.padEnd(22)} latest=${total} content=${withContent.length} vector=${vectored} (${pct}%) missingVec=${missingVec} noContent=${noContent}${flag}`);
    if (missingVec > 0) {
      problemOrgs.push({ org_id, collection, missingVec, withContent: withContent.length });
      if (VERBOSE) {
        const miss = withContent.filter(r => !found.has(String(r.id))).slice(0, 15).map(r => r.id);
        console.log(`     missing ids: ${miss.join(', ')}`);
      }
    }
  }

  console.log(`\n[audit] TOTALS: latest=${gTotal} content-bearing=${gContent} vectored=${gVector} missingVector=${gMissingVec} noContent(noLexical)=${gNoContent}`);
  const vpct = gContent ? ((gVector / gContent) * 100).toFixed(2) : '100';
  console.log(`[audit] VECTOR coverage of content-bearing latest memories: ${vpct}%`);
  console.log(`[audit] LEXICAL coverage (content-bearing): ${gTotal ? ((gContent / gTotal) * 100).toFixed(2) : 100}% (${gNoContent} latest memories have empty content → no lexical signal)`);
  if (problemOrgs.length) {
    console.log(`\n[audit] ${problemOrgs.length} org(s) with missing vectors:`);
    for (const p of problemOrgs.sort((a, b) => b.missingVec - a.missingVec)) {
      console.log(`   ${p.org_id} (${p.collection}): ${p.missingVec}/${p.withContent} missing`);
    }
  } else {
    console.log(`\n[audit] ✅ every content-bearing is_latest memory in every org has a vector.`);
  }
  await prisma.$disconnect();
}

main().catch((e) => { console.error('[audit] fatal:', e); process.exit(1); });
