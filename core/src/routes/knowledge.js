import crypto from 'node:crypto';
import { decideKbUploadPath } from '../knowledge/upload-mode.js';

export async function handleKnowledgeUploadRoute(ctx = {}) {
  const {
    req,
    res,
    url,
    userId,
    orgId,
    prisma,
    persistentMemoryEngine,
    documentFirstIngestion,
    planEnforcer,
    planLimitBody,
    readBoundedBuffer,
    MULTIPART_MAX_BYTES,
    parseMultipart,
    normalizeScopeIds,
    buildAccessContext,
    jsonResponse,
    kbIngestQueue,
    ingestTracker,
    buildRoutedIngestPayloads,
    smartIngestRouter,
    persistentMemoryStore,
    qdrantClient,
    getQdrantClient,
    recallPersistedMemories,
    processDocumentImpl,
  } = ctx;

  if (!persistentMemoryEngine) {
    return jsonResponse(res, { error: 'Memory engine unavailable' }, 503);
  }
  try {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return jsonResponse(res, { error: 'Content-Type must be multipart/form-data' }, 400);
    }

    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      return jsonResponse(res, { error: 'Missing boundary in Content-Type' }, 400);
    }

    let rawBody;
    try {
      rawBody = await readBoundedBuffer(req);
    } catch (sizeErr) {
      if (sizeErr?.code === 'PAYLOAD_TOO_LARGE') {
        return jsonResponse(res, { error: 'payload_too_large', max_bytes: MULTIPART_MAX_BYTES }, 413);
      }
      return jsonResponse(res, { error: 'read_failed', message: sizeErr?.message || String(sizeErr) }, 400);
    }

    const boundary = boundaryMatch[1].trim();
    const parts = parseMultipart(rawBody, boundary);
    const filePart = parts.find((p) => p.filename);
    if (!filePart) {
      return jsonResponse(res, { error: 'No file uploaded. Send a file field in multipart form data.' }, 400);
    }

    const containerTag = parts.find((p) => p.name === 'containerTag')?.value || null;
    const targetScopeRaw = parts.find((p) => p.name === 'targetScope')?.value || '';
    const targetScope = targetScopeRaw === 'personal'
      ? 'personal'
      : targetScopeRaw === 'project'
        ? 'project'
        : 'organization';
    const customTags = parts.find((p) => p.name === 'tags')?.value || '';
    const userTags = customTags ? customTags.split(',').map((t) => t.trim()).filter(Boolean) : [];
    const projectId = parts.find((p) => p.name === 'projectId')?.value || null;
    const projectIdsRaw = parts.find((p) => p.name === 'projectIds')?.value || '';
    const primaryTeamId = parts.find((p) => p.name === 'primaryTeamId')?.value || null;
    const projectIds = normalizeScopeIds([
      projectId,
      ...projectIdsRaw.split(',').map((value) => value.trim()).filter(Boolean),
    ]);

    const containerTagVal = parts.find((p) => p.name === 'containerTag')?.value || null;
    if (projectIds.length === 0 && containerTagVal) {
      try {
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(containerTagVal);
        const proj = await prisma.project.findFirst({
          where: { orgId, OR: [
            ...(isUuid ? [{ id: containerTagVal }] : []),
            { slug: containerTagVal.toLowerCase() },
            { name: { equals: containerTagVal, mode: 'insensitive' } },
          ] },
          select: { id: true },
        });
        if (proj) projectIds.push(proj.id);
      } catch (e) { console.warn('[knowledge] containerTag project resolve failed:', e.message); }
    }

    if (projectId || projectIdsRaw.trim() || targetScope === 'project') {
      const accessCtx = await buildAccessContext(userId, orgId);
      const allowed = Array.isArray(accessCtx?.projectIds) ? accessCtx.projectIds : [];
      if (!projectIds.length || projectIds.some((id) => !allowed.includes(id))) {
        return jsonResponse(res, {
          error: 'project_scope_required',
          message: 'Project-scoped uploads require an accessible projectId.',
        }, 403);
      }
    }

    if (targetScope === 'organization' && projectIds.length === 0 && !primaryTeamId && prisma && orgId) {
      const uploaderMembership = await prisma.userOrganization.findUnique({
        where: { userId_orgId: { userId, orgId } },
        select: { role: true },
      }).catch(() => null);
      const uploaderRole = uploaderMembership?.role || null;
      if (uploaderRole !== 'owner' && uploaderRole !== 'admin') {
        return jsonResponse(res, {
          error: 'org_scope_admin_only',
          message: 'Organization-wide uploads are reserved for org admins. Pick a project or upload to your personal space.',
          role: uploaderRole,
        }, 403);
      }
    }

    if (filePart.data.length > 100 * 1024 * 1024) {
      return jsonResponse(res, { error: 'File too large. Maximum 100MB.' }, 413);
    }

    const allowedTypes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.ms-excel',
      'application/vnd.ms-powerpoint',
      'text/plain', 'text/markdown', 'text/csv', 'text/html',
      'image/png', 'image/jpeg', 'image/tiff', 'image/webp',
      'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/x-m4a',
    ];
    const ext = (filePart.filename || '').split('.').pop()?.toLowerCase();
    const allowedExts = [
      'pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt',
      'txt', 'md', 'markdown', 'csv', 'tsv', 'html', 'htm',
      'png', 'jpg', 'jpeg', 'tiff', 'tif', 'webp',
      'mp3', 'wav', 'm4a', 'flac', 'ogg',
    ];
    if (!allowedTypes.includes(filePart.contentType) && !allowedExts.includes(ext)) {
      return jsonResponse(res, {
        error: `Unsupported file type: ${filePart.contentType || ext}. Allowed: PDF, DOCX, XLSX, PPTX, TXT, MD, CSV, HTML, PNG, JPG, TIFF, MP3, WAV.`
      }, 415);
    }

    const smartFlag = (parts.find((p) => p.name === 'smart')?.value || '').toLowerCase() === 'true';
    const pictureDescFlag = (parts.find((p) => p.name === 'picture_descriptions')?.value || '').toLowerCase() === 'true';
    const enterpriseFlag = (parts.find((p) => p.name === 'enterprise')?.value || 'auto').toLowerCase();
    const confirmedType = parts.find((p) => p.name === 'confirmed_type')?.value || null;

    if (planEnforcer && orgId) {
      const estPages = Math.max(1, Math.ceil(filePart.data.length / 50_000));
      const check = await planEnforcer.checkLimit(orgId, 'kbPages', estPages);
      if (!check.allowed) {
        return jsonResponse(res, { ...planLimitBody(check, 'kbPages'), estimated_pages: estPages }, check.status || 402);
      }
    }

    const uploadChecksum = crypto.createHash('sha256').update(filePart.data).digest('hex');
    const forceDuplicate = (parts.find((p) => p.name === 'force')?.value || '').toLowerCase() === 'true';
    const uploadScopeKey = primaryTeamId
      ? `team:${primaryTeamId}`
      : projectIds[0]
        ? `project:${projectIds[0]}`
        : (targetScope === 'organization' ? `org:${orgId}` : `personal:${userId}`);
    if (!forceDuplicate && prisma) {
      const dupDoc = await prisma.knowledgeDocument.findFirst({
        where: {
          orgId,
          sourcePlatform: 'knowledge_upload',
          sourceArtifact: { is: { checksum: uploadChecksum, sourcePlatform: 'knowledge_upload' } },
          tags: { has: `scope-key:${uploadScopeKey}` },
        },
        select: { id: true, title: true, createdAt: true },
      }).catch(() => null);
      if (dupDoc) {
        return jsonResponse(res, {
          duplicate: true,
          error: 'duplicate_document',
          message: `Identical content already in this scope${dupDoc?.title ? ` as "${dupDoc.title}"` : ''}. Same file in a different scope is allowed — pick another scope to upload again.`,
          existing_document_id: dupDoc?.id || null,
          existing_title: dupDoc?.title || null,
          uploaded_at: dupDoc?.createdAt || null,
          scope_key: uploadScopeKey,
          filename: filePart.filename,
        }, 409);
      }
    }

    const asyncMode = (parts.find((p) => p.name === 'async')?.value || '').toLowerCase() === 'true'
      || url.searchParams.get('async') === 'true';

    if (documentFirstIngestion) {
      console.log(`[knowledge] Using Phase 1 document-first ingestion for ${filePart.filename}${smartFlag ? ' (smart=true)' : ''}${asyncMode ? ' (async)' : ''}`);

      const phase1Metadata = {
        tags: userTags,
        project: containerTag,
        project_id: projectIds[0] || null,
        project_ids: projectIds,
        primary_team_id: primaryTeamId,
        visibility: targetScope === 'organization' ? 'organization' : 'private',
        scope: projectIds.length ? 'project' : ((targetScope === 'organization' && !primaryTeamId) ? 'organization' : undefined),
        smart: smartFlag,
        picture_descriptions: pictureDescFlag,
      };

      const uploadMode = decideKbUploadPath({
        queueEnabled: kbIngestQueue?.isEnabledFor(orgId),
        asyncRequested: asyncMode,
      });

      if (uploadMode.mode === 'queue') {
        try {
          const checksum = uploadChecksum;
          const storedPath = kbIngestQueue.persistFile({ orgId, checksum, filename: filePart.filename, fileBuffer: filePart.data });
          const q = await kbIngestQueue.enqueue({
            userId, orgId,
            filename: filePart.filename,
            contentType: filePart.contentType || `text/${ext}`,
            checksum, filePath: storedPath,
            metadata: phase1Metadata,
          });
          if (q.backpressure) {
            res.setHeader('Retry-After', '30');
            return jsonResponse(res, { error: 'Ingestion queue saturated — retry shortly', queued_depth: q.depth }, 429);
          }
          res.setHeader('X-Job-Id', q.job_id);
          return jsonResponse(res, { success: true, job_id: q.job_id, status: 'queued', filename: filePart.filename, mode: 'queued' }, 202);
        } catch (qErr) {
          const requiredQueueError = decideKbUploadPath({
            queueEnabled: false,
            queueError: qErr.message,
            asyncRequested: asyncMode,
          });
          if (requiredQueueError.mode === 'reject') {
            return jsonResponse(res, { error: 'queue_unavailable', message: qErr.message }, 503);
          }
          console.warn('[kb-queue] enqueue failed, falling back inline:', qErr.message);
        }
      }
      if (uploadMode.mode === 'reject') {
        return jsonResponse(res, {
          error: uploadMode.error,
          message: uploadMode.message,
        }, uploadMode.statusCode);
      }

      if (uploadMode.mode === 'async_inline') {
        const jobId = crypto.randomUUID();
        ingestTracker.createJob(jobId, { userId, orgId, filename: filePart.filename, kind: 'knowledge_upload' });
        res.setHeader('X-Job-Id', jobId);
        jsonResponse(res, { success: true, job_id: jobId, status: 'queued', filename: filePart.filename }, 202);
        (async () => {
          const tBg = Date.now();
          try {
            const result = await documentFirstIngestion.ingestSource({
              userId, orgId,
              source: { type: 'kb', filename: filePart.filename },
              file: { buffer: filePart.data, contentType: filePart.contentType || `text/${ext}`, filename: filePart.filename },
              metadata: phase1Metadata,
              onProgress: (p) => {
                const prev = ingestTracker.getJob(jobId)?.metadata || {};
                ingestTracker.updateJob(jobId, { status: p.stage || 'processing', progress: p.progress ?? 0, metadata: { ...prev, ...p } });
              },
            });
            const prev = ingestTracker.getJob(jobId)?.metadata || {};
            ingestTracker.updateJob(jobId, {
              status: 'indexed', progress: 100, memoryId: result.documentId,
              metadata: { ...prev, document_id: result.documentId, segmentCount: result.segmentCount, candidateCount: result.candidateCount, promotedCount: result.promotedCount },
            });
            if (planEnforcer && orgId) {
              planEnforcer.recordUsage(orgId, 'kbPages', result.pages || result.segmentCount || 1);
              planEnforcer.recordUsage(orgId, 'uploads', 1);
            }
            console.log(`[knowledge:async] ✓ ${filePart.filename} doc=${result.documentId} segs=${result.segmentCount} promoted=${result.promotedCount} ms=${Date.now() - tBg}`);
          } catch (bgErr) {
            console.error(`[knowledge:async] ✗ ${filePart.filename}:`, bgErr.message);
            ingestTracker.updateJob(jobId, { status: 'failed', error: bgErr.message });
          }
        })();
        return;
      }

      const tPhase1 = Date.now();
      try {
        const result = await documentFirstIngestion.ingestSource({
          userId, orgId,
          source: { type: 'kb', filename: filePart.filename },
          file: { buffer: filePart.data, contentType: filePart.contentType || `text/${ext}`, filename: filePart.filename },
          metadata: phase1Metadata,
        });
        console.log(`[knowledge] ✓ Phase1 complete: file=${filePart.filename} docId=${result.documentId} segments=${result.segmentCount} promoted=${result.promotedCount} ms=${Date.now() - tPhase1}`);
        if (planEnforcer && orgId) {
          const realPages = result.pages || result.segmentCount || 1;
          planEnforcer.recordUsage(orgId, 'kbPages', realPages);
          planEnforcer.recordUsage(orgId, 'uploads', 1);
        }
        let enterprise = null;
        if (enterpriseFlag !== 'false') {
          try {
            const [{ detectDocumentType }, { extractSchema }] = await Promise.all([
              import('../knowledge/enterprise/detector.js'),
              import('../knowledge/enterprise/extractor.js'),
            ]);
            const segText = (await prisma.knowledgeSegment.findMany({
              where: { documentId: result.documentId },
              orderBy: { segmentIndex: 'asc' },
              take: 4,
              select: { content: true },
            })).map((s) => s.content).join('\n\n');
            const detection = confirmedType
              ? { type: confirmedType, confidence: 1.0, reasoning: 'caller-confirmed' }
              : await detectDocumentType(segText, { filename: filePart.filename });
            const shouldExtract = enterpriseFlag === 'true'
              || (enterpriseFlag === 'auto' && detection.type !== 'general' && (detection.confidence ?? 0) >= 0.7);
            if (shouldExtract) {
              const extracted = await extractSchema(segText, detection.type, {
                filename: filePart.filename,
              });
              enterprise = {
                detected_type: detection.type,
                confidence: detection.confidence,
                reasoning: detection.reasoning,
                schema_fields: extracted,
              };
              console.log(`[knowledge] enterprise extract type=${detection.type} conf=${detection.confidence.toFixed(2)} fields=${Object.keys(extracted || {}).length}`);
            } else {
              enterprise = {
                detected_type: detection.type,
                confidence: detection.confidence,
                extracted: false,
                reason: 'confidence below 0.7 — pass enterprise=true to force',
              };
            }
          } catch (entErr) {
            console.warn(`[knowledge] enterprise extract failed (non-fatal): ${entErr.message}`);
          }
        }
        return jsonResponse(res, {
          upload_id: crypto.randomUUID(),
          filename: filePart.filename,
          mode: 'document_first',
          documentId: result.documentId,
          segmentCount: result.segmentCount,
          candidateCount: result.candidateCount,
          promotedCount: result.promotedCount,
          promotedMemoryIds: result.promotedMemoryIds,
          ...(enterprise ? { enterprise } : {}),
        });
      } catch (phase1Err) {
        console.error('[knowledge] ✗ Canonical ingestion failed:', phase1Err.message, phase1Err.stack);
        return jsonResponse(res, {
          error: 'canonical_ingest_failed',
          message: phase1Err.message,
          code: phase1Err.code || null,
        }, phase1Err.statusCode || 500);
      }
    } else {
      console.error(`[knowledge] Canonical ingestion unavailable (ENABLE_DOCUMENT_FIRST_INGEST=${process.env.ENABLE_DOCUMENT_FIRST_INGEST})`);
      return jsonResponse(res, {
        error: 'canonical_ingest_unavailable',
        message: 'Document ingestion is temporarily unavailable.',
      }, 503);
    }

    // V5 Phase 11: legacy (pre-document-first) KB ingest path removed — provably
    // dead: every branch above returns (canonical 200 / failure 500 / unavailable 503).

  } catch (err) {
    console.error('[knowledge] Upload failed:', err.message);
    return jsonResponse(res, { error: err.message }, 500);
  }
}
