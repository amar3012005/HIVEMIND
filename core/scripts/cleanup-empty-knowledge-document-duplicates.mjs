#!/usr/bin/env node
/**
 * Dry-run-first operator cleanup for empty, terminal, central KnowledgeDocument
 * duplicates. It refuses AMR/BYOD storage rather than deleting through Prisma.
 *
 * Dry run:
 *   node scripts/cleanup-empty-knowledge-document-duplicates.mjs --org-id=<uuid>
 * Apply (after a verified backup):
 *   node scripts/cleanup-empty-knowledge-document-duplicates.mjs --org-id=<uuid> --apply \
 *     --backup-manifest=<reference> --confirm=DELETE_EMPTY_KNOWLEDGE_DUPLICATES
 */
import { PrismaClient } from '@prisma/client';
import {
  applyEmptyDuplicateKnowledgeDocumentCleanup,
  EmptyDuplicateCleanupError,
  listEmptyDuplicateKnowledgeDocuments,
  parseEmptyDuplicateCleanupArgs,
} from '../src/knowledge/empty-duplicate-document-cleanup.js';

const prisma = new PrismaClient();

try {
  const options = parseEmptyDuplicateCleanupArgs(process.argv.slice(2));
  const candidates = await listEmptyDuplicateKnowledgeDocuments(prisma, options);
  if (!options.apply) {
    console.log(JSON.stringify({
      dry_run: true,
      org_id: options.orgId,
      central_only: true,
      candidates: candidates.length,
      documents: candidates.map((candidate) => ({
        job_id: candidate.job_id,
        document_id: candidate.document_id,
        scope_key: candidate.scope_key,
        checksum: candidate.checksum,
      })),
    }));
  } else {
    const result = await applyEmptyDuplicateKnowledgeDocumentCleanup(prisma, {
      orgId: options.orgId,
      candidates,
    });
    console.log(JSON.stringify({
      dry_run: false,
      org_id: options.orgId,
      central_only: true,
      backup_manifest: options.backupManifest,
      candidates: candidates.length,
      deleted: result.deleted.length,
      skipped: result.skipped.length,
      documents: result.deleted,
    }));
  }
} catch (error) {
  const known = error instanceof EmptyDuplicateCleanupError;
  console.error(JSON.stringify({
    error: known ? error.code : 'CLEANUP_FAILED',
    message: String(error?.message || 'Cleanup failed'),
  }));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
