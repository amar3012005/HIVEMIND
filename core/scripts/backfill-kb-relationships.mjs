#!/usr/bin/env node
/**
 * PHASE-3 backfill: mint typed relationship edges (Contradicts / Updates / Extends)
 * on EXISTING KB facts that were pure-inserted (skip_contradiction_detection).
 *
 * Runs the SAME hardened path the live ingest now uses — MemoryGraphEngine
 * .detectAndLinkContradictionsFor — over every latest fact in a project, against
 * its entity-overlapping cross-fact candidates. Algorithmic detector (no LLM),
 * entity-overlap-gated + strict + capped, so it cannot edge-explode.
 *
 * Usage (in-container):
 *   node /app/scripts/backfill-kb-relationships.mjs <projectId>            # DRY-RUN (counts only)
 *   node /app/scripts/backfill-kb-relationships.mjs <projectId> --commit   # apply edges
 *
 * Safe: dry-run by default. --commit upserts edges (dedup via fromId_toId_type)
 * and flips is_latest on reconciled-Updates targets.
 */
import { PrismaClient } from '@prisma/client';
import { ConflictDetector } from '../src/memory/conflict-detector.js';
import { PrismaGraphStore } from '../src/memory/prisma-graph-store.js';
import { MemoryGraphEngine } from '../src/memory/graph-engine.js';

const projectId = process.argv[2];
const COMMIT = process.argv.includes('--commit');
if (!projectId) { console.error('usage: backfill-kb-relationships.mjs <projectId> [--commit]'); process.exit(1); }

const CAND_CAP = 25;       // candidates per fact (bounds work on common entities)
const detect = MemoryGraphEngine.prototype.detectAndLinkContradictionsFor;

(async () => {
  const prisma = new PrismaClient();
  const realStore = new PrismaGraphStore(prisma);
  const counts = { contradicts: 0, updates: 0, extends: 0 };
  // Dry-run store: tally what WOULD be written, mutate nothing.
  const dryStore = {
    createRelationship: async () => {},
    updateMemory: async () => {},
  };
  const store = COMMIT ? realStore : dryStore;
  const ctx = { conflictDetector: new ConflictDetector(), store };

  try {
    // 1. latest, non-deleted fact ids in the project
    const links = await prisma.memoryProject.findMany({ where: { projectId }, select: { memoryId: true } });
    const ids = links.map((l) => l.memoryId);
    if (!ids.length) { console.log('no memories in project'); return; }

    // 2. hydrate via the store so shapes match the live path exactly (snake_case, tags[])
    const memMap = await realStore.getMemories(ids);
    const facts = [];
    for (const id of ids) {
      const m = memMap.get?.(id);
      if (m && (m.is_latest !== false) && !m.deleted_at && (m.memory_type === 'fact')) facts.push(m);
    }
    console.log(`project ${projectId.slice(0, 8)}: ${facts.length} latest facts (of ${ids.length} linked)`);

    // 3. entity-tag → fact index for candidate selection
    const byEntity = new Map();
    for (const f of facts) {
      for (const t of (f.tags || [])) {
        if (typeof t === 'string' && t.startsWith('entity:')) {
          if (!byEntity.has(t)) byEntity.set(t, []);
          byEntity.get(t).push(f);
        }
      }
    }

    // 4. per fact: entity-overlapping candidate pool (cross-fact), run the real method
    let processed = 0;
    for (const f of facts) {
      const seen = new Set([f.id]);
      const cands = [];
      for (const t of (f.tags || [])) {
        if (!(typeof t === 'string' && t.startsWith('entity:'))) continue;
        for (const c of (byEntity.get(t) || [])) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          cands.push(c);
          if (cands.length >= CAND_CAP) break;
        }
        if (cands.length >= CAND_CAP) break;
      }
      if (!cands.length) continue;
      const r = await detect.call(ctx, f, cands, { store, strictMode: true, maxResults: 5 });
      counts.contradicts += r.contradicts;
      counts.updates += r.updates;
      counts.extends += r.extends;
      if (++processed % 200 === 0) console.log(`  …${processed}/${facts.length} facts`);
    }

    console.log(`\n${COMMIT ? 'COMMITTED' : 'DRY-RUN (no writes)'} — project ${projectId.slice(0, 8)}`);
    console.log(`  Contradicts: ${counts.contradicts}`);
    console.log(`  Updates:     ${counts.updates}  (each flips an older fact is_latest=false)`);
    console.log(`  Extends:     ${counts.extends}`);
    console.log(`  total typed edges: ${counts.contradicts + counts.updates + counts.extends}`);
    if (!COMMIT) console.log('  → re-run with --commit to apply');
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => { console.error('backfill failed:', e.message); process.exit(1); });
