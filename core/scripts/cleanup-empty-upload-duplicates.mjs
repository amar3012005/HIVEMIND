#!/usr/bin/env node
/**
 * Remove only superseded, empty terminal upload jobs after an independently
 * verified database backup. This is deliberately separate from migrations:
 * schema deployment must never silently delete tenant records.
 */
import { PrismaClient } from '@prisma/client';

const apply = process.argv.includes('--apply');
const backupArg = process.argv.find((arg) => arg.startsWith('--backup-manifest='));
const backupManifest = backupArg?.slice('--backup-manifest='.length) || '';

if (apply && !backupManifest) {
  throw new Error('Refusing cleanup without --backup-manifest=<verified backup reference>.');
}

const prisma = new PrismaClient();
const candidates = await prisma.$queryRawUnsafe(`
  WITH ranked AS (
    SELECT id, org_id, scope_key, checksum,
           row_number() OVER (PARTITION BY org_id, scope_key, checksum ORDER BY updated_at DESC, id DESC) AS row_num
      FROM knowledge_ingest_jobs
     WHERE status IN ('failed', 'dead', 'cancelled')
       AND document_id IS NULL
       AND queue_job_id IS NULL
       AND cardinality(memory_ids) = 0
  )
  SELECT id, org_id, scope_key, checksum FROM ranked WHERE row_num > 1
`);

if (!apply) {
  console.log(JSON.stringify({ dry_run: true, candidates: candidates.length, ids: candidates.map((row) => row.id) }));
  await prisma.$disconnect();
  process.exit(0);
}

const ids = candidates.map((row) => row.id);
const removed = ids.length
  ? await prisma.knowledgeIngestJob.deleteMany({ where: {
    id: { in: ids }, status: { in: ['failed', 'dead', 'cancelled'] },
    documentId: null, queueJobId: null, memoryIds: { isEmpty: true },
  } })
  : { count: 0 };
console.log(JSON.stringify({ dry_run: false, backup_manifest: backupManifest, candidates: ids.length, removed: removed.count }));
await prisma.$disconnect();
