#!/usr/bin/env node
/**
 * Re-ingest existing memories through the canonical pipeline.
 *
 * What it does (per memory, in place — no duplicate rows):
 *   1. Strip stale operator edges (createdBy: conflict-detector, turing-
 *      reconciliation, entity_co_mention_llm) that came from the old
 *      polluted pipeline. Keeps PartOf / explicit user edges.
 *   2. Reset is_latest = true (the old supersede chain may have flipped
 *      it incorrectly via false-positive contradictions).
 *   3. Stamp ts:YYYY-MM-DD + ts:YYYY-MM-DDTHHMMZ tags from createdAt.
 *   4. Fire _attachEntityCoMentionEdges on the memory — LLM extracts
 *      entities, temporal anchors, memory_type; emits up to 6 new
 *      operator edges (Updates / Extends / Mentions / Contradicts /
 *      Derives) backed by entity overlap.
 *
 * Idempotent — running twice is safe. Resumes from BATCH_OFFSET env.
 *
 * Usage (inside hm-core container):
 *   USER_ID=<uuid> docker exec hm-core node /app/scripts/reingest-memories-canonical.mjs --dry-run
 *   USER_ID=<uuid> docker exec hm-core node /app/scripts/reingest-memories-canonical.mjs --commit
 */

import { PrismaClient } from '@prisma/client';
import { PrismaGraphStore } from '/app/src/memory/prisma-graph-store.js';
import { MemoryGraphEngine } from '/app/src/memory/graph-engine.js';

const USER_ID = process.env.USER_ID;
const ORG_ID = process.env.ORG_ID || null;
const COMMIT = process.argv.includes('--commit');
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 50);
const BATCH_OFFSET = Number(process.env.BATCH_OFFSET || 0);
const SLEEP_MS = Number(process.env.SLEEP_MS || 600); // throttle LLM calls

if (!USER_ID) {
  console.error('USER_ID env required');
  process.exit(2);
}

