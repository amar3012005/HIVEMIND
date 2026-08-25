import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyEmptyDuplicateKnowledgeDocumentCleanup,
  EMPTY_DUPLICATE_CLEANUP_CONFIRMATION,
  EmptyDuplicateCleanupError,
  listEmptyDuplicateKnowledgeDocuments,
  parseEmptyDuplicateCleanupArgs,
  requireCentralCleanupStorage,
} from '../../src/knowledge/empty-duplicate-document-cleanup.js';

const ids = {
  org: '22222222-2222-4222-8222-222222222222',
  job: '33333333-3333-4333-8333-333333333333',
  document: '44444444-4444-4444-8444-444444444444',
};

function centralPrisma(overrides = {}) {
  return {
    organization: { findUnique: async () => ({ id: ids.org, memoryStorageMode: 'hybrid' }) },
    $queryRawUnsafe: async () => [],
    $transaction: async (fn) => fn({
      $queryRawUnsafe: async () => [],
      knowledgeIngestJob: { updateMany: async () => ({ count: 0 }) },
    }),
    ...overrides,
  };
}

test('cleanup command is dry-run by default and apply needs backup plus exact confirmation', () => {
  const dryRun = parseEmptyDuplicateCleanupArgs([`--org-id=${ids.org}`]);
  assert.deepEqual(dryRun, { orgId: ids.org, limit: 25, apply: false, backupManifest: null });

  assert.throws(
    () => parseEmptyDuplicateCleanupArgs([`--org-id=${ids.org}`, '--apply']),
    (error) => error instanceof EmptyDuplicateCleanupError && error.code === 'BACKUP_MANIFEST_REQUIRED',
  );
  assert.throws(
    () => parseEmptyDuplicateCleanupArgs([
      `--org-id=${ids.org}`, '--apply', '--backup-manifest=backup-1', '--confirm=nope',
    ]),
    (error) => error instanceof EmptyDuplicateCleanupError && error.code === 'EXPLICIT_CONFIRMATION_REQUIRED',
  );
  const apply = parseEmptyDuplicateCleanupArgs([
    `--org-id=${ids.org}`, '--limit=2', '--apply', '--backup-manifest=backup-1',
    `--confirm=${EMPTY_DUPLICATE_CLEANUP_CONFIRMATION}`,
  ]);
  assert.deepEqual(apply, { orgId: ids.org, limit: 2, apply: true, backupManifest: 'backup-1' });
});

test('cleanup refuses AMR and BYOD storage instead of querying central document records', async () => {
  for (const memoryStorageMode of ['amr_embedded', 'byod_amr', 'byod_hybrid']) {
    const prisma = centralPrisma({
      organization: { findUnique: async () => ({ id: ids.org, memoryStorageMode }) },
    });
    await assert.rejects(
      requireCentralCleanupStorage(prisma, ids.org),
      (error) => error instanceof EmptyDuplicateCleanupError && error.code === 'CENTRAL_STORAGE_REQUIRED',
    );
  }
});

test('candidate listing is tenant-bound and performs no mutation', async () => {
  const calls = [];
  const candidate = { job_id: ids.job, org_id: ids.org, document_id: ids.document };
  const prisma = centralPrisma({
    $queryRawUnsafe: async (...args) => { calls.push(args); return [candidate]; },
  });
  const result = await listEmptyDuplicateKnowledgeDocuments(prisma, { orgId: ids.org, limit: 3 });
  assert.deepEqual(result, [candidate]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], ids.org);
  assert.equal(calls[0][2], 3);
  assert.match(calls[0][0], /j\.status IN \('failed', 'dead', 'cancelled'\)/);
  assert.match(calls[0][0], /COALESCE\(j\.segment_count, 0\) = 0/);
  assert.match(calls[0][0], /j\.usage_settled_at IS NULL/);
  assert.match(calls[0][0], /active_job\.status IN \('queued', 'processing'\)/);
  assert.match(calls[0][0], /keeper\.created_at > j\.created_at/);
  assert.match(calls[0][0], /knowledge_segments/);
  assert.match(calls[0][0], /memory_evidence_links/);
  assert.match(calls[0][0], /doc-id:/);
});

test('apply revalidates then detaches only the terminal job and deletes only the empty document', async () => {
  const calls = [];
  const candidate = { job_id: ids.job, org_id: ids.org, document_id: ids.document };
  const tx = {
    $queryRawUnsafe: async (sql, ...args) => {
      calls.push([sql, ...args]);
      if (sql.includes('FOR UPDATE')) return [candidate];
      if (sql.includes('DELETE FROM knowledge_documents')) return [{ id: ids.document }];
      throw new Error('unexpected query');
    },
    knowledgeIngestJob: { updateMany: async (input) => {
      calls.push(['updateMany', input]);
      return { count: 1 };
    } },
  };
  const prisma = centralPrisma({ $transaction: async (fn) => fn(tx) });
  const result = await applyEmptyDuplicateKnowledgeDocumentCleanup(prisma, {
    orgId: ids.org,
    candidates: [candidate],
  });

  assert.deepEqual(result, { deleted: [{ job_id: ids.job, document_id: ids.document }], skipped: [] });
  const update = calls.find(([name]) => name === 'updateMany')?.[1];
  assert.deepEqual(update.where, {
    id: ids.job,
    orgId: ids.org,
    documentId: ids.document,
    status: { in: ['failed', 'dead', 'cancelled'] },
  });
  assert.deepEqual(update.data, { documentId: null });
  assert.equal(calls.some(([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM source_artifacts')), false);
});

test('apply leaves the job and document untouched when a candidate changes after dry run', async () => {
  let updates = 0;
  const candidate = { job_id: ids.job, org_id: ids.org, document_id: ids.document };
  const prisma = centralPrisma({
    $transaction: async (fn) => fn({
      $queryRawUnsafe: async () => [],
      knowledgeIngestJob: { updateMany: async () => { updates += 1; return { count: 1 }; } },
    }),
  });
  const result = await applyEmptyDuplicateKnowledgeDocumentCleanup(prisma, {
    orgId: ids.org,
    candidates: [candidate],
  });
  assert.deepEqual(result, { deleted: [], skipped: [ids.document] });
  assert.equal(updates, 0);
});
