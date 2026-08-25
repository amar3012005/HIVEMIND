import { KnowledgeUploadJobStore } from '../knowledge/upload-job-store.js';
import { normalizeKnowledgeIngestMode, withKnowledgeUploadQuotaDetails } from '../knowledge/upload-contract.js';

function field(parts, name, fallback = '') {
  return parts.find((part) => part.name === name)?.value ?? fallback;
}

export async function handleKnowledgeUploadRoute(ctx = {}) {
  const { req, res, userId, orgId, readBoundedBuffer, MULTIPART_MAX_BYTES,
    parseMultipart, normalizeScopeIds, jsonResponse, knowledgeUploadService, creditService, planLimitBody } = ctx;
  if (!knowledgeUploadService) return jsonResponse(res, { error: 'canonical_ingest_unavailable' }, 503);
  try {
    const contentType = String(req.headers['content-type'] || '');
    if (!contentType.includes('multipart/form-data')) {
      return jsonResponse(res, { error: 'multipart_required' }, 400);
    }
    const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.slice(1).find(Boolean)?.trim();
    if (!boundary) return jsonResponse(res, { error: 'multipart_boundary_missing' }, 400);
    let body;
    try { body = await readBoundedBuffer(req); }
    catch (error) {
      return jsonResponse(res, { error: error?.code === 'PAYLOAD_TOO_LARGE' ? 'payload_too_large' : 'read_failed', max_bytes: MULTIPART_MAX_BYTES }, error?.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400);
    }
    const parts = parseMultipart(body, boundary);
    const file = parts.find((part) => part.filename);
    if (!file) return jsonResponse(res, { error: 'file_required' }, 400);
    const targetScope = ['personal', 'project', 'team', 'organization'].includes(field(parts, 'targetScope'))
      ? field(parts, 'targetScope') : 'personal';
    const projectIds = normalizeScopeIds([
      field(parts, 'projectId', null),
      ...field(parts, 'projectIds').split(',').map((id) => id.trim()).filter(Boolean),
    ]);
    const primaryTeamId = field(parts, 'primaryTeamId', null);
    const tags = field(parts, 'tags').split(',').map((tag) => tag.trim()).filter(Boolean);
    const ingestMode = normalizeKnowledgeIngestMode(field(parts, 'ingestMode', ''));
    if (!ingestMode.ok) {
      return jsonResponse(res, {
        error: 'invalid_ingest_mode',
        message: 'ingestMode must be both or evidence.',
      }, 400);
    }
    if (creditService) {
      const credits = await creditService.getSummary(orgId);
      const minimum = ingestMode.value === 'evidence' ? 1 : 2;
      if (!credits.unlimited && credits.remaining < minimum) {
        const estimatedPages = typeof knowledgeUploadService.estimatePages === 'function'
          ? await knowledgeUploadService.estimatePages(file).catch(() => null)
          : null;
        return jsonResponse(res, withKnowledgeUploadQuotaDetails(planLimitBody({
          allowed: false, status: 402, reason: 'Monthly credits exhausted', plan: credits.plan,
          limit: credits.included, current: credits.used + credits.reserved, remaining: credits.remaining,
        }, 'credits'), { metric: 'credits', estimatedPages, ingestMode: ingestMode.value }), 402);
      }
    }
    const admitted = await knowledgeUploadService.admit({
      userId, orgId, file, targetScope, projectIds, primaryTeamId,
      ingestMode: ingestMode.value,
      // `force` is an explicit request to reprocess an already-known source
      // (for example evidence-only -> both). It must reach the durable job
      // state machine; otherwise the client receives a misleading "existing"
      // result and no promotion can ever run.
      force: field(parts, 'force').toLowerCase() === 'true',
      metadata: {
        tags, ingest_mode: ingestMode.value,
        smart: field(parts, 'smart').toLowerCase() === 'true',
        picture_descriptions: field(parts, 'picture_descriptions').toLowerCase() === 'true',
        hint: field(parts, 'hint', null),
        visibility: targetScope === 'organization' ? 'organization' : 'private',
        scope: targetScope,
      },
    });
    if (!admitted.ok) {
      if (admitted.status === 429) res.setHeader('Retry-After', '30');
      return jsonResponse(res, admitted.body, admitted.status);
    }
    const payload = KnowledgeUploadJobStore.response(admitted.job);
    if (payload?.ingest_mode !== ingestMode.value) {
      const mismatch = Object.assign(
        new Error('The durable upload mode did not match the requested mode.'),
        { code: 'INGEST_MODE_MISMATCH' },
      );
      if (!admitted.existing) {
        await knowledgeUploadService.jobStore?.fail(admitted.job.id, orgId, mismatch).catch(() => {});
      }
      return jsonResponse(res, {
        error: 'ingest_mode_mismatch', code: 'INGEST_MODE_MISMATCH',
        message: mismatch.message,
        requested_ingest_mode: ingestMode.value,
        actual_ingest_mode: payload?.ingest_mode || null,
        job_id: admitted.job?.id || null,
      }, 409);
    }
    res.setHeader('X-Job-Id', admitted.job.id);
    return jsonResponse(res, { ...payload, existing: !!admitted.existing }, 202);
  } catch (error) {
    console.error('[knowledge/upload] admission failed:', error.message);
    return jsonResponse(res, { error: 'upload_admission_failed', message: 'The upload could not be accepted.' }, 500);
  }
}
