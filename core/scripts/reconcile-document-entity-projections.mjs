#!/usr/bin/env node
/**
 * Deterministically repair canonical-entity projections for one already
 * ingested remote document. Dry-run by default; never reparses source bytes.
 *
 * Usage:
 *   node scripts/reconcile-document-entity-projections.mjs \
 *     --org=<uuid> --document=<uuid>
 *   node scripts/reconcile-document-entity-projections.mjs \
 *     --org=<uuid> --document=<uuid> --apply
 */
import { PrismaClient } from '@prisma/client';
import { normalizeEntity } from '../src/memory/entity-normalize.js';
import { persistCanonicalLinks } from '../src/memory/canonical-entity-persister.js';
import { amrFindByTags, amrHydrateMemories, orgIsRemote } from '../src/vector/mneme/driver.js';

const value = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const organizationId = value('org');
const documentId = value('document');
const apply = process.argv.includes('--apply');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

if (!uuid.test(organizationId || '') || !uuid.test(documentId || '')) {
  throw new Error('Both --org=<uuid> and --document=<uuid> are required.');
}
if (!orgIsRemote(organizationId)) {
  throw new Error(`Organization ${organizationId} is not configured as a remote Memory Box tenant.`);
}

const prisma = new PrismaClient();
try {
  const [entityRows, memoryIds] = await Promise.all([
    prisma.canonicalEntity.findMany({
      where: { organizationId },
      select: { canonicalName: true, aliases: true, metadata: true },
      take: 20000,
    }),
    amrFindByTags(organizationId, [`doc-id:${documentId}`], 500, false),
  ]);
  const sourceEntities = entityRows.filter((entity) =>
    Array.isArray(entity.metadata?.source_document_ids)
      && entity.metadata.source_document_ids.includes(documentId));
  const memories = await amrHydrateMemories(organizationId, Array.isArray(memoryIds) ? memoryIds : []);
  const items = [];
  for (const memory of Array.isArray(memories) ? memories : []) {
    const searchable = normalizeEntity(`${memory.title || ''} ${memory.content || ''}`);
    const names = sourceEntities.filter((entity) =>
      [entity.canonicalName, ...(entity.aliases || [])]
        .map(normalizeEntity).filter(Boolean)
        .some((slug) => searchable === slug || searchable.includes(slug)))
      .map((entity) => entity.canonicalName);
    if (names.length) items.push({ memoryId: memory.id, entities: [...new Set(names)] });
  }

  const report = {
    dry_run: !apply,
    organization_id: organizationId,
    document_id: documentId,
    document_memories: Array.isArray(memories) ? memories.length : 0,
    source_entities: sourceEntities.length,
    memories_with_deterministic_matches: items.length,
    candidate_links: items.reduce((sum, item) => sum + item.entities.length, 0),
  };
  if (!apply) {
    console.log(JSON.stringify({ ...report, candidates: items }, null, 2));
    process.exitCode = 0;
  } else {
    const result = await persistCanonicalLinks({ prisma, organizationId, items, logger: console });
    if (result.projectionFailed > 0) throw new Error(`reconciliation incomplete: ${result.projectionFailed} projection failures`);
    console.log(JSON.stringify({ ...report, dry_run: false, result }, null, 2));
  }
} finally {
  await prisma.$disconnect();
}
