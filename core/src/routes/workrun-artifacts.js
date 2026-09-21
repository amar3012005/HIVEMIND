import crypto from 'node:crypto';
import { CloudflareKnowledgeIngestClient } from '../knowledge/cloudflare-ingest-client.js';

const UUID = /^[0-9a-f-]{36}$/i;
const R2_PREFIX = 'r2:';

function artifactError(status, error, code) {
  return { status, error, code };
}

function inlineBytes(payload) {
  const encoded = String(payload?.content_base64 || '').replace(/\s/g, '');
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
    throw Object.assign(new Error('Inline artifact payload is malformed.'), { code: 'ARTIFACT_PAYLOAD_INVALID' });
  }
  return Buffer.from(encoded, 'base64');
}

function validObjectKey(objectKey, orgId) {
  return typeof objectKey === 'string' && objectKey.startsWith(`org/${orgId}/sha256/`);
}

/**
 * Reads a generated AgentScope artifact only after proving both the requesting
 * principal and the WorkRun receipt authorize it. The pointer is never trusted
 * on its own: durable bytes are checked against the admitted SHA-256 before
 * they leave Core.
 */
export async function readWorkRunArtifact({
  prisma,
  workRunId,
  artifactId,
  userId,
  orgId,
  artifactStorage = new CloudflareKnowledgeIngestClient({ logger: console }),
}) {
  if (!UUID.test(String(workRunId || '')) || !UUID.test(String(artifactId || ''))) {
    return artifactError(404, 'Artifact not found.', 'WORKRUN_ARTIFACT_NOT_FOUND');
  }
  const runs = await prisma.$queryRawUnsafe(
    `SELECT id, result_artifact_ids FROM "hivemind"."work_runs"
     WHERE id = $1::uuid AND user_id = $2::uuid AND org_id = $3::uuid LIMIT 1`,
    workRunId, userId, orgId,
  );
  const run = runs?.[0];
  const artifactIds = Array.isArray(run?.result_artifact_ids) ? run.result_artifact_ids.map(String) : [];
  if (!run || !artifactIds.includes(String(artifactId))) {
    return artifactError(404, 'Artifact not found.', 'WORKRUN_ARTIFACT_NOT_FOUND');
  }
  const artifact = await prisma.sourceArtifact.findFirst({
    where: { id: artifactId, userId, orgId, sourcePlatform: 'agentscope_workrun' },
    select: { id: true, contentType: true, checksum: true, storageLocation: true, payload: true, metadata: true },
  });
  if (!artifact) return artifactError(404, 'Artifact not found.', 'WORKRUN_ARTIFACT_NOT_FOUND');

  const payload = artifact.payload && typeof artifact.payload === 'object' ? artifact.payload : {};
  let bytes;
  try {
    if (String(artifact.storageLocation || '').startsWith(R2_PREFIX)) {
      const objectKey = String(payload.object_key || artifact.storageLocation.slice(R2_PREFIX.length));
      if (!validObjectKey(objectKey, orgId)) {
        return artifactError(409, 'Artifact storage pointer is invalid.', 'ARTIFACT_STORAGE_POINTER_INVALID');
      }
      if (!artifactStorage?.configured?.()) {
        return artifactError(503, 'Durable artifact storage is unavailable.', 'ARTIFACT_STORAGE_UNAVAILABLE');
      }
      bytes = await artifactStorage.getObject(objectKey, { expectedEtag: payload.etag || null });
    } else if (artifact.storageLocation === 'inline:source_artifacts.payload') {
      bytes = inlineBytes(payload);
    } else {
      return artifactError(409, 'Artifact storage is unsupported.', 'ARTIFACT_STORAGE_UNSUPPORTED');
    }
  } catch (error) {
    return artifactError(
      error?.code === 'SOURCE_OBJECT_INTEGRITY_FAILED' ? 409 : 503,
      'Durable artifact storage could not be read.',
      error?.code || 'ARTIFACT_STORAGE_READ_FAILED',
    );
  }

  const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
  if (!artifact.checksum || checksum !== artifact.checksum) {
    return artifactError(409, 'Artifact integrity verification failed.', 'ARTIFACT_INTEGRITY_FAILED');
  }
  return {
    status: 200,
    bytes,
    contentType: String(artifact.contentType || 'application/octet-stream').replace(/[\r\n]/g, ''),
    filename: String(payload.path || artifact.metadata?.path || artifact.id).split('/').pop().replace(/[^A-Za-z0-9._-]/g, '_') || 'artifact',
  };
}
