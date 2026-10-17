import { createHash } from 'node:crypto';
import { safeUploadFilename } from '../knowledge/upload-contract.js';

/** Use the configured native object store, without changing a selected remote/AMR policy. */
export async function retainConfiguredKnowledgeOriginal({
  orgId, checksum, filename, fileBuffer, storageMode, objectClient, isRemoteOrg,
}) {
  if (storageMode !== 'hybrid' || !objectClient?.configured?.() || await isRemoteOrg(orgId)) return null;
  if (!/^[a-f0-9-]{36}$/i.test(orgId) || !/^[a-f0-9]{64}$/.test(checksum) ||
      !Buffer.isBuffer(fileBuffer) || fileBuffer.length > 50 * 1024 * 1024 ||
      createHash('sha256').update(fileBuffer).digest('hex') !== checksum) {
    throw Object.assign(new Error('Original file integrity verification failed.'), { code: 'SOURCE_OBJECT_INTEGRITY_FAILED' });
  }
  const name = safeUploadFilename(filename);
  const receipt = await objectClient.persistFile({ orgId, checksum, filename: name, fileBuffer });
  const expected = `org/${orgId}/sha256/${checksum}/${encodeURIComponent(name)}`;
  if (receipt?.objectKey !== expected) {
    throw Object.assign(new Error('Durable original-file storage returned an invalid receipt.'), { code: 'SOURCE_OBJECT_STORE_FAILED' });
  }
  return { sourceObjectKey: receipt.objectKey, sourceObjectEtag: receipt.etag || null };
}
