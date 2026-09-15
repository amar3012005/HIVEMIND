// ── Canonical-entity persistence (post-commit ingestion pass) ───────────────
// Turns the extractor's canonical entity NAMES into durable registry rows:
// org-scoped CanonicalEntity records + MemoryEntityLink rows, via
// EntityResolver (exact canonical reuse, fuzzy → review queue, else create).
//
// Design constraints:
//   • Runs AFTER durable memories commit — never inside the ingest lock/tx.
//   • Runs outside the ingest transaction, but remote projection failures are
//     reported so a job cannot claim complete graph coverage prematurely.
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
import { orgUsesExternalAgent, amrWrite, amrAddEdge, amrUpdateTags, amrHydrateMemories } from '../vector/mneme/driver.js';
import crypto from 'node:crypto';

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


const MAX_ENTITIES_PER_RESOURCE = 25;
const MAX_UNIQUE_ENTITIES_PER_BATCH = 128;

// Canonical V5 entity taxonomy — the code-enforced allow-list (previously the
// type set lived only in the extractor prompt, so entityKind was free-form and
// defaulted to the meaningless 'entity'). Unknown/synonym kinds normalize into
// the taxonomy; anything unrecognized falls back to 'concept'.
export const ENTITY_TAXONOMY = new Set([
  'person', 'organization', 'product', 'project', 'document',
  'location', 'system', 'technology', 'standard', 'concept', 'topic', 'event',
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
 * @param {Array<{memoryId?: string, resourceType?: 'memory'|'document'|'segment', resourceId?: string,
 *   userId?: string, scopeType?: string, scopeId?: string, entities: Array<string|object>}>} opts.items
 * @param {string} [opts.entityKind]    kind namespace for extractor names
 * @param {boolean} [opts.replaceExisting] Replace prior links for each supplied resource
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
  replaceExisting = false,
  logger = console,
} = {}) {
  const out = { linked: 0, created: 0, review: 0, skipped: 0, projectionFailed: 0, writeFailed: 0 };
  if (!prisma?.canonicalEntity || (!prisma?.resourceEntityLink && !prisma?.memoryEntityLink)
      || !organizationId || !items.length) return out;
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
  try {
    const resolver = new EntityResolver({ prisma });
    // Only a customer-hosted agent is remote for entity projection purposes.
    // A managed `local:` AMR shard keeps its memory data in AMR but must write
    // canonical entity links and receipts to PostgreSQL for authorized search.
    const remote = orgUsesExternalAgent(organizationId);

    // Some older in-process callers know only the memory id. Never turn that
    // omission into organization-wide visibility. Hydrate the authoritative
    // scope from PostgreSQL once for the bounded batch; if the row cannot be
    // resolved, fail closed to personal scope rather than exposing it broadly.
    const memoryContextById = new Map();
    const memoryIdsNeedingContext = [...new Set(items
      .filter((item) => (item?.resourceType || (item?.memoryId ? 'memory' : null)) === 'memory'
        && (item?.resourceId || item?.memoryId)
        && (!item.userId || !item.scopeType))
      .map((item) => item.resourceId || item.memoryId))];
    if (!remote && memoryIdsNeedingContext.length > 0 && prisma.memory?.findMany) {
      try {
        const rows = await prisma.memory.findMany({
          where: { id: { in: memoryIdsNeedingContext }, orgId: organizationId },
          select: {
            id: true, userId: true, scope: true, primaryTeamId: true, projectId: true,
          },
        });
        for (const row of rows) {
          const scopeType = String(row.scope || 'personal');
          memoryContextById.set(row.id, {
            userId: row.userId || null,
            scopeType,
            scopeId: scopeType === 'team'
              ? (row.primaryTeamId || null)
              : scopeType === 'project' ? (row.projectId || null) : null,
          });
        }
      } catch (err) {
        logger.warn?.(`[canonical-entities] memory scope hydration failed: ${err.message}`);
      }
    }

    // (kind, slug) → one identity candidate plus every resource occurrence.
    // Occurrence metadata belongs on ResourceEntityLink, never in a capped
    // source-history array on the entity itself.
    const bySlug = new Map();
    const resourceTargets = new Map();
    const expectedLinkKeys = new Map();
    const expectedEntityIds = new Map();
    for (const item of items) {
      const resourceType = item?.resourceType || (item?.memoryId ? 'memory' : null);
      const resourceId = item?.resourceId || item?.memoryId || null;
      if (!['memory', 'document', 'segment'].includes(resourceType) || !resourceId || !Array.isArray(item.entities)) continue;
      const resourceKey = `${resourceType}:${resourceId}`;
      resourceTargets.set(resourceKey, { resourceType, resourceId });
      expectedLinkKeys.set(resourceKey, new Set());
      expectedEntityIds.set(resourceKey, new Set());
      const memoryContext = resourceType === 'memory' ? memoryContextById.get(resourceId) : null;
      for (const rawItem of item.entities.slice(0, MAX_ENTITIES_PER_RESOURCE)) {
        // PER-ENTITY KIND. `entityKind` was one namespace for the WHOLE call, so every row the
        // extractor produced landed as entity_kind='entity' — the taxonomy and normalizeEntityKind()
        // existed here, but ingestion had no way to say that one name is a person and another a
        // standard. An entity may now arrive as a bare string (unchanged behaviour) or as
        // {name, kind}; an unrecognised kind falls back to the call-level namespace rather than
        // minting a new one, so a bad kind cannot fragment the registry.
        const raw = typeof rawItem === 'string' ? rawItem : (rawItem && typeof rawItem.name === 'string' ? rawItem.name : null);
        if (typeof raw !== 'string' || !raw.trim()) continue;
        const perKindValue = rawItem && typeof rawItem === 'object'
          ? (rawItem.kind || rawItem.type) : null;
        const perKind = perKindValue ? normalizeEntityKind(perKindValue) : null;
        const kindForRow = (perKind && allowedKinds.has(perKind)) ? perKind : entityKind;
        const slug = normalizeEntity(raw);
        if (!slug) continue; // junk/generic names never become canonical entities
        // Key by (slug, kind): the same surface form under two kinds is two identities, which is the
        // whole point of typing. Same slug + same kind still dedupes exactly as before.
        const bucket = `${kindForRow}::${slug}`;
        let entry = bySlug.get(bucket);
        if (!entry) {
          if (bySlug.size >= MAX_UNIQUE_ENTITIES_PER_BATCH) continue;
          entry = { name: raw.trim(), resources: [], kind: kindForRow, slug, candidate: rawItem };
          bySlug.set(bucket, entry);
        }
        if (!entry.resources.some((resource) => resource.resourceType === resourceType && resource.resourceId === resourceId
          && resource.startOffset === (rawItem?.startOffset ?? null))) {
          entry.resources.push({
            resourceType,
            resourceId,
            memoryId: resourceType === 'memory' ? resourceId : null,
            userId: item.userId || memoryContext?.userId || null,
            scopeType: item.scopeType || memoryContext?.scopeType
              || (resourceType === 'memory' ? 'personal' : 'organization'),
            scopeId: item.scopeId || memoryContext?.scopeId || null,
            mentionText: (rawItem && typeof rawItem === 'object' && rawItem.mentionText)
              ? String(rawItem.mentionText).slice(0, 500) : raw.trim().slice(0, 500),
            startOffset: Number.isInteger(rawItem?.startOffset) ? rawItem.startOffset : null,
            endOffset: Number.isInteger(rawItem?.endOffset) ? rawItem.endOffset : null,
            role: String(rawItem?.role || 'mentioned').slice(0, 40),
            confidence: Number.isFinite(rawItem?.confidence) ? Math.max(0, Math.min(1, rawItem.confidence)) : 1,
            provenance: rawItem?.provenance || item.provenance || sourceMeta || {},
            knownAt: item.knownAt || sourceMeta?.seenAt || new Date(),
          });
        }
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
    // Never scan the registry. At millions of resources the canonical-name and
    // GIN search-term indexes must resolve only this batch's bounded candidates.
    for (const entry of bySlug.values()) {
      try {
        const matches = await prisma.canonicalEntity.findMany({
          where: {
            organizationId,
            entityKind: entry.kind || entityKind,
            OR: [
              { canonicalName: { equals: entry.name, mode: 'insensitive' } },
              { aliases: { has: entry.name } },
              { searchTerms: { hasSome: entityMatchVariants(entry.slug) } },
            ],
          },
          select: { id: true },
          orderBy: { id: 'asc' },
          take: 2,
        });
        existingBySlug.set(`${entry.kind || entityKind}::${entry.slug}`,
          matches.length === 1 ? matches[0].id : matches.length > 1 ? 'AMBIGUOUS' : null);
      } catch (err) {
        logger.warn?.(`[canonical-entities] indexed lookup failed for ${entry.slug}: ${err.message}`);
      }
    }

    // Merge, never overwrite: an entity seen in a second document ACCUMULATES filenames and keeps the
  // EARLIEST first_seen_at. Applied to reused entities too — otherwise only brand-new entities would
  // carry provenance and the requirement would silently hold for a minority of rows.
  const stampSource = async (entityId) => {
    if (!entityId || entityId === 'AMBIGUOUS') return;
    try {
      const row = await prisma.canonicalEntity.findUnique({ where: { id: entityId }, select: { metadata: true } });
      const md = (row?.metadata && typeof row.metadata === 'object') ? { ...row.metadata } : {};
      const seen = sourceMeta?.seenAt || new Date().toISOString().slice(0, 10);
      const sourceFilenames = [...new Set([
        ...(Array.isArray(md.source_filenames) ? md.source_filenames : []),
        ...(sourceMeta?.filename ? [String(sourceMeta.filename)] : []),
      ])].slice(-100);
      const sourceDocumentIds = [...new Set([
        ...(Array.isArray(md.source_document_ids) ? md.source_document_ids : []),
        ...(sourceMeta?.documentId ? [String(sourceMeta.documentId)] : []),
      ])].slice(-100);
      await prisma.canonicalEntity.update({
        where: { id: entityId },
        data: {
          metadata: {
            ...md,
            source_filenames: sourceFilenames,
            source_document_ids: sourceDocumentIds,
            first_seen_at: md.first_seen_at && md.first_seen_at <= seen ? md.first_seen_at : seen,
            last_seen_at: seen,
          },
        },
      });
    } catch (e) { logger.warn?.(`[canonical-entities] source stamp failed for ${entityId}: ${e.message}`); }
  };

  const linkAll = async (entityId, resources, confidence, entitySlug) => {
      const memoryIds = resources.filter((resource) => resource.resourceType === 'memory').map((resource) => resource.resourceId);
      if (remote) {
        try {
          const ent = await prisma.canonicalEntity.findUnique({
            where: { id: entityId },
            select: { id: true, canonicalName: true, entityKind: true, normalizedName: true, aliases: true },
          });
          if (!ent) throw new Error('canonical entity row is unavailable');
          const written = await amrWrite(organizationId, {
            id: ent.id,
            content: ent.canonicalName || null,
            title: ent.canonicalName || null,
            layer: 'entity',
            memoryType: 'canonical_entity',
            tags: [`entity-slug:${ent.normalizedName || normalizeEntity(ent.canonicalName || '')}`],
            metadata: { entity_kind: ent.entityKind || null, aliases: Array.isArray(ent.aliases) ? ent.aliases : [] },
          }, null);
          if (!written) throw new Error('remote canonical entity projection was not acknowledged');
        } catch (err) {
          out.skipped += memoryIds.length;
          out.projectionFailed += memoryIds.length;
          logger.warn?.(`[canonical-entities] entity mirror failed ${entityId}: ${err.message}`);
          return;
        }
      }
      for (const resource of resources) {
        const memoryId = resource.resourceType === 'memory' ? resource.resourceId : null;
        try {
          if (remote) {
            if (!memoryId) continue;
            const tag = `entity:${entitySlug}`;
            const hydrated = await amrHydrateMemories(organizationId, [memoryId]);
            const memory = Array.isArray(hydrated) ? hydrated.find((row) => row?.id === memoryId) : null;
            if (!memory) throw new Error('remote memory could not be hydrated for entity projection');
            const tags = [...new Set([...(Array.isArray(memory.tags) ? memory.tags : []), tag])];
            const tagUpdated = await amrUpdateTags(organizationId, memoryId, tags, { requireAck: true });
            if (!tagUpdated) throw new Error('remote memory entity-tag projection was not acknowledged');
            const edgeAdded = await amrAddEdge({ fromId: memoryId, toId: entityId, type: 'Mentions', confidence: confidence ?? 1.0,
              metadata: { entity_projection: true, canonical_entity_id: entityId },
              createdBy: 'canonical-entity-persister', orgId: organizationId });
            if (!edgeAdded) throw new Error('remote memory entity-edge projection was not acknowledged');
          } else {
            if (prisma.resourceEntityLink) {
              // A Memory is already a distilled semantic unit, so its link to
              // one canonical entity/role is singular.  Entity tags and typed
              // extractor metadata may describe the same entity with different
              // surface text/offsets; those must converge on the same link.
              // Evidence documents/segments retain occurrence-level offsets.
              const linkIdentity = resource.resourceType === 'memory'
                ? [organizationId, 'memory', resource.resourceId, entityId, resource.role]
                : [
                    organizationId, resource.resourceType, resource.resourceId, entityId,
                    resource.role, resource.startOffset ?? '', resource.endOffset ?? '', resource.mentionText || '',
                  ];
              const linkKey = crypto.createHash('sha256').update(linkIdentity.join('|')).digest('hex');
              await prisma.resourceEntityLink.upsert({
                where: { organizationId_linkKey: { organizationId, linkKey } },
                update: {
                  confidence: resource.confidence ?? confidence,
                  provenance: resource.provenance || {},
                  knownAt: new Date(resource.knownAt),
                },
                create: {
                  organizationId, entityId, resourceType: resource.resourceType,
                  resourceId: resource.resourceId, userId: resource.userId,
                  scopeType: resource.scopeType, scopeId: resource.scopeId,
                  mentionText: resource.mentionText, startOffset: resource.startOffset,
                  endOffset: resource.endOffset, role: resource.role,
                  confidence: resource.confidence ?? confidence,
                  provenance: resource.provenance || {}, knownAt: new Date(resource.knownAt), linkKey,
                },
              });
              const resourceKey = `${resource.resourceType}:${resource.resourceId}`;
              expectedLinkKeys.get(resourceKey)?.add(linkKey);
              expectedEntityIds.get(resourceKey)?.add(entityId);
            }
            // Temporary compatibility projection for existing recall readers.
            if (memoryId && prisma.memoryEntityLink) {
              await prisma.memoryEntityLink.upsert({
                where: { memoryId_entityId_role: { memoryId, entityId, role: resource.role } },
                update: { confidence: resource.confidence ?? confidence },
                create: { memoryId, entityId, role: resource.role, confidence: resource.confidence ?? confidence },
              });
            }
          }
          out.linked += 1;
        } catch (err) {
          out.skipped += 1;
          if (remote) out.projectionFailed += 1;
          else out.writeFailed += 1;
          logger.warn?.(`[canonical-entities] link failed ${resource.resourceType}:${resource.resourceId} → ${entityId}: ${err.message}`);
        }
      }
  };

  // Preserve one canonical identity per normalized name, but do not preserve a
  // known-wrong low-specificity label forever.  A source-grounded correction
  // (for example, "Atlas Dispatch is the operating system" after an LLM called
  // it a person) may upgrade only an older generic/person/topic/concept row.
  // Ordinary model predictions never take this path, so a speculative label
  // cannot rewrite an established canonical identity.
  const upgradeSourceGroundedType = async (entityId, entry) => {
    if (entry?.candidate?.typeEvidence !== 'source_grounded' || !entry?.kind) return;
    try {
      const current = await prisma.canonicalEntity.findUnique({
        where: { id: entityId }, select: { entityKind: true },
      });
      if (!current || !new Set(['person', 'entity', 'topic', 'concept']).has(current.entityKind)
          || current.entityKind === entry.kind) return;
      await prisma.canonicalEntity.update({
        where: { id: entityId }, data: { entityKind: entry.kind },
      });
    } catch (error) {
      // Type correction is an enrichment; never make a durable entity link
      // fail because a concurrent registry update lost a race.
      logger.warn?.(`[canonical-entities] source-grounded type upgrade failed for ${entry.name}: ${error.message}`);
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
        await upgradeSourceGroundedType(known, entry);
        await linkAll(known, entry.resources, 1.0, slug);
        await stampSource(known);
        continue;
      }
      const firstMemory = entry.resources.find((resource) => resource.memoryId);
      let results;
      try {
        results = await resolver.resolveAndLink({
          memoryId: firstMemory?.memoryId || entry.resources[0]?.resourceId,
          organizationId,
          role: 'mentioned',
          candidates: [{
            name: entry.name,
            kind: entry.kind || entityKind,
            email: entry.candidate?.email || null,
            externalRefs: entry.candidate?.externalRefs || {},
            // Stored verbatim on CREATE by entity-resolver; stampSource below covers reuse.
            metadata: sourceMeta?.filename ? {
              source_filenames: [sourceMeta.filename],
              ...(sourceMeta.documentId ? { source_document_ids: [sourceMeta.documentId] } : {}),
              first_seen_at: sourceMeta.seenAt || new Date().toISOString().slice(0, 10),
              last_seen_at: sourceMeta.seenAt || new Date().toISOString().slice(0, 10),
            } : {},
          }],
          // Universal links are written below. Avoid a hidden first-memory write
          // here so every resource follows the same idempotent link path.
          linkMemory: false,
        });
      } catch (err) {
        out.skipped += entry.resources.length;
        if (remote) out.projectionFailed += entry.resources.length;
        else out.writeFailed += entry.resources.length;
        logger.warn?.(`[canonical-entities] resolve failed for "${entry.name}": ${err.message}`);
        continue;
      }
      const r = results?.[0];
      if (!r) {
        out.skipped += entry.resources.length;
        if (remote) out.projectionFailed += entry.resources.length;
        continue;
      }
      if (r.entityId && r.action !== 'created') await stampSource(r.entityId);
      if (r.entityId && r.action !== 'created') await upgradeSourceGroundedType(r.entityId, entry);
      if (r.action === 'review') {
        // Ambiguous — queued for human review; do not fan links out for it.
        out.review += 1;
        out.skipped += entry.resources.length;
        continue;
      }
      if (r.action === 'created') {
        out.created += 1;
        existingBySlug.set(`${entry.kind || entityKind}::${slug}`, r.entityId); // later names in this batch reuse it
      }
      await linkAll(r.entityId, entry.resources, r.confidence ?? 1.0, slug);
    }

    // An extraction result is a complete projection for its resource, not an
    // append-only event. On a retry/reprocess, stale links must disappear or a
    // rejected filename/person false-positive remains searchable forever even
    // after the extractor is fixed. Only canonical ingestion opts into this;
    // partial/legacy callers retain additive behavior. Prune after all new
    // links have landed and only when the batch had no write failure.
    if (replaceExisting && !remote && out.writeFailed === 0 && out.projectionFailed === 0) {
      const reconcile = async (client) => {
        for (const [resourceKey, target] of resourceTargets) {
          const linkKeys = [...(expectedLinkKeys.get(resourceKey) || [])];
          await client.resourceEntityLink.deleteMany({
            where: {
              organizationId,
              resourceType: target.resourceType,
              resourceId: target.resourceId,
              ...(linkKeys.length ? { linkKey: { notIn: linkKeys } } : {}),
            },
          });
          if (target.resourceType === 'memory' && client.memoryEntityLink) {
            const entityIds = [...(expectedEntityIds.get(resourceKey) || [])];
            await client.memoryEntityLink.deleteMany({
              where: {
                memoryId: target.resourceId,
                ...(entityIds.length ? { entityId: { notIn: entityIds } } : {}),
              },
            });
          }
        }
      };
      try {
        if (typeof prisma.$transaction === 'function') await prisma.$transaction(reconcile);
        else await reconcile(prisma);
      } catch (error) {
        out.writeFailed += 1;
        logger.warn?.(`[canonical-entities] stale projection cleanup failed: ${error.message}`);
      }
    }

    if (out.linked || out.created || out.review) {
      logger.info?.(`[canonical-entities] org ${String(organizationId).slice(0, 8)}: +${out.created} entities, ${out.linked} links, ${out.review} queued for review`);
    }
  } catch (err) {
    logger.warn?.(`[canonical-entities] batch failed: ${err.message}`);
  }
  return out;
}
