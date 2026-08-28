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
import { orgIsRemote, amrWrite, amrAddEdge } from '../vector/mneme/driver.js';

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
  // OWNER REQUIREMENT: filename + creation date are MANDATORY on every entity, so an entity row
  // can always answer "which document did this come from, and when did we first see it". Passed in
  // rather than derived here because only the ingestion path knows the upload's real filename.
  sourceMeta = null,   // { filename, documentId, seenAt }
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
  // Hoisted to FUNCTION scope. This was `const allow` inside the `if` below, and the per-entity kind
  // check further down referenced it — a ReferenceError at RUNTIME ("allow is not defined") that
  // `node --check` cannot see, swallowed by the outer catch as
  // "[canonical-entities] batch failed: allow is not defined". Entity linking was silently dead:
  // 5 batches failed on one upload and 0 entities were persisted.
  // Default is the code taxonomy, so an unrecognised per-entity kind still falls back instead of
  // fragmenting the registry; an org ontology narrows it further when configured.
  let allowedKinds = ENTITY_TAXONOMY;
  try {
    const onto = await _loadOrgOntology(prisma, organizationId);
    if (onto?.enabled && Array.isArray(onto.approvedEntityTypes) && onto.approvedEntityTypes.length) {
      allowedKinds = new Set(onto.approvedEntityTypes.map((t) => String(t).toLowerCase()));
      if (!allowedKinds.has(entityKind)) entityKind = allowedKinds.has('concept') ? 'concept' : [...allowedKinds][0];
    }
  } catch { /* ontology is best-effort; never block entity persistence */ }
  if ((process.env.CANONICAL_ENTITY_PERSIST || 'true').toLowerCase() === 'false') return out;

  try {
    const resolver = new EntityResolver({ prisma });

    // slug → { name (first surface form), memoryIds: [] }
    const bySlug = new Map();
    for (const item of items) {
      if (!item?.memoryId || !Array.isArray(item.entities)) continue;
      for (const rawItem of item.entities.slice(0, MAX_ENTITIES_PER_MEMORY)) {
        // PER-ENTITY KIND. `entityKind` was one namespace for the WHOLE call, so every row the
        // extractor produced landed as entity_kind='entity' — the taxonomy and normalizeEntityKind()
        // existed here, but ingestion had no way to say that one name is a person and another a
        // standard. An entity may now arrive as a bare string (unchanged behaviour) or as
        // {name, kind}; an unrecognised kind falls back to the call-level namespace rather than
        // minting a new one, so a bad kind cannot fragment the registry.
        const raw = typeof rawItem === 'string' ? rawItem : (rawItem && typeof rawItem.name === 'string' ? rawItem.name : null);
        if (typeof raw !== 'string' || !raw.trim()) continue;
        const perKind = (rawItem && typeof rawItem === 'object' && rawItem.kind)
          ? normalizeEntityKind(rawItem.kind) : null;
        const kindForRow = (perKind && allowedKinds.has(perKind)) ? perKind : entityKind;
        const slug = normalizeEntity(raw);
        if (!slug) continue; // junk/generic names never become canonical entities
        // Key by (slug, kind): the same surface form under two kinds is two identities, which is the
        // whole point of typing. Same slug + same kind still dedupes exactly as before.
        const bucket = `${kindForRow}::${slug}`;
        let entry = bySlug.get(bucket);
        if (!entry) {
          if (bySlug.size >= MAX_UNIQUE_ENTITIES_PER_BATCH) continue;
          entry = { name: raw.trim(), memoryIds: [], kind: kindForRow, slug };
          bySlug.set(bucket, entry);
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
    // Kinds actually used by this batch (plus the call-level default), so the reuse prepass covers
    // exactly what we are about to resolve.
    const _kindsInBatch = [...new Set([entityKind, ...[...bySlug.values()].map((e) => e.kind).filter(Boolean)])];
    const existingBySlug = new Map();
    try {
      // PAGE THE WHOLE REGISTRY. This was a single `take: 500` with no orderBy, which is a
      // silent cap: org 1380251c holds 784 canonical entities of one kind, so ~36% of the
      // registry was invisible to the reuse prepass and WHICH 500 you got was arbitrary.
      // Any entity outside the slice fell through to EntityResolver, scored 0.93 exact
      // (< AUTO_LINK_FLOOR), and went to the review queue — logging
      // "+0 entities, 0 links, 1 queued for review" while the graph stopped growing.
      // A cap that changes behaviour without saying so is the defect class this repo keeps
      // shipping, so the ceiling is explicit, env-tunable, and WARNS when it truncates.
      const _pageSize = 1000;
      const _ceiling = Math.max(_pageSize, Number(process.env.ENTITY_REGISTRY_MAX || 20000));
      const registry = [];
      let _cursor = null;
      for (;;) {
        const page = await prisma.canonicalEntity.findMany({
          // Query EVERY kind present in this batch, not just the call-level namespace. With
          // per-entity kinds a 'person' row would never be found in a cache built only from
          // 'entity' rows, so every typed entity would miss the reuse prepass, fall through to the
          // resolver, score 0.93 exact (< AUTO_LINK_FLOOR) and land in the review queue — the exact
          // "+0 entities, 0 links, 1 queued for review" failure the paging fix above was written for.
          where: { organizationId, entityKind: { in: _kindsInBatch } },
          select: { id: true, canonicalName: true, aliases: true, entityKind: true },
          orderBy: { id: 'asc' },
          take: _pageSize,
          ...(_cursor ? { skip: 1, cursor: { id: _cursor } } : {}),
        });
        registry.push(...page);
        if (page.length < _pageSize) break;
        if (registry.length >= _ceiling) {
          logger.warn?.(`[canonical-entities] registry TRUNCATED at ${registry.length} of an unknown `
            + `larger total (org ${String(organizationId).slice(0, 8)}, kind ${entityKind}) — entities beyond `
            + `this point will be re-created as duplicates instead of reused. Raise ENTITY_REGISTRY_MAX.`);
          break;
        }
        _cursor = page[page.length - 1].id;
      }
      for (const row of registry) {
        for (const surface of [row.canonicalName, ...(row.aliases || [])]) {
          const slug = normalizeEntity(surface);
          if (!slug) continue;
          // Index the slug AND its diacritic/plural variants, so a NEW encounter of
          // 'wärmepumpen' reuses the existing 'Wärmepumpe' instead of minting a
          // sibling canonical. Without this, only byte-identical slugs reused — the
          // exact fragmentation the 2026-08-03 backfill had to merge (7 losers).
          for (const variant of entityMatchVariants(slug)) {
            // Keyed by kind::variant to match the lookup below. Two different kinds sharing a
            // surface form are two identities, so they must not collide into AMBIGUOUS.
            const key = `${row.entityKind}::${variant}`;
            const seen = existingBySlug.get(key);
            if (seen && seen !== row.id) existingBySlug.set(key, 'AMBIGUOUS');
            else if (!seen) existingBySlug.set(key, row.id);
          }
        }
      }
    } catch (err) {
      logger.warn?.(`[canonical-entities] registry prefetch failed: ${err.message}`);
    }

    // Merge, never overwrite: an entity seen in a second document ACCUMULATES filenames and keeps the
  // EARLIEST first_seen_at. Applied to reused entities too — otherwise only brand-new entities would
  // carry provenance and the requirement would silently hold for a minority of rows.
  const stampSource = async (entityId) => {
    if (!entityId || entityId === 'AMBIGUOUS' || !sourceMeta?.filename) return;
    try {
      const row = await prisma.canonicalEntity.findUnique({ where: { id: entityId }, select: { metadata: true } });
      const md = (row?.metadata && typeof row.metadata === 'object') ? { ...row.metadata } : {};
      const files = Array.isArray(md.source_filenames) ? [...md.source_filenames] : [];
      if (!files.includes(sourceMeta.filename)) files.push(sourceMeta.filename);
      const docs = Array.isArray(md.source_document_ids) ? [...md.source_document_ids] : [];
      if (sourceMeta.documentId && !docs.includes(sourceMeta.documentId)) docs.push(sourceMeta.documentId);
      const seen = sourceMeta.seenAt || new Date().toISOString().slice(0, 10);
      await prisma.canonicalEntity.update({
        where: { id: entityId },
        data: {
          metadata: {
            ...md,
            source_filenames: files.slice(-25),
            source_document_ids: docs.slice(-25),
            first_seen_at: md.first_seen_at && md.first_seen_at <= seen ? md.first_seen_at : seen,
            last_seen_at: seen,
          },
        },
      });
    } catch (e) { logger.warn?.(`[canonical-entities] source stamp failed for ${entityId}: ${e.message}`); }
  };

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
      // ── Entity residency: mirror into the org's .amr slot ────────────────────────────────
      // canonical_entities is a CENTRAL table with no per-org equivalent, so for an .amr tenant
      // the memories lived in their own file while the ENTITY NAMES sat in our database. That is
      // a residency gap, not a tidiness one: "your memory is one file you own" was not true of
      // the entity graph.
      //
      // The entity becomes a layer-4 record (metadata, structurally non-recallable — see
      // layers.mjs) and each link becomes the shard's own `Mentions` edge, which is exactly what
      // memory→entity means. No new edge type and no new route: the slot already models this.
      //
      // Best-effort and last: Postgres above stays authoritative and nothing reads the shard copy
      // yet, so a failure here must never cost a link the user would otherwise have.
      try {
        if (!orgIsRemote(organizationId)) return;
        const ent = await prisma.canonicalEntity.findUnique({
          where: { id: entityId },
          // Prisma field names verified against schema.prisma: the type field is `entityKind`
          // (@map entity_kind) and `normalizedName` is the slug the entity lanes already match
          // on. `entityType` does not exist — selecting it throws, and the catch below would
          // have swallowed that into a silent "no entities in the slot".
          select: { id: true, canonicalName: true, entityKind: true, normalizedName: true, aliases: true },
        }).catch(() => null);
        if (!ent) return;
        await amrWrite(organizationId, {
          id: ent.id,
          content: ent.canonicalName || null,
          title: ent.canonicalName || null,
          layer: 'entity',
          memoryType: 'canonical_entity',
          // Carry the slug the hop-0 lane already matches on, so an in-slot entity is reachable
          // by the same key the tag path uses.
          tags: [`entity-slug:${ent.normalizedName || normalizeEntity(ent.canonicalName || '')}`],
          metadata: { entity_kind: ent.entityKind || null, aliases: Array.isArray(ent.aliases) ? ent.aliases : [] },
        }, null);
        for (const memoryId of memoryIds) {
          await amrAddEdge({ fromId: memoryId, toId: ent.id, type: 'Mentions', confidence: confidence ?? 1.0,
            metadata: { entity_projection: true, canonical_entity_id: ent.id },
            createdBy: 'canonical-entity-persister', orgId: organizationId });
        }
      } catch (e) {
        logger.warn?.(`[canonical-entities] shard mirror failed for ${entityId}: ${e.message} `
          + '— Postgres links are authoritative and unaffected');
      }
    };

    // Serial per unique name: exact slug → direct reuse; otherwise resolve
    // once via the resolver (create / fuzzy-review), then fan links out.
    for (const [, entry] of bySlug) {
      // bySlug is keyed `kind::slug` now that kinds are per-entity, so the real slug and kind come
      // off the ENTRY. Reading the map key here would have looked up "person::acme" in a cache keyed
      // by plain slugs — every exact-reuse lookup would silently miss and re-resolve.
      const slug = entry.slug;
      const known = existingBySlug.get(`${entry.kind || entityKind}::${slug}`);
      if (known && known !== 'AMBIGUOUS') {
        await linkAll(known, entry.memoryIds, 1.0);
        await stampSource(known);
        continue;
      }
      const [firstMemoryId, ...restMemoryIds] = entry.memoryIds;
      let results;
      try {
        results = await resolver.resolveAndLink({
          memoryId: firstMemoryId,
          organizationId,
          role: 'mentioned',
          candidates: [{
            name: entry.name,
            kind: entry.kind || entityKind,
            // Stored verbatim on CREATE by entity-resolver; stampSource below covers reuse.
            metadata: sourceMeta?.filename ? {
              source_filenames: [sourceMeta.filename],
              ...(sourceMeta.documentId ? { source_document_ids: [sourceMeta.documentId] } : {}),
              first_seen_at: sourceMeta.seenAt || new Date().toISOString().slice(0, 10),
              last_seen_at: sourceMeta.seenAt || new Date().toISOString().slice(0, 10),
            } : {},
          }],
        });
      } catch (err) {
        out.skipped += entry.memoryIds.length;
        logger.warn?.(`[canonical-entities] resolve failed for "${entry.name}": ${err.message}`);
        continue;
      }
      const r = results?.[0];
      if (!r) { out.skipped += entry.memoryIds.length; continue; }
      if (r.entityId && r.action !== 'created') await stampSource(r.entityId);
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
