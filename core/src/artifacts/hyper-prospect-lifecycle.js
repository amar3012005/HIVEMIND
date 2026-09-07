import crypto from 'crypto';
import { executeGovernedResearchTool } from '../connectors/composio/runtime-adapter.js';

export const PROSPECT_JOB_SOURCE = 'hyper_prospect_job';
const sha = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const uuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));

export function findProspectingContract(lines = []) {
  const event = [...(Array.isArray(lines) ? lines : [])].reverse().find((line) => line?.t === 'turn_contract' && line?.prospecting_contract);
  return event?.prospecting_contract || null;
}

export function normalizeCandidates(rows = []) {
  const seen = new Set();
  return (Array.isArray(rows) ? rows : []).filter((row) => row && typeof row === 'object').map((row) => ({
    name: String(row.name || row.company_name || row.title || '').trim().slice(0, 240),
    website: String(row.website || row.url || '').trim().slice(0, 1000) || null,
    email: String(row.email || '').trim().toLowerCase().slice(0, 320) || null,
    phone: String(row.phone || '').trim().slice(0, 80) || null,
    address: String(row.address || row.location || '').trim().slice(0, 500) || null,
    source_urls: [...new Set((row.source_urls || row.citations || []).map(String).filter((url) => /^https?:\/\//i.test(url)))].slice(0, 12),
  })).filter((row) => {
    if (!row.name) return false;
    const key = `${row.name.toLowerCase()}|${(row.website || '').toLowerCase()}|${row.email || ''}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

export function parityMetrics({ legacy = [], candidate = [], contract }) {
  const requested = Number(contract?.request?.requested_count || 0);
  const verified = candidate.filter((row) => row.source_urls?.length || row.website).length;
  const contactable = candidate.filter((row) => row.email || row.phone).length;
  return {
    requested, legacy_count: legacy.length, candidate_count: candidate.length,
    verified_count: verified, contactable_count: contactable,
    duplicate_count: Math.max(0, candidate.length - normalizeCandidates(candidate).length),
    count_parity: requested ? candidate.length >= Math.min(requested, legacy.length || requested) : candidate.length >= legacy.length,
    evidence_coverage: candidate.length ? verified / candidate.length : 0,
  };
}

async function scopedTurn(prisma, ids) {
  return prisma.hyperTurn.findFirst({ where: { id: ids.turnId, roomId: ids.roomId, room: { orgId: ids.orgId, userId: ids.userId } }, select: { id: true, status: true, sealedAt: true, lines: true } });
}
async function loadJob(prisma, ids) {
  const job = await prisma.sourceArtifact.findFirst({ where: { id: ids.prospectJobId, orgId: ids.orgId, userId: ids.userId, sourcePlatform: PROSPECT_JOB_SOURCE } });
  if (!job || job.payload?.room_id !== ids.roomId || job.payload?.turn_id !== ids.turnId) throw new Error('prospect_job_scope_mismatch');
  return job;
}
async function updateJob(prisma, job, patch) {
  const payload = { ...(job.payload || {}), ...patch, updated_at: new Date().toISOString() };
  return prisma.sourceArtifact.update({ where: { id: job.id }, data: { payload, sizeBytes: Buffer.byteLength(JSON.stringify(payload)), checksum: sha(JSON.stringify(payload)) } });
}

export async function createProspectJob({ prisma, orgId, userId, roomId, turnId }) {
  if (![orgId, userId, roomId, turnId].every(uuid)) throw new Error('scoped_uuid_required');
  const turn = await scopedTurn(prisma, { orgId, userId, roomId, turnId });
  if (!turn?.sealedAt) throw new Error('prospect_turn_not_sealed');
  const contract = findProspectingContract(turn.lines);
  if (!contract || contract.contract !== 'prospecting_contract.v1') throw new Error('prospecting_contract_missing');
  const digest = sha(JSON.stringify(contract)); const sourceId = `${turnId}:${digest}`;
  const existing = await prisma.sourceArtifact.findFirst({ where: { orgId, userId, sourcePlatform: PROSPECT_JOB_SOURCE, sourceId } });
  if (existing) return existing;
  return prisma.sourceArtifact.create({ data: { orgId, userId, artifactType: 'generated', sourcePlatform: PROSPECT_JOB_SOURCE, sourceId, contentType: 'application/json', sizeBytes: 0, checksum: sha(sourceId), storageLocation: 'inline:source_artifacts.payload', payload: { contract: 'hyper.prospect-job.v1', state: 'queued', room_id: roomId, turn_id: turnId, prospecting_contract: contract, contract_sha256: digest }, metadata: { room_id: roomId, turn_id: turnId, mode: contract.mode, route: contract.research_route?.primary } } });
}

export async function prepareProspectJob({ prisma, ...ids }) {
  const job = await loadJob(prisma, ids); const contract = job.payload.prospecting_contract;
  if (!['off', 'shadow', 'canary', 'primary'].includes(contract?.mode)) throw new Error('invalid_prospect_mode');
  const prepared = { mode: contract.mode, route: contract.research_route, requested_count: contract.request.requested_count, side_effects_allowed: contract.mode === 'primary' && contract.room_policy?.external_effects_allowed === true };
  await updateJob(prisma, job, { state: 'prepared', prepared }); return { ok: true, ...prepared };
}

export async function discoverProspectJob({ prisma, executeResearch = executeGovernedResearchTool, ...ids }) {
  const job = await loadJob(prisma, ids); if (!['prepared', 'discovered'].includes(job.payload.state)) throw new Error('prospect_job_not_prepared');
  if (job.payload.state === 'discovered') return { ok: true, cached: true };
  const contract = job.payload.prospecting_contract; const lane = contract.research_route?.primary;
  let provider = { shadow: contract.mode === 'shadow', capability: lane };
  if (String(lane || '').startsWith('parallel_')) {
    provider = await executeResearch(ids.orgId, lane, { objective: contract.request, match_limit: contract.request.requested_count }, { mode: contract.mode });
  }
  const raw = provider?.candidates || provider?.matches || provider?.results || provider?.data?.candidates || [];
  await updateJob(prisma, job, { state: 'discovered', discovery: { lane, provider_receipt: { shadow: provider?.shadow === true, capability: provider?.capability || lane }, raw_candidates: raw } });
  return { ok: true, lane, shadow: provider?.shadow === true, candidates: raw.length };
}

export async function normalizeProspectJob({ prisma, ...ids }) {
  const job = await loadJob(prisma, ids); const candidates = normalizeCandidates(job.payload.discovery?.raw_candidates || []);
  await updateJob(prisma, job, { state: 'normalized', candidates }); return { ok: true, candidates: candidates.length };
}

export async function verifyProspectJob({ prisma, ...ids }) {
  const job = await loadJob(prisma, ids); const candidates = job.payload.candidates || [];
  const verified = candidates.map((row) => ({ ...row, verification: { status: row.website || row.source_urls?.length ? 'evidence_present' : 'unverified', checked_at: new Date().toISOString() } }));
  await updateJob(prisma, job, { state: 'verified', candidates: verified }); return { ok: true, verified: verified.filter((row) => row.verification.status === 'evidence_present').length };
}

export async function enrichProspectJob({ prisma, executeResearch = executeGovernedResearchTool, ...ids }) {
  const job = await loadJob(prisma, ids); const contract = job.payload.prospecting_contract;
  const candidates = job.payload.candidates || [];
  if (contract.mode === 'shadow' || !candidates.length) {
    const enrichment = { status: 'skipped', reason: contract.mode === 'shadow' ? 'shadow_mode' : 'no_verified_candidates', enriched: 0 };
    await updateJob(prisma, job, { state: 'enriched', enrichment }); return { ok: true, ...enrichment };
  }
  const result = await executeResearch(ids.orgId, 'parallel_enrichment', { candidates, objective: contract.request }, { mode: contract.mode });
  const enrichment = { status: 'completed', enriched: Number(result?.enriched || result?.count || 0), provider_receipt: { capability: 'parallel_enrichment' } };
  await updateJob(prisma, job, { state: 'enriched', enrichment }); return { ok: true, ...enrichment };
}

export async function qualifyProspectJob({ prisma, ...ids }) {
  const job = await loadJob(prisma, ids); const rows = job.payload.candidates || [];
  const qualified = rows.map((row) => ({ ...row, qualification: { eligible: row.verification?.status === 'evidence_present', reason: row.verification?.status === 'evidence_present' ? 'source_backed_candidate' : 'missing_evidence' } }));
  await updateJob(prisma, job, { state: 'qualified', candidates: qualified }); return { ok: true, qualified: qualified.filter((row) => row.qualification.eligible).length };
}

export async function prepareProspectOutreach({ prisma, ...ids }) {
  const job = await loadJob(prisma, ids); const contract = job.payload.prospecting_contract;
  const eligible = (job.payload.candidates || []).filter((row) => row.qualification?.eligible);
  const assignments = eligible.map((row) => ({ candidate: row.name, channels: [contract.request.draft ? 'cold_email_draft' : null, contract.request.call ? 'cold_call_brief' : null].filter(Boolean), executable: false }));
  const outreachPreparation = { status: assignments.length ? 'prepared_assignments' : 'no_qualified_candidates', assignments, editable: true, external_actions_executed: 0 };
  await updateJob(prisma, job, { state: 'outreach_prepared', outreach_preparation: outreachPreparation }); return { ok: true, ...outreachPreparation };
}

export async function gateProspectApproval({ prisma, ...ids }) {
  const job = await loadJob(prisma, ids); const contract = job.payload.prospecting_contract;
  const requested = contract.request.deliver || contract.request.call;
  const approval = !requested ? { status: 'not_required' }
    : contract.mode === 'shadow' ? { status: 'blocked_by_shadow', reason: 'shadow_mode_cannot_execute_external_actions' }
      : { status: 'waiting_for_approval', approval_bound_to: sha(JSON.stringify(job.payload.outreach_preparation || {})) };
  await updateJob(prisma, job, { state: approval.status === 'waiting_for_approval' ? 'waiting_approval' : 'approval_gated', approval });
  return { ok: true, ...approval };
}

export async function compareProspectJob({ prisma, ...ids }) {
  const job = await loadJob(prisma, ids); const turn = await scopedTurn(prisma, ids);
  const legacy = normalizeCandidates((turn?.lines || []).flatMap((line) => line?.prospects || line?.records || []));
  const metrics = parityMetrics({ legacy, candidate: job.payload.candidates || [], contract: job.payload.prospecting_contract });
  const promotion = { eligible: job.payload.prospecting_contract.mode !== 'shadow' && metrics.count_parity && metrics.evidence_coverage >= 0.8, thresholds: { evidence_coverage: 0.8, count_parity: true } };
  await updateJob(prisma, job, { state: 'compared', parity: metrics, promotion }); return { ok: true, metrics, promotion };
}

export async function persistProspectJob({ prisma, ...ids }) {
  const job = await loadJob(prisma, ids); if (job.payload.state === 'complete') return job.payload.receipt;
  if (job.payload.state !== 'compared') throw new Error('prospect_job_not_compared');
  const contract = job.payload.prospecting_contract;
  const receipt = { contract: 'hyper.prospect-receipt.v1', prospect_job_id: job.id, mode: contract.mode, route: contract.research_route, contract_sha256: job.payload.contract_sha256, candidate_digest: sha(JSON.stringify(job.payload.candidates || [])), candidate_count: (job.payload.candidates || []).length, parity: job.payload.parity, promotion: job.payload.promotion, outreach: { draft_requested: contract.request.draft, call_requested: contract.request.call, external_actions_executed: 0, approval_required: contract.governance.approval_required } };
  await updateJob(prisma, job, { state: 'complete', receipt, completed_at: new Date().toISOString() }); return receipt;
}

export async function readProspectJob({ prisma, orgId, userId, prospectJobId }) {
  const job = await prisma.sourceArtifact.findFirst({ where: { id: prospectJobId, orgId, userId, sourcePlatform: PROSPECT_JOB_SOURCE } });
  return job ? { id: job.id, ...(job.payload || {}) } : null;
}
