import crypto from 'crypto';

export const EVIDENCE_JOB_SOURCE = 'hyper_evidence_job';
const sha = (value) => crypto.createHash('sha256').update(String(value ?? '')).digest('hex');
const clean = (value, limit = 1200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);

async function scopedTurn(prisma, { orgId, userId, roomId, turnId }) {
  return prisma.hyperTurn.findFirst({
    where: { id: turnId, roomId, room: { orgId, userId } },
    select: { id: true, roomId: true, status: true },
  });
}

async function loadJob(prisma, ids) {
  const job = await prisma.sourceArtifact.findFirst({
    where: { id: ids.evidenceJobId, orgId: ids.orgId, userId: ids.userId, sourcePlatform: EVIDENCE_JOB_SOURCE },
  });
  if (!job || job.payload?.room_id !== ids.roomId || job.payload?.turn_id !== ids.turnId) {
    throw new Error('evidence_job_scope_mismatch');
  }
  return job;
}

async function updateJob(prisma, job, patch) {
  const payload = { ...(job.payload || {}), ...patch, updated_at: new Date().toISOString() };
  return prisma.sourceArtifact.update({ where: { id: job.id }, data: {
    payload, sizeBytes: Buffer.byteLength(JSON.stringify(payload)), checksum: sha(JSON.stringify(payload)),
  } });
}

export async function createEvidenceJob({ prisma, orgId, userId, roomId, turnId, request = {} }) {
  if (!await scopedTurn(prisma, { orgId, userId, roomId, turnId })) throw new Error('evidence_turn_not_found');
  const route = clean(request.route, 80);
  const query = clean(request.query);
  const claimId = clean(request.claim_id, 160);
  if (!route || !query || !claimId) throw new Error('evidence_request_invalid');
  const requestDigest = sha(JSON.stringify({ route, query, claimId }));
  const sourceId = `${turnId}:${requestDigest}`;
  const existing = await prisma.sourceArtifact.findFirst({ where: {
    orgId, userId, sourcePlatform: EVIDENCE_JOB_SOURCE, sourceId,
  } });
  if (existing) return existing;
  return prisma.sourceArtifact.create({ data: {
    orgId, userId, artifactType: 'evidence', sourcePlatform: EVIDENCE_JOB_SOURCE, sourceId,
    contentType: 'application/json', sizeBytes: 0, checksum: sha(sourceId),
    storageLocation: 'inline:source_artifacts.payload',
    payload: { contract: 'hyper.evidence-job.v1', state: 'queued', room_id: roomId, turn_id: turnId,
      request: { route, query, claim_id: claimId }, request_sha256: requestDigest, attempts: 0 },
    metadata: { room_id: roomId, turn_id: turnId, claim_id: claimId, route },
  } });
}

export async function prepareEvidenceJob({ prisma, ...ids }) {
  const job = await loadJob(prisma, ids);
  if (['prepared', 'received', 'complete'].includes(job.payload?.state)) return { ok: true, cached: true };
  await updateJob(prisma, job, { state: 'prepared', prepared_at: new Date().toISOString() });
  return { ok: true, route: job.payload.request.route, claim_id: job.payload.request.claim_id };
}

export async function acquireEvidenceJob({ prisma, executeResearch, ...ids }) {
  const job = await loadJob(prisma, ids);
  if (['received', 'complete'].includes(job.payload?.state)) return { ok: true, cached: true, receipt: job.payload.receipt };
  if (!['prepared', 'awaiting_retry'].includes(job.payload?.state)) throw new Error('evidence_job_not_prepared');
  const attempts = Number(job.payload.attempts || 0) + 1;
  try {
    const result = await executeResearch({ ...job.payload.request, evidence_job_id: job.id });
    const sources = (result?.sources || result?.results || []).filter((row) => row && /^https?:\/\//i.test(String(row.url || '')))
      .slice(0, 12).map((row) => ({ title: clean(row.title, 240), url: clean(row.url, 1000), excerpt: clean(row.excerpt || row.snippet, 1200) }));
    if (!sources.length) throw new Error('evidence_provider_returned_no_url_receipts');
    const receipt = { contract: 'hyper.evidence-receipt.v1', evidence_job_id: job.id,
      claim_id: job.payload.request.claim_id, route: job.payload.request.route,
      request_sha256: job.payload.request_sha256, sources,
      receipt_sha256: sha(JSON.stringify({ request: job.payload.request_sha256, sources })) };
    await updateJob(prisma, job, { state: 'received', attempts, receipt, last_error: null });
    return { ok: true, receipt };
  } catch (error) {
    await updateJob(prisma, job, { state: 'awaiting_retry', attempts, last_error: clean(error.message, 300) });
    throw error;
  }
}

export async function persistEvidenceJob({ prisma, ...ids }) {
  const job = await loadJob(prisma, ids);
  if (job.payload?.state === 'complete') return { ok: true, cached: true, receipt: job.payload.receipt };
  if (job.payload?.state !== 'received' || !job.payload?.receipt) throw new Error('evidence_receipt_missing');
  const targetRef = job.payload.receipt.receipt_sha256;
  const existing = await prisma.hyperTrial.findFirst({ where: {
    turnId: ids.turnId, trialKind: 'evidence_received', targetRef,
  } });
  if (!existing) await prisma.hyperTrial.create({ data: {
    turnId: ids.turnId, roomId: ids.roomId, orgId: ids.orgId, trialKind: 'evidence_received',
    targetRef, verdict: 'received', content: JSON.stringify(job.payload.receipt), round: 0,
  } });
  await updateJob(prisma, job, { state: 'complete', completed_at: new Date().toISOString() });
  return { ok: true, cached: Boolean(existing), receipt: job.payload.receipt };
}

export async function readEvidenceJob({ prisma, orgId, userId, evidenceJobId }) {
  const job = await prisma.sourceArtifact.findFirst({ where: {
    id: evidenceJobId, orgId, userId, sourcePlatform: EVIDENCE_JOB_SOURCE,
  } });
  return job ? { id: job.id, ...(job.payload || {}) } : null;
}
