#!/usr/bin/env node

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const commit = process.argv.includes('--commit');
const orgArg = process.argv.find((arg) => arg.startsWith('--org='));
const orgId = orgArg ? orgArg.slice('--org='.length) : null;
const batchArg = process.argv.find((arg) => arg.startsWith('--batch='));
const batchSize = Math.max(10, Math.min(500, Number(batchArg?.slice('--batch='.length)) || 200));

const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const iso = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
const unique = (values) => [...new Set(values.flat().filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

let cursor = null;
const totals = { scanned: 0, changed: 0, committed: 0, entities: 0, typed: 0, temporal: 0 };

try {
  for (;;) {
    const rows = await prisma.knowledgeSegment.findMany({
      where: orgId ? { orgId } : undefined,
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        document: {
          select: {
            id: true, documentType: true, sourcePlatform: true, documentDate: true,
            parseMetadata: true, createdAt: true,
          },
        },
        entityMentions: {
          include: { entity: { select: { id: true, canonicalName: true, aliases: true } } },
        },
        memoryLinks: {
          include: { memory: { select: { id: true, memoryType: true } } },
        },
      },
    });
    if (!rows.length) break;
    cursor = rows.at(-1).id;

    const updates = [];
    for (const row of rows) {
      totals.scanned += 1;
      const current = asObject(row.metadata);
      const documentMeta = asObject(row.document?.parseMetadata);
      const entities = unique([
        current.entities || [], documentMeta.entities || [],
        row.entityMentions.flatMap((mention) => [mention.mentionText, mention.entity?.canonicalName, mention.entity?.aliases || []]),
      ]);
      const entityIds = unique([current.entity_ids || [], row.entityMentions.map((mention) => mention.entityId)]);
      const memoryTypes = unique([
        current.memory_types || [], current.memory_type, current.claim_type,
        row.memoryLinks.map((link) => link.memory?.memoryType),
      ]);
      const eventTime = iso(current.event_time || current.eventTime
        || documentMeta.event_time || documentMeta.eventTime || row.document?.documentDate);
      const knownAt = iso(current.known_at || current.knownAt
        || documentMeta.known_at || documentMeta.knownAt || row.createdAt || row.document?.createdAt);
      const validFrom = iso(current.valid_from || current.validFrom
        || documentMeta.valid_from || documentMeta.validFrom || eventTime);
      const next = {
        ...current,
        ...(eventTime ? { event_time: eventTime } : {}),
        ...(knownAt ? { known_at: knownAt } : {}),
        ...(validFrom ? { valid_from: validFrom } : {}),
        ...(entities.length ? { entities } : {}),
        ...(entityIds.length ? { entity_ids: entityIds } : {}),
        ...(memoryTypes.length ? { memory_types: memoryTypes } : {}),
        source_kind: current.source_kind || documentMeta.source_kind
          || row.document?.sourcePlatform || row.document?.documentType || 'document',
      };
      if (same(current, next)) continue;
      totals.changed += 1;
      if (entities.length) totals.entities += 1;
      if (memoryTypes.length) totals.typed += 1;
      if (eventTime || knownAt || validFrom) totals.temporal += 1;
      if (commit) updates.push(prisma.knowledgeSegment.update({ where: { id: row.id }, data: { metadata: next } }));
    }
    if (updates.length) {
      await prisma.$transaction(updates);
      totals.committed += updates.length;
    }
    process.stderr.write(`\rscanned=${totals.scanned} changed=${totals.changed} committed=${totals.committed}`);
  }
  process.stderr.write('\n');
  console.log(JSON.stringify({ mode: commit ? 'commit' : 'dry-run', org_id: orgId, ...totals }, null, 2));
} finally {
  await prisma.$disconnect();
}
