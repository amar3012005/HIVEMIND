import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { authorizeKnowledgeScope } from '../knowledge/upload-authorization.js';
import { safeUploadFilename } from '../knowledge/upload-contract.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const fail = (code, status) => Object.assign(new Error(code), { code, status });

/** A portable reference, not a grant. Native IDs and storage coordinates stay unchanged. */
export function knowledgeFileReference(job) {
  if (!UUID.test(job?.id || '') || !UUID.test(job?.orgId || '') || !SHA256.test(job?.checksum || '')) {
    throw fail('invalid_file_record', 409);
  }
  return Object.freeze({
    version: 1,
    id: `hive-file://${job.orgId}/brain/${job.id}`,
    native_id: job.id,
    owner: 'brain',
    name: safeUploadFilename(job.filename),
    media_type: job.contentType || 'application/octet-stream',
    sha256: job.checksum,
    scope: Object.freeze({ type: job.scopeType, id: job.scopeId }),
  });
}

/** Resolve only a persisted, authorized job. Neither a URI nor a supplied path grants access. */
export async function readOwnedKnowledgeFile({
  principal, jobId, prisma, jobStore, cloudflareQueue, localQueue,
  readLocal = readFile, isRemoteOrg = () => false,
}) {
  if (!UUID.test(principal?.orgId || '') || !UUID.test(principal?.userId || '') || !UUID.test(jobId || '')) {
    throw fail('file_not_found', 404);
  }
  const job = await jobStore.findOwned(jobId, principal);
  if (!job || job.orgId !== principal.orgId || job.userId !== principal.userId) throw fail('file_not_found', 404);
  const scope = await authorizeKnowledgeScope({
    prisma, ...principal, targetScope: job.scopeType,
    projectIds: job.scopeType === 'project' ? [job.scopeId] : [],
    primaryTeamId: job.scopeType === 'team' ? job.scopeId : null,
  });
  if (!scope.ok || scope.scopeKey !== job.scopeKey) throw fail('file_not_found', 404);
  const reference = knowledgeFileReference(job);
  // A remote memory policy is authoritative; do not silently read a central copy.
  if (await isRemoteOrg(job.orgId)) throw fail('file_requires_selected_remote_store', 409);
  let bytes;
  if (job.sourceObjectKey) {
    const expected = `org/${job.orgId}/sha256/${job.checksum}/${encodeURIComponent(safeUploadFilename(job.filename))}`;
    if (job.sourceObjectKey !== expected) throw fail('file_storage_identity_mismatch', 409);
    if (!cloudflareQueue) throw fail('file_store_unavailable', 503);
    bytes = await cloudflareQueue.getObject(expected, { expectedEtag: job.sourceObjectEtag });
  } else {
    const path = localQueue?.rawFilePath({ orgId: job.orgId, checksum: job.checksum, filename: job.filename });
    if (!path) throw fail('original_file_unavailable', 404);
    try { bytes = await readLocal(path); }
    catch (error) { if (error?.code === 'ENOENT') throw fail('original_file_unavailable', 404); throw error; }
  }
  if (!Buffer.isBuffer(bytes) || bytes.length > 50 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== job.checksum) {
    throw fail('file_integrity_failed', 409);
  }
  return { reference, bytes };
}
