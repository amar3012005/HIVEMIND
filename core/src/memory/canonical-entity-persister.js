// ── Canonical-entity persistence (post-commit ingestion pass) ───────────────
// Turns the extractor's canonical entity NAMES into durable registry rows:
// org-scoped CanonicalEntity records + MemoryEntityLink rows, via
// EntityResolver (exact canonical reuse, fuzzy → review queue, else create).
//
// Design constraints:
//   • Runs AFTER durable memories commit — never inside the ingest lock/tx.
//   • Fire-and-forget: never throws, never delays or fails ingestion.
//   • Exactly-once creation per name per batch: unique names are resolved
//     SERIALLY (first mention wins), remaining memories link to the resolved
//     entity id directly — concurrent facts can't race-create duplicates.
//   • Ambiguous fuzzy matches stay in the EntityResolver review queue; they
//     are NOT auto-merged and the remaining mentions of that name are skipped
//     (a human decides).
//   • `entity:` tags on the memories are untouched — they remain the
//     compatibility/fallback linkage for recall.

import { EntityResolver } from './entity-resolver.js';
import { normalizeEntity } from './entity-normalize.js';

const MAX_ENTITIES_PER_MEMORY = 8;
const MAX_UNIQUE_ENTITIES_PER_BATCH = 64;

/**
 * @param {object} opts
 * @param {object} opts.prisma          Prisma client (needs canonicalEntity/memoryEntityLink)
 * @param {string} opts.organizationId
 * @param {Array<{memoryId: string, entities: string[]}>} opts.items
 * @param {string} [opts.entityKind]    kind namespace for extractor names
 * @param {object} [opts.logger]
 * @returns {Promise<{linked:number, created:number, review:number, skipped:number}>}
 */
export async function persistCanonicalLinks({
  prisma,
  organizationId,
  items = [],
  entityKind = 'entity',
  logger = console,
} = {}) {
  const out = { linked: 0, created: 0, review: 0, skipped: 0 };
  if (!prisma?.canonicalEntity || !prisma?.memoryEntityLink || !organizationId || !items.length) return out;
  if ((process.env.CANONICAL_ENTITY_PERSIST || 'true').toLowerCase() === 'false') return out;

  try {
    const resolver = new EntityResolver({ prisma });

    // slug → { name (first surface form), memoryIds: [] }
    const bySlug = new Map();
    for (const item of items) {
      if (!item?.memoryId || !Array.isArray(item.entities)) continue;
      for (const raw of item.entities.slice(0, MAX_ENTITIES_PER_MEMORY)) {
        if (typeof raw !== 'string' || !raw.trim()) continue;
        const slug = normalizeEntity(raw);
        if (!slug) continue; // junk/generic names never become canonical entities
        let entry = bySlug.get(slug);
        if (!entry) {
          if (bySlug.size >= MAX_UNIQUE_ENTITIES_PER_BATCH) continue;
          entry = { name: raw.trim(), memoryIds: [] };
          bySlug.set(slug, entry);
        }
        if (!entry.memoryIds.includes(item.memoryId)) entry.memoryIds.push(item.memoryId);
      }
    }

    // Exact-reuse pre-pass: extractor names are already canonicalized (one
    // surface form per real-world thing), so slug identity within (org, kind)
    // IS entity identity — the same rule the entity: tag system uses. The
    // EntityResolver's exact-name rule scores 0.93 (< AUTO_LINK_FLOOR 0.95,
    // tuned for Salesforce person/company objects), which would send every
    // re-encounter of a known name to the review queue instead of reusing it.
    // We resolve exact slug matches ourselves and reserve the resolver for
    // genuinely new or ambiguous names.
    const existingBySlug = new Map();
    try {
      const registry = await prisma.canonicalEntity.findMany({
        where: { organizationId, entityKind },
        select: { id: true, canonicalName: true, aliases: true },
        take: 500,
      });
      for (const row of registry) {
        for (const surface of [row.canonicalName, ...(row.aliases || [])]) {
          const slug = normalizeEntity(surface);
          if (!slug) continue;
          const seen = existingBySlug.get(slug);
          if (seen && seen !== row.id) existingBySlug.set(slug, 'AMBIGUOUS');
          else if (!seen) existingBySlug.set(slug, row.id);
        }
      }
    } catch (err) {
      logger.warn?.(`[canonical-entities] registry prefetch failed: ${err.message}`);
    }

    const linkAll = async (entityId, memoryIds, confidence) => {
      for (const memoryId of memoryIds) {
        try {
          await prisma.memoryEntityLink.upsert({
            where: { memoryId_entityId_role: { memoryId, entityId, role: 'mentioned' } },
            update: { confidence },
            create: { memoryId, entityId, role: 'mentioned', confidence },
          });
          out.linked += 1;
        } catch (err) {
          out.skipped += 1;
          logger.warn?.(`[canonical-entities] link failed ${memoryId} → ${entityId}: ${err.message}`);
        }
      }
    };

    // Serial per unique name: exact slug → direct reuse; otherwise resolve
    // once via the resolver (create / fuzzy-review), then fan links out.
    for (const [slug, entry] of bySlug) {
      const known = existingBySlug.get(slug);
      if (known && known !== 'AMBIGUOUS') {
        await linkAll(known, entry.memoryIds, 1.0);
        continue;
      }
      const [firstMemoryId, ...restMemoryIds] = entry.memoryIds;
      let results;
      try {
        results = await resolver.resolveAndLink({
          memoryId: firstMemoryId,
          organizationId,
          role: 'mentioned',
          candidates: [{ name: entry.name, kind: entityKind }],
        });
      } catch (err) {
        out.skipped += entry.memoryIds.length;
        logger.warn?.(`[canonical-entities] resolve failed for "${entry.name}": ${err.message}`);
        continue;
      }
      const r = results?.[0];
      if (!r) { out.skipped += entry.memoryIds.length; continue; }
      if (r.action === 'review') {
        // Ambiguous — queued for human review; do not fan links out for it.
        out.review += 1;
        out.skipped += restMemoryIds.length;
        continue;
      }
      if (r.action === 'created') {
        out.created += 1;
        existingBySlug.set(slug, r.entityId); // later names in this batch reuse it
      }
      out.linked += 1;
      await linkAll(r.entityId, restMemoryIds, r.confidence ?? 1.0);
    }

    if (out.linked || out.created || out.review) {
      logger.info?.(`[canonical-entities] org ${String(organizationId).slice(0, 8)}: +${out.created} entities, ${out.linked} links, ${out.review} queued for review`);
    }
  } catch (err) {
    logger.warn?.(`[canonical-entities] batch failed: ${err.message}`);
  }
  return out;
}
