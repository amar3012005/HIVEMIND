const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const EMPTY_DUPLICATE_TERMINAL_STATUSES = Object.freeze(['failed', 'dead', 'cancelled']);
export const EMPTY_DUPLICATE_CLEANUP_CONFIRMATION = 'DELETE_EMPTY_KNOWLEDGE_DUPLICATES';
export const EMPTY_DUPLICATE_CLEANUP_MAX_LIMIT = 100;

export class EmptyDuplicateCleanupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EmptyDuplicateCleanupError';
    this.code = code;
  }
}

function optionValue(argv, name) {
  const prefix = `--${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : null;
}

function positiveLimit(value) {
  if (value == null || value === '') return 25;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > EMPTY_DUPLICATE_CLEANUP_MAX_LIMIT) {
    throw new EmptyDuplicateCleanupError(
      'INVALID_LIMIT',
      `--limit must be an integer between 1 and ${EMPTY_DUPLICATE_CLEANUP_MAX_LIMIT}.`,
    );
  }
  return parsed;
}

/** Parse the deliberately narrow operator command. Dry-run is the only default. */
export function parseEmptyDuplicateCleanupArgs(argv = []) {
  const orgId = optionValue(argv, 'org-id');
  if (!UUID_RE.test(String(orgId || ''))) {
    throw new EmptyDuplicateCleanupError('ORG_ID_REQUIRED', 'A valid --org-id UUID is required.');
  }
  const apply = argv.includes('--apply');
  const backupManifest = optionValue(argv, 'backup-manifest');
  const confirmation = optionValue(argv, 'confirm');
  if (apply && !backupManifest) {
    throw new EmptyDuplicateCleanupError(
      'BACKUP_MANIFEST_REQUIRED',
      '--apply requires --backup-manifest=<verified backup reference>.',
    );
  }
  if (apply && confirmation !== EMPTY_DUPLICATE_CLEANUP_CONFIRMATION) {
    throw new EmptyDuplicateCleanupError(
      'EXPLICIT_CONFIRMATION_REQUIRED',
      `--apply requires --confirm=${EMPTY_DUPLICATE_CLEANUP_CONFIRMATION}.`,
    );
  }
  return {
    orgId,
    limit: positiveLimit(optionValue(argv, 'limit')),
    apply,
    backupManifest: backupManifest || null,
  };
}

/** This operator has no remote/AMR implementation and must fail closed there. */
export async function requireCentralCleanupStorage(prisma, orgId) {
  const organization = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { id: true, memoryStorageMode: true },
  });
  if (!organization) {
    throw new EmptyDuplicateCleanupError('ORGANIZATION_NOT_FOUND', 'Organization was not found.');
  }
  const storageMode = String(organization.memoryStorageMode || 'hybrid');
  if (storageMode !== 'hybrid') {
    throw new EmptyDuplicateCleanupError(
      'CENTRAL_STORAGE_REQUIRED',
      `This cleanup only supports central hybrid storage; ${storageMode} must use its canonical storage API.`,
    );
  }
  return storageMode;
}

const EMPTY_DOCUMENT_MEMORY_GUARD = `
  NOT EXISTS (
    SELECT 1
      FROM memories m
      LEFT JOIN source_metadata sm ON sm.memory_id = m.id
     WHERE m.org_id = d.org_id
       AND m.deleted_at IS NULL
       AND (
         m.tags @> ARRAY['doc-id:' || d.id::text]::text[]
         OR m.provenance->>'document_id' = d.id::text
         OR m.provenance->>'documentId' = d.id::text
         OR sm.metadata->>'document_id' = d.id::text
         OR sm.metadata->>'documentId' = d.id::text
       )
  )`;

const NONEMPTY_READY_SIBLING_GUARD = `
  EXISTS (
    SELECT 1
      FROM knowledge_ingest_jobs keeper
      JOIN knowledge_documents kept_doc
        ON kept_doc.id = keeper.document_id
       AND kept_doc.org_id = keeper.org_id
     WHERE keeper.org_id = j.org_id
       AND keeper.scope_key = j.scope_key
       AND keeper.checksum = j.checksum
       AND keeper.id <> j.id
       AND keeper.status = 'ready'
       AND keeper.document_id IS NOT NULL
       AND keeper.document_id <> j.document_id
       AND (keeper.created_at > j.created_at OR (keeper.created_at = j.created_at AND keeper.id > j.id))
       AND (
         EXISTS (SELECT 1 FROM knowledge_segments kept_segment WHERE kept_segment.document_id = kept_doc.id)
         OR EXISTS (SELECT 1 FROM memory_evidence_links kept_link WHERE kept_link.document_id = kept_doc.id)
         OR EXISTS (
           SELECT 1 FROM memories kept_memory
            WHERE kept_memory.org_id = kept_doc.org_id
              AND kept_memory.deleted_at IS NULL
              AND kept_memory.tags @> ARRAY['doc-id:' || kept_doc.id::text]::text[]
         )
       )
  )`;

const NO_ACTIVE_SIBLING_GUARD = `
  NOT EXISTS (
    SELECT 1
      FROM knowledge_ingest_jobs active_job
     WHERE active_job.org_id = j.org_id
       AND active_job.scope_key = j.scope_key
       AND active_job.checksum = j.checksum
       AND active_job.status IN ('queued', 'processing')
  )`;

const EMPTY_DOCUMENT_GUARDS = `
  j.status IN ('failed', 'dead', 'cancelled')
  AND j.document_id IS NOT NULL
  AND COALESCE(j.segment_count, 0) = 0
  AND COALESCE(j.candidate_count, 0) = 0
  AND COALESCE(j.promoted_count, 0) = 0
  AND cardinality(j.memory_ids) = 0
  AND j.usage_settled_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM knowledge_segments segment WHERE segment.document_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM memory_evidence_links evidence WHERE evidence.document_id = d.id)
  AND ${EMPTY_DOCUMENT_MEMORY_GUARD}
  AND ${NO_ACTIVE_SIBLING_GUARD}
  AND ${NONEMPTY_READY_SIBLING_GUARD}`;

const LIST_CANDIDATES_SQL = `
  SELECT j.id AS job_id,
         j.org_id,
         j.document_id,
         j.scope_key,
         j.checksum,
         j.storage_mode,
         d.source_artifact_id
    FROM knowledge_ingest_jobs j
    JOIN knowledge_documents d
      ON d.id = j.document_id
     AND d.org_id = j.org_id
   WHERE j.org_id = $1::uuid
     AND ${EMPTY_DOCUMENT_GUARDS}
   ORDER BY j.updated_at ASC, j.id ASC
   LIMIT $2::int`;

const LOCK_CANDIDATE_SQL = `
  SELECT j.id AS job_id, j.document_id
    FROM knowledge_ingest_jobs j
    JOIN knowledge_documents d
      ON d.id = j.document_id
     AND d.org_id = j.org_id
   WHERE j.org_id = $1::uuid
     AND j.id = $2::uuid
     AND j.document_id = $3::uuid
     AND ${EMPTY_DOCUMENT_GUARDS}
   FOR UPDATE OF j, d`;

const DELETE_DOCUMENT_SQL = `
  DELETE FROM knowledge_documents d
   WHERE d.id = $1::uuid
     AND d.org_id = $2::uuid
     AND NOT EXISTS (SELECT 1 FROM knowledge_segments segment WHERE segment.document_id = d.id)
     AND NOT EXISTS (SELECT 1 FROM memory_evidence_links evidence WHERE evidence.document_id = d.id)
     AND ${EMPTY_DOCUMENT_MEMORY_GUARD}
   RETURNING d.id`;

/** List only central, terminal duplicate documents whose data footprint is provably empty. */
export async function listEmptyDuplicateKnowledgeDocuments(prisma, { orgId, limit = 25 }) {
  await requireCentralCleanupStorage(prisma, orgId);
  const bounded = positiveLimit(limit);
  return prisma.$queryRawUnsafe(LIST_CANDIDATES_SQL, orgId, bounded);
}

class CleanupSkipped extends Error {
  constructor() {
    super('Candidate changed before deletion.');
    this.name = 'CleanupSkipped';
  }
}

async function removeCandidate(prisma, candidate) {
  try {
    return await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRawUnsafe(
        LOCK_CANDIDATE_SQL,
        candidate.org_id,
        candidate.job_id,
        candidate.document_id,
      );
      if (!locked?.length) throw new CleanupSkipped();

      const detached = await tx.knowledgeIngestJob.updateMany({
        where: {
          id: candidate.job_id,
          orgId: candidate.org_id,
          documentId: candidate.document_id,
          status: { in: EMPTY_DUPLICATE_TERMINAL_STATUSES },
        },
        data: { documentId: null },
      });
      if (detached.count !== 1) throw new CleanupSkipped();

      const deleted = await tx.$queryRawUnsafe(
        DELETE_DOCUMENT_SQL,
        candidate.document_id,
        candidate.org_id,
      );
      if (!deleted?.length) throw new CleanupSkipped();
      return { job_id: candidate.job_id, document_id: candidate.document_id };
    });
  } catch (error) {
    if (error instanceof CleanupSkipped) return null;
    throw error;
  }
}

/** Revalidates every candidate in a transaction before removing its empty document. */
export async function applyEmptyDuplicateKnowledgeDocumentCleanup(prisma, { orgId, candidates = [] }) {
  await requireCentralCleanupStorage(prisma, orgId);
  const deleted = [];
  const skipped = [];
  for (const candidate of candidates.slice(0, EMPTY_DUPLICATE_CLEANUP_MAX_LIMIT)) {
    if (candidate?.org_id !== orgId) {
      skipped.push(candidate?.document_id || null);
      continue;
    }
    const removed = await removeCandidate(prisma, candidate);
    if (removed) deleted.push(removed);
    else skipped.push(candidate.document_id);
  }
  return { deleted, skipped };
}

export const _internal = {
  LIST_CANDIDATES_SQL,
  LOCK_CANDIDATE_SQL,
  DELETE_DOCUMENT_SQL,
};
