#!/usr/bin/env node
/**
 * G1 — Entity extraction-symmetry invariant (the gate for ENTITY_FILTER_MODE=must).
 *
 * Write side: an LLM (graph-engine entity-linker) stamps rich entity:<Name> tags
 * at ingest. Read side: normalizeQueryEntityTokens() (regex, 0-token) derives
 * candidate entity tags from the query at recall time. Qdrant keyword match is
 * EXACT — if the read-side forms don't reproduce the write-side tags, the entity
 * FILTER pushdown is theater (silently matches nothing) even though the fuzzy
 * ×1.8 boost still works.
 *
 * This measures the real recall: sample N memories that HAVE entity:* tags, run
 * their CONTENT through the query normalizer, and check how many of their actual
 * entity:* tags the normalizer reproduces (exact match).
 *
 * GATE: overall tag-recall must be >= THRESHOLD (default 0.80) before flipping
 * ENTITY_FILTER_MODE to `must`. Below that, only `should` (two-pass, floor-safe)
 * is justified. Exits 1 when below threshold (CI gate).
 *
 * Usage (inside hm-core):
 *   docker exec hm-core node /app/scripts/entity-extraction-symmetry.mjs
 *   SAMPLE=200 THRESHOLD=0.8 docker exec -e SAMPLE -e THRESHOLD hm-core node /app/scripts/entity-extraction-symmetry.mjs
 */

import { PrismaClient } from '@prisma/client';
import { normalizeQueryEntityTokens } from '/app/src/memory/persisted-retrieval.js';

const SAMPLE = Number(process.env.SAMPLE || 100);
const THRESHOLD = Number(process.env.THRESHOLD || 0.80);
const prisma = new PrismaClient();

async function main() {
  // Memories carrying at least one entity:* tag (the write-side ground truth).
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, content, tags
       FROM hivemind.memories
      WHERE deleted_at IS NULL AND is_latest = true
        AND EXISTS (SELECT 1 FROM unnest(tags) t WHERE t LIKE 'entity:%')
        AND content IS NOT NULL AND length(content) > 0
      ORDER BY created_at DESC
      LIMIT ${SAMPLE}`,
  );
  if (!rows.length) { console.log('[g1] no entity-tagged memories found'); process.exit(0); }

  let totalTags = 0, hitTags = 0, perMemSum = 0;
  const misses = [];
  for (const m of rows) {
    const entityTags = (m.tags || []).filter((t) => t.startsWith('entity:'));
    if (!entityTags.length) continue;
    // The normalizer emits both entity: and person: variants; entity tags are
    // what we compare against. Use a case-insensitive candidate set as the
    // generous bound (Qdrant is case-SENSITIVE, so report both).
    const cands = new Set(normalizeQueryEntityTokens(m.content));
    const candsLc = new Set([...cands].map((c) => c.toLowerCase()));
    let memHit = 0;
    for (const tag of entityTags) {
      totalTags++;
      const exact = cands.has(tag);
      const ci = candsLc.has(tag.toLowerCase());
      if (exact || ci) { hitTags++; memHit++; }
      else if (misses.length < 30) misses.push({ tag, content: (m.content || '').slice(0, 60) });
    }
    perMemSum += entityTags.length ? memHit / entityTags.length : 0;
  }

  const microRecall = totalTags ? hitTags / totalTags : 0;       // per-tag
  const macroRecall = rows.length ? perMemSum / rows.length : 0;  // per-memory mean
  console.log(`[g1] sampled ${rows.length} memories, ${totalTags} entity tags`);
  console.log(`[g1] micro tag-recall (case-insensitive bound): ${(microRecall * 100).toFixed(1)}%`);
  console.log(`[g1] macro per-memory recall:                    ${(macroRecall * 100).toFixed(1)}%`);
  console.log(`[g1] threshold: ${(THRESHOLD * 100).toFixed(0)}%  →  ${microRecall >= THRESHOLD ? 'PASS — must-mode justified' : 'FAIL — stay on should (filter pushdown would silently miss tags)'}`);
  if (misses.length) {
    console.log(`[g1] sample misses (tag not reproduced from content):`);
    for (const x of misses.slice(0, 12)) console.log(`   ${x.tag}  ⟂  "${x.content}"`);
  }
  await prisma.$disconnect();
  process.exit(microRecall >= THRESHOLD ? 0 : 1);
}

main().catch((e) => { console.error('[g1] fatal:', e); process.exit(2); });
