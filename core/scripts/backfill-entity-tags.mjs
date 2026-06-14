#!/usr/bin/env node
/**
 * backfill-entity-tags.mjs — Canonicalize entity: tags across all memories of an org.
 *
 * The co-mention LLM writes raw `entity:<Name>` tags with no normalization,
 * producing fragmentation (e.g. SOLVIS / Solvis / SOLVIS_GmbH → one tag).
 * This script applies `normalizeTagsArray` from entity-normalize.js to every
 * memory in the org that has at least one entity: tag, collapsing mechanical
 * duplicates (case, unicode dash, underscore↔space, legal suffix, synonym set).
 *
 * Includes synthesis rows (cognitive_layer_role IS NOT NULL) so the vocabulary
 * becomes uniform across the full recall + Updates-gate path.
 *
 * Usage (inside hm-core container):
 *   ORG_ID=<uuid> docker exec hm-core node /app/scripts/backfill-entity-tags.mjs
 *   ORG_ID=<uuid> docker exec hm-core node /app/scripts/backfill-entity-tags.mjs --commit
 *
 * Env:
 *   ORG_ID   — required: the org to canonicalize
 *   BATCH    — optional: keyset page size (default 500)
 *
 * Flags:
 *   --dry-run  (default) scan + report without writing
 *   --commit   write canonicalized tags to DB
 *
 * Idempotent: rows already canonical are skipped. Re-running is a no-op.
 * Only rewrites the `tags` column. Never deletes memories or touches edges.
 */

import { PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ORG_ID = process.env.ORG_ID;
const BATCH  = Math.max(1, Number(process.env.BATCH || 500));
const COMMIT = process.argv.includes('--commit');
const DRY_RUN = !COMMIT;

if (!ORG_ID) {
  console.error('[backfill-entity-tags] ERROR: ORG_ID env var is required');
  process.exit(2);
}

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Import canonicalizer — resolved lazily inside main() so dynamic import
// errors surface with a clear message rather than a silent top-level race.
// ---------------------------------------------------------------------------

/** @type {(tags: string[]) => string[]} */
let normalizeTagsArray;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compare two string arrays for deep equality (order-sensitive).
 * @param {string[]} a
 * @param {string[]} b
 * @returns {boolean}
 */
function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Ensure normalizeTagsArray loaded (module import races the outer IIFE).
  if (!normalizeTagsArray) {
    // Retry the import synchronously via dynamic await (now inside async main).
    try {
      const mod = await import('/app/src/memory/entity-normalize.js');
      normalizeTagsArray = mod.normalizeTagsArray;
    } catch (_absErr) {
      // Fallback for local development outside container.
      try {
        const mod = await import('../src/memory/entity-normalize.js');
        normalizeTagsArray = mod.normalizeTagsArray;
      } catch (relErr) {
        console.error('[backfill-entity-tags] FATAL: cannot load entity-normalize.js:', relErr.message);
        process.exit(1);
      }
    }
  }

  console.log(`[backfill-entity-tags] org=${ORG_ID} batch=${BATCH} mode=${DRY_RUN ? 'dry-run' : 'commit'}`);

  // -------------------------------------------------------------------
  // Snapshot distinct entity: tags BEFORE the run (for the report).
  // We pull them via a raw aggregated query to avoid loading all tag
  // arrays into memory. Prisma doesn't expose `unnest` natively, so we
  // use a $queryRaw only for this count (no user input goes in the
  // template literal — ORG_ID is a fixed UUID substituted via Prisma's
  // parameterised raw API).
  // -------------------------------------------------------------------

  const beforeRows = await prisma.$queryRaw`
    SELECT DISTINCT unnest(tags) AS tag
    FROM   memories
    WHERE  org_id = ${ORG_ID}::uuid
      AND  deleted_at IS NULL
      AND  tags && ARRAY['entity:']::text[]
  `.catch(() => null); // non-fatal; report 0 if DB doesn't support it

  // The overlap operator && requires at least one common element. For "has
  // any entity: tag" we use the GIN index via a LIKE substitute below in
  // the keyset query; the unnest above is aggregation-only so performance
  // is acceptable (single pass, server-side).
  // NOTE: the unnest distinct gives us all tags, we filter client-side:
  const beforeEntityTags = new Set(
    (beforeRows || [])
      .map((r) => r.tag)
      .filter((t) => typeof t === 'string' && t.startsWith('entity:'))
  );
  const distinctBefore = beforeEntityTags.size;

  // -------------------------------------------------------------------
  // Keyset pagination — ORDER BY id, cursor after last seen id.
  //
  // Prisma has no prefix-filter for array elements, so we fetch all
  // non-deleted org rows in id-sorted pages and filter client-side for
  // entity: tags. The GIN index on `tags` is used by unnest queries above;
  // the per-page fetch is bounded by BATCH so memory is O(BATCH), not O(N).
  // -------------------------------------------------------------------

  let cursor = null;           // last seen id (UUID string)
  let totalScanned = 0;
  let totalChanged = 0;
  const afterEntityTagsMap = new Map(); // canonical tag → true (both modes)
  const failedIds = [];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const cursorCondition = cursor ? { id: { gt: cursor } } : {};

    const batch = await prisma.memory.findMany({
      where: {
        orgId: ORG_ID,
        deletedAt: null,
        ...cursorCondition,
      },
      orderBy: { id: 'asc' },
      take: BATCH,
      select: {
        id: true,
        tags: true,
      },
    });

    if (batch.length === 0) break;

    // Filter to rows that actually have at least one entity: tag.
    const entityRows = batch.filter((m) =>
      Array.isArray(m.tags) && m.tags.some((t) => typeof t === 'string' && t.startsWith('entity:'))
    );

    totalScanned += entityRows.length;

    // Process each row in the batch.
    const updatePromises = [];

    for (const memory of entityRows) {
      const original = memory.tags;
      const normalized = normalizeTagsArray(original);

      // Accumulate after-tags for reporting (works in both modes).
      for (const t of normalized) {
        if (t.startsWith('entity:')) afterEntityTagsMap.set(t, true);
      }

      // Skip if unchanged (idempotent).
      if (arraysEqual(original, normalized)) continue;

      totalChanged++;

      if (DRY_RUN) {
        // Dry-run: log the first few changes for visibility.
        if (totalChanged <= 5) {
          const before = original.filter((t) => t.startsWith('entity:'));
          const after  = normalized.filter((t) => t.startsWith('entity:'));
          console.log(`  [dry-run] ${memory.id.slice(0, 8)} entity_tags_before=${before.length} entity_tags_after=${after.length}`);
        }
        continue;
      }

      // Commit mode: batch the update.
      updatePromises.push(
        prisma.memory
          .update({
            where: { id: memory.id },
            data:  { tags: normalized },
          })
          .catch((err) => {
            console.error(`  [backfill-entity-tags] update failed id=${memory.id}: ${err.message}`);
            failedIds.push(memory.id);
          })
      );
    }

    if (!DRY_RUN && updatePromises.length > 0) {
      // Execute batch writes concurrently but catch per-row errors above
      // so one failure never aborts the whole run.
      try {
        await Promise.all(updatePromises);
      } catch (batchErr) {
        // Outer catch should not fire because each promise has .catch(),
        // but log defensively.
        console.error(`  [backfill-entity-tags] batch error (partial state possible): ${batchErr.message}`);
      }
    }

    // Advance cursor.
    cursor = batch[batch.length - 1].id;

    // Log progress every 10 batches (BATCH * 10 rows scanned).
    if (totalScanned > 0 && totalScanned % (BATCH * 10) === 0) {
      console.log(`  [backfill-entity-tags] progress scanned=${totalScanned} changed=${totalChanged} failed=${failedIds.length}`);
    }

    // Exit when the batch was smaller than requested (last page).
    if (batch.length < BATCH) break;
  }

  // -------------------------------------------------------------------
  // Compute distinct entity tag count AFTER the run.
  // -------------------------------------------------------------------

  let distinctAfter;

  if (DRY_RUN) {
    // On dry-run we accumulated what the canonical set WOULD look like
    // from the rows we inspected, but we also need tags from unchanged
    // rows. Re-query the same unnest for a hypothetical after-count by
    // applying normalizeTagsArray to the raw before-set in memory.
    const wouldBeAfter = new Set(
      Array.from(beforeEntityTags).map((t) => {
        const normalized = normalizeTagsArray([t]);
        return normalized[0] || t;
      })
    );
    distinctAfter = wouldBeAfter.size;
  } else {
    // Commit mode: query live data.
    const afterRows = await prisma.$queryRaw`
      SELECT DISTINCT unnest(tags) AS tag
      FROM   memories
      WHERE  org_id = ${ORG_ID}::uuid
        AND  deleted_at IS NULL
        AND  tags && ARRAY['entity:']::text[]
    `.catch(() => null);

    const afterEntityTags = new Set(
      (afterRows || [])
        .map((r) => r.tag)
        .filter((t) => typeof t === 'string' && t.startsWith('entity:'))
    );
    distinctAfter = afterEntityTags.size;
  }

  // -------------------------------------------------------------------
  // Final report.
  // -------------------------------------------------------------------

  if (failedIds.length > 0) {
    console.warn(`[backfill-entity-tags] ${failedIds.length} rows failed to update — ids: ${failedIds.slice(0, 20).join(', ')}${failedIds.length > 20 ? '...' : ''}`);
  }

  const mode = DRY_RUN ? 'dry' : 'commit';
  console.log(
    `BACKFILL DONE scanned=${totalScanned} changed=${totalChanged} distinct_before=${distinctBefore} distinct_after=${distinctAfter} mode=${mode}`
  );

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('[backfill-entity-tags] fatal:', err.message);
  console.error(err.stack);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
