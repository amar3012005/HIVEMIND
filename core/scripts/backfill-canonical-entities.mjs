#!/usr/bin/env node
// Backfill CanonicalEntity + MemoryEntityLink from existing memories' entity: tags.
// Org-scoped, DRY-RUN by default. For existing corpora (no re-upload needed) and
// to verify the persister end-to-end. Idempotent: exact-slug reuse skips dupes.
//   node scripts/backfill-canonical-entities.mjs --org <id>           # dry-run
//   node scripts/backfill-canonical-entities.mjs --org <id> --apply
import { PrismaClient } from '@prisma/client';
import { persistCanonicalLinks } from '../src/memory/canonical-entity-persister.js';

const args = process.argv.slice(2);
const orgId = args[args.indexOf('--org') + 1];
const APPLY = args.includes('--apply');
if (!orgId || orgId.startsWith('--')) { console.error('usage: --org <id> [--apply]'); process.exit(1); }
const prisma = new PrismaClient();
try {
  const before = await prisma.canonicalEntity.count({ where: { organizationId: orgId } });
  const rows = await prisma.memory.findMany({
    where: { orgId, deletedAt: null, isLatest: true },
    select: { id: true, tags: true },
    take: 100000,
  });
  const items = [];
  for (const r of rows) {
    const names = (r.tags || [])
      .filter((t) => typeof t === 'string' && (t.startsWith('entity:') || t.startsWith('person:')))
      .map((t) => t.replace(/^(entity|person):/, '').replace(/-/g, ' ').trim())
      .filter(Boolean);
    if (names.length) items.push({ memoryId: r.id, entities: names });
  }
  console.log(JSON.stringify({ org: orgId, mode: APPLY ? 'apply' : 'dry-run', memories_scanned: rows.length, memories_with_entities: items.length, canonical_before: before }));
  if (!APPLY) {
    const uniq = new Set(items.flatMap((i) => i.entities.map((e) => e.toLowerCase())));
    console.log(JSON.stringify({ would_process_unique_names: uniq.size, sample: [...uniq].slice(0, 15) }));
  } else {
    const out = await persistCanonicalLinks({ prisma, organizationId: orgId, items, logger: console });
    const after = await prisma.canonicalEntity.count({ where: { organizationId: orgId } });
    const links = await prisma.memoryEntityLink.count();
    console.log(JSON.stringify({ result: out, canonical_after: after, links_total: links }));
  }
} finally { await prisma.$disconnect(); }
