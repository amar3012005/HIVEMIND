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
import {normalizeEntity, entityMatchVariants } from './entity-normalize.js';

// V5 Phase 10 — cached per-org ontology loader (opt-in enterprise config).
const _ontoCache = new Map(); // orgId → { value, expiresAt }
async function _loadOrgOntology(prisma, orgId) {
  if (!prisma?.orgOntology || !orgId) return null;
  const hit = _ontoCache.get(orgId);
  const now = Date.now();
  if (hit && hit.expiresAt > now) return hit.value;
  let value = null;
  try { value = await prisma.orgOntology.findUnique({ where: { orgId } }); } catch { value = null; }
  _ontoCache.set(orgId, { value, expiresAt: now + 300000 });
  return value;
}


const MAX_ENTITIES_PER_MEMORY = 8;
const MAX_UNIQUE_ENTITIES_PER_BATCH = 64;

// Canonical V5 entity taxonomy — the code-enforced allow-list (previously the
// type set lived only in the extractor prompt, so entityKind was free-form and
// defaulted to the meaningless 'entity'). Unknown/synonym kinds normalize into
// the taxonomy; anything unrecognized falls back to 'concept'.
export const ENTITY_TAXONOMY = new Set([
  'person', 'organization', 'product', 'project', 'document',
  'location', 'system', 'technology', 'standard', 'concept',
]);
// Synonym → taxonomy map. NOTE: 'entity' (the legacy default) is deliberately
// NOT remapped — the existing registry is full of entityKind='entity' rows, and
// remapping the lookup key would strand them and create duplicates. Migration-safe
// rule: map recognized synonyms into the taxonomy; leave 'entity' + unknown kinds
// UNCHANGED (strict bucketing of legacy 'entity' rows needs a registry backfill,
// out of scope for this additive phase).
const ENTITY_KIND_SYNONYMS = {
  company: 'organization', org: 'organization', business: 'organization', corporation: 'organization',
  people: 'person', individual: 'person', user: 'person', contact: 'person',
  place: 'location', geo: 'location', city: 'location', country: 'location',
  tech: 'technology', tool: 'technology',
  software: 'system', service: 'system', app: 'system', platform: 'system',
  file: 'document', doc: 'document', spec: 'standard', specification: 'standard',
  protocol: 'standard', good: 'product', sku: 'product', initiative: 'project',
};
export function normalizeEntityKind(kind) {
  const k = String(kind || '').trim().toLowerCase();
  if (!k) return 'entity';
  if (ENTITY_TAXONOMY.has(k)) return k;
  if (ENTITY_KIND_SYNONYMS[k]) return ENTITY_KIND_SYNONYMS[k];
  return k; // legacy 'entity' + unrecognized kinds pass through unchanged (no fragmentation)
}

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
  // V5: lock entityKind to the canonical taxonomy (was free-form; 'entity'/synonyms
  // fragmented the registry). All registry lookups + creates below use the
  // normalized kind so a re-encounter under a synonym reuses the same entity.
  entityKind = normalizeEntityKind(entityKind);
  // V5 Phase 10: opt-in org ontology. When the org configured approved entity types,
  // constrain the (already-taxonomy-normalized) kind to that allow-list; unknown →
  // 'concept'. Absent/disabled ontology = default behavior (no change). Cached 5 min.
  try {
    const onto = await _loadOrgOntology(prisma, organizationId);
    if (onto?.enabled && Array.isArray(onto.approvedEntityTypes) && onto.approvedEntityTypes.length) {
      const allow = new Set(onto.approvedEntityTypes.map((t) => String(t).toLowerCase()));
      if (!allow.has(entityKind)) entityKind = allow.has('concept') ? 'concept' : [...allow][0];
    }
  } catch { /* ontology is best-effort; never block entity persistence */ }
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
          // Index the slug AND its diacritic/plural variants, so a NEW encounter of
          // 'wärmepumpen' reuses the existing 'Wärmepumpe' instead of minting a
          // sibling canonical. Without this, only byte-identical slugs reused — the
          // exact fragmentation the 2026-08-03 backfill had to merge (7 losers).
          for (const key of entityMatchVariants(slug)) {
            const seen = existingBySlug.get(key);
            if (seen && seen !== row.id) existingBySlug.set(key, 'AMBIGUOUS');
            else if (!seen) existingBySlug.set(key, row.id);
          }
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