const STALE_EDGE_CREATORS = new Set([
  'conflict-detector',
  'turing-reconciliation',
  'entity_co_mention_llm',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const prisma = new PrismaClient();
  const store = new PrismaGraphStore(prisma);
  // Engine attached WITHOUT a router so ingestMemoryTree path stays clean;
  // we call _attachEntityCoMentionEdges directly.
  const engine = new MemoryGraphEngine({ store });

  // Resolve org from one of the user's memories if not passed.
  let orgId = ORG_ID;
  if (!orgId) {
    const sample = await prisma.memory.findFirst({
      where: { userId: USER_ID }, select: { orgId: true },
    });
    orgId = sample?.orgId || null;
    console.log(`[reingest] resolved orgId=${orgId}`);
  }

  // Scope to memories worth reingesting:
  //   • undeleted
  //   • NOT extracted-fact children (those are LLM-extracted sub-rows of
  //     a canonical parent — reingesting them duplicates parent semantics
  //     and burns LLM budget on noise).
  //   • NOT canonical-summary (drift-compaction rollups, regenerate via
  //     cognition tick if needed).
  //   • NOT chat conversation-log rows (audit trail, no fact-claim).
  // Result: targets ~863 top-level memories instead of 4198.
  const EXCLUDED_TAGS = ['extracted-fact', 'canonical-summary', 'conversation-log'];
  const baseWhere = {
    userId: USER_ID,
    deletedAt: null,
    NOT: { tags: { hasSome: EXCLUDED_TAGS } },
  };
  const total = await prisma.memory.count({ where: baseWhere });
  console.log(`[reingest] user=${USER_ID} scope=${total} (excluding ${EXCLUDED_TAGS.join(',')}) batch=${BATCH_SIZE} offset=${BATCH_OFFSET} commit=${COMMIT}`);

  let offset = BATCH_OFFSET;
  let processed = 0;
  let succeeded = 0;
  let edgesPurged = 0;
  let edgesAdded = 0;
  let tagsAdded = 0;
  let typeUpgraded = 0;
  let llmFailed = 0;
  const startedAt = Date.now();

  while (offset < total) {
    const memories = await prisma.memory.findMany({
      where: baseWhere,
      orderBy: { createdAt: 'asc' },
      skip: offset,
      take: BATCH_SIZE,
      select: {
        id: true, content: true, title: true, tags: true, memoryType: true,
        isLatest: true, createdAt: true, orgId: true,
      },
    });

    if (memories.length === 0) break;

    for (const m of memories) {
      processed++;
      const id = m.id;
      try {
        // 1. Strip stale operator edges.
        if (COMMIT) {
          const del = await prisma.relationship.deleteMany({
            where: { fromId: id, createdBy: { in: Array.from(STALE_EDGE_CREATORS) } },
          });
          edgesPurged += del.count;
        }

        // 2. Reset is_latest=true unless this memory has a downstream
        //    Updates edge from a NEWER memory (true supersession we want
        //    to keep).
        if (COMMIT && !m.isLatest) {
          const downstream = await prisma.relationship.findFirst({
            where: { toId: id, type: 'Updates' },
            select: { id: true },
          });
          if (!downstream) {
            await prisma.memory.update({
              where: { id }, data: { isLatest: true },
            });
          }
        }

        // 3. Stamp ts:* tags from createdAt (skip if already present).
        const dt = m.createdAt instanceof Date ? m.createdAt : new Date(m.createdAt);
        const day = dt.toISOString().slice(0, 10);
        const minute = dt.toISOString().slice(0, 16).replace(/:/g, '') + 'Z';
        const dayTag = `ts:${day}`;
        const minuteTag = `ts:${minute}`;
        const existingTs = (m.tags || []).some((t) => t.startsWith('ts:'));
        if (COMMIT && !existingTs) {
          const newTags = Array.from(new Set([...(m.tags || []), dayTag, minuteTag]));
          await prisma.memory.update({
            where: { id }, data: { tags: newTags },
          });
          tagsAdded++;
        }

        // 4. Fire LLM entity-co-mention against this memory + its
        //    nearest peers (vector recall via Qdrant if wired, else
        //    recency fallback). Produces up to 6 new typed edges +
        //    entity/temporal tags.
        const baseMemory = {
          id,
          user_id: USER_ID,
          org_id: orgId,
          content: m.content,
          title: m.title,
          tags: m.tags,
          memory_type: m.memoryType,
          metadata: { force_entity_linking: true },
          source_metadata: { source_platform: 'reingest', source_type: 'manual' },
        };

        if (COMMIT) {
          // Best-effort recall to provide candidates. The recency
          // fallback inside _attachEntityCoMentionEdges fires when
          // similar=[].
          try {
            await engine._attachEntityCoMentionEdges(baseMemory, store, []);
          } catch (linkErr) {
            llmFailed++;
            console.warn(`[reingest] ${id.slice(0, 8)} link failed: ${linkErr.message}`);
          }
        }

        succeeded++;
      } catch (err) {
        console.error(`[reingest] ${id.slice(0, 8)} error: ${err.message}`);
      }

      if (processed % 10 === 0) {
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        const rate = processed / Math.max(elapsed, 1);
        const eta = Math.round((total - processed) / Math.max(rate, 0.001));
        console.log(`[reingest] ${processed}/${total} ok=${succeeded} llm_fail=${llmFailed} purged=${edgesPurged} ${rate.toFixed(1)}/s ETA=${eta}s`);
      }

      // Throttle LLM calls (entity-co-mention uses Groq llama-3.3-70b).
      if (COMMIT) await sleep(SLEEP_MS);
    }

    offset += memories.length;
  }

  // Count new edges + tag additions from the run.
  if (COMMIT) {
    const newEdges = await prisma.relationship.count({
      where: {
        fromId: { in: undefined }, // count all; cannot scope cheaply
        createdBy: 'entity_co_mention_llm',
        createdAt: { gte: new Date(startedAt) },
      },
    });
    edgesAdded = newEdges;
  }

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  console.log('\n=== reingest summary ===');
  console.log(`user:           ${USER_ID}`);
  console.log(`processed:      ${processed}/${total}`);
  console.log(`succeeded:      ${succeeded}`);
  console.log(`stale edges purged: ${edgesPurged}`);
  console.log(`new operator edges: ${edgesAdded}`);
  console.log(`ts:* tags added:    ${tagsAdded}`);
  console.log(`type upgrades:      ${typeUpgraded}`);
  console.log(`llm failures:       ${llmFailed}`);
  console.log(`elapsed:        ${elapsed}s`);
  console.log(`commit:         ${COMMIT}`);

  await prisma.$disconnect();
})().catch((err) => {
  console.error('[reingest] fatal:', err.message);
  console.error(err.stack);
  process.exit(1);
});
