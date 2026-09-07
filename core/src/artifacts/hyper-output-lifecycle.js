import crypto from 'crypto';
import { renderLifecycleCompletionPortraitReport, extractSealedRoomOutput } from '../lifecycle/day1-first-move.js';
import { renderDayZeroOnboardingPdf } from '../email/day0-company-report-pdf.js';

export const OUTPUT_JOB_SOURCE = 'hyper_output_job';
export const OUTPUT_SKILLS = Object.freeze({
  text: { id: 'output.text.v1', version: '1.0.0', renderer: 'sealed-markdown', formats: ['md', 'json'], visual: false },
  report: { id: 'output.report.v1', version: '1.0.0', renderer: 'lifecycle-portrait-html', formats: ['html', 'pdf'], visual: true },
  presentation: { id: 'output.presentation.v1', version: '1.0.0', renderer: 'visual-presentation', formats: ['html', 'pdf'], visual: true },
  document: { id: 'output.document.v1', version: '1.0.0', renderer: 'native-docx', formats: ['docx', 'pdf'], visual: true },
  spreadsheet: { id: 'output.spreadsheet.v1', version: '1.0.0', renderer: 'native-xlsx', formats: ['xlsx', 'pdf'], visual: true },
  image: { id: 'output.image.v1', version: '1.0.0', renderer: 'governed-image', formats: ['png', 'webp', 'svg'], visual: true },
  data: { id: 'output.data.v1', version: '1.0.0', renderer: 'schema-serializer', formats: ['json', 'csv'], visual: false },
});
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const clean = (value, limit = 240) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);

export function outputContract({ family = 'report', formats, audience = 'workspace members', purpose = 'company work', deliveryRequested = false } = {}) {
  const skill = OUTPUT_SKILLS[family];
  if (!skill) throw new Error('unsupported_output_family');
  const selected = [...new Set((formats || skill.formats.slice(0, 1)).map(String))].filter((format) => skill.formats.includes(format));
  if (!selected.length) throw new Error('unsupported_output_format');
  return {
    contract: 'hyper.output-contract.v1', output_family: family, formats: selected,
    audience: clean(audience), purpose: clean(purpose), output_skill: { id: skill.id, version: skill.version },
    skill_id: skill.id, skill_version: skill.version,
    template: { id: family === 'report' ? 'portrait-report' : family, version: '1' },
    evidence_requirements: {
      citations_required: family !== 'image', claim_ledger_required: ['report', 'presentation', 'document'].includes(family),
      assumptions_separated: true, missing_evidence_policy: 'block_claim',
    },
    delivery: { requested: deliveryRequested === true, approval_required: deliveryRequested === true },
  };
}
async function latestBrandReference(prisma, orgId) {
  const run = await prisma.visualIntelligenceRun.findFirst({
    where: { orgId, status: 'completed', deliverable: 'brand_dna_v1' },
    orderBy: [{ processingVersion: 'desc' }, { finishedAt: 'desc' }],
    select: { id: true, processingVersion: true, finishedAt: true, artifact: true },
  }).catch(() => null);
  const artifact = run?.artifact && typeof run.artifact === 'object' ? run.artifact : null;
  const brief = artifact?.visual_generation_brief;
  if (!run || artifact?.artifact_type !== 'brand_dna' || !brief || typeof brief !== 'object' || !Object.keys(brief).length) return null;
  return {
    contract: 'hyper.brand-dna-skill-reference.v1', artifact_type: 'brand_dna', run_id: run.id,
    version: String(artifact.version || `visual-intelligence-v${run.processingVersion}`).slice(0, 120),
    verified_at: run.finishedAt, evidence_count: Array.isArray(artifact.evidence) ? artifact.evidence.length : 0,
    visual_generation_brief: brief,
  };
}
async function scopedTurn(prisma, { orgId, userId, roomId, turnId }) {
  return prisma.hyperTurn.findFirst({
    where: { id: turnId, roomId, room: { orgId, userId } },
    select: { id: true, roomId: true, status: true, sealedAt: true, lines: true, room: { select: { name: true, goal: true } } },
  });
}
export async function createOutputJob({ prisma, orgId, userId, roomId, turnId, request = {} }) {
  const turn = await scopedTurn(prisma, { orgId, userId, roomId, turnId });
  if (!turn) throw new Error('output_turn_not_found');
  if (!turn.sealedAt || !['complete', 'blocked'].includes(turn.status)) throw new Error('output_turn_not_sealed');
  const contract = outputContract(request);
  const visualSkill = OUTPUT_SKILLS[contract.output_family]?.visual
    ? await latestBrandReference(prisma, orgId) : null;
  contract.brand_reference = visualSkill;
  contract.brand_fallback = visualSkill ? null : 'governed-house-style';
  const digest = sha(JSON.stringify(contract));
  const sourceId = turnId + ':' + digest;
  const existing = await prisma.sourceArtifact.findFirst({ where: { orgId, userId, sourcePlatform: OUTPUT_JOB_SOURCE, sourceId } });
  if (existing) return existing;
  return prisma.sourceArtifact.create({ data: {
    orgId, userId, artifactType: 'generated', sourcePlatform: OUTPUT_JOB_SOURCE, sourceId,
    contentType: 'application/json', sizeBytes: 0, checksum: sha(sourceId),
    storageLocation: 'inline:source_artifacts.payload',
    payload: { contract: 'hyper.output-job.v1', state: 'queued', room_id: roomId, turn_id: turnId, output_contract: contract, contract_sha256: digest },
    metadata: { room_id: roomId, turn_id: turnId, output_family: contract.output_family, skill_id: contract.skill_id },
  } });
}
async function loadJob(prisma, ids) {
  const job = await prisma.sourceArtifact.findFirst({
    where: { id: ids.outputJobId, orgId: ids.orgId, userId: ids.userId, sourcePlatform: OUTPUT_JOB_SOURCE },
  });
  if (!job || job.payload?.room_id !== ids.roomId || job.payload?.turn_id !== ids.turnId) throw new Error('output_job_scope_mismatch');
  return job;
}
async function updateJob(prisma, job, patch) {
  const payload = { ...(job.payload || {}), ...patch, updated_at: new Date().toISOString() };
  return prisma.sourceArtifact.update({ where: { id: job.id }, data: {
    payload, sizeBytes: Buffer.byteLength(JSON.stringify(payload)), checksum: sha(JSON.stringify(payload)),
  } });
}
export async function prepareOutputJob({ prisma, ...ids }) {
  const job = await loadJob(prisma, ids);
  const turn = await scopedTurn(prisma, ids);
  if (!turn?.sealedAt || !['complete', 'blocked'].includes(turn.status)) throw new Error('output_turn_not_sealed');
  const output = extractSealedRoomOutput(turn.lines);
  if (!output) throw new Error('sealed_output_missing');
  const prepared = { source_sha256: sha(output), source_length: Buffer.byteLength(output), source_status: turn.status, title: clean(turn.room?.name || 'HyperAgents report', 160) };
  await updateJob(prisma, job, { state: 'prepared', prepared });
  return { ok: true, ...prepared, skill_id: job.payload.output_contract.skill_id };
}
export async function renderOutputJob({ prisma, renderPdf = renderDayZeroOnboardingPdf, ...ids }) {
  const job = await loadJob(prisma, ids);
  if (!['prepared', 'rendered', 'validated', 'complete'].includes(job.payload?.state)) throw new Error('output_job_not_prepared');
  if (['rendered', 'validated', 'complete'].includes(job.payload.state)) return { ok: true, cached: true };
  const turn = await scopedTurn(prisma, ids);
  const output = extractSealedRoomOutput(turn?.lines);
  const contract = job.payload.output_contract;
  let html = ''; let text = '';
  if (contract.output_family === 'text' || contract.output_family === 'data') text = output;
  else if (contract.output_family === 'report') {
    html = renderLifecycleCompletionPortraitReport({
      companyName: 'Company', taskTitle: job.payload.prepared.title, output,
      roomUrl: '/hivemind/app/employees/rooms/' + ids.roomId, completedAt: turn.sealedAt,
      characters: [], dayLabel: 'HYPERAGENTS / GOVERNED OUTPUT',
    });
  } else if (contract.output_family === 'presentation') {
    const artifact = await prisma.sourceArtifact.findFirst({
      where: {
        orgId: ids.orgId, userId: ids.userId, sourcePlatform: 'hyper_room_artifact',
        sourceId: `${ids.roomId}:${ids.turnId}`,
      },
      orderBy: { createdAt: 'desc' },
      select: { payload: true, checksum: true },
    });
    if (artifact?.payload?.intent?.kind !== 'presentation' || !artifact?.payload?.receipt?.rendered) {
      throw new Error('requested_presentation_artifact_missing');
    }
    html = String(artifact.payload.html || '');
    if (!html || sha(html) !== artifact.checksum) throw new Error('presentation_artifact_receipt_mismatch');
  } else throw new Error('renderer_not_available_' + contract.output_family);
  let pdf = null;
  if (contract.formats.includes('pdf')) {
    if (!html) throw new Error('pdf_requires_html_source');
    pdf = (await renderPdf(html)).toString('base64');
  }
  const rendered = {
    html: html || null, text: text || null, pdf_base64: pdf,
    html_sha256: html ? sha(html) : null, text_sha256: text ? sha(text) : null,
    pdf_sha256: pdf ? sha(Buffer.from(pdf, 'base64')) : null,
  };
  await updateJob(prisma, job, { state: 'rendered', rendered });
  return { ok: true, formats: contract.formats, digests: { html: rendered.html_sha256, text: rendered.text_sha256, pdf: rendered.pdf_sha256 } };
}
export async function validateOutputJob({ prisma, ...ids }) {
  const job = await loadJob(prisma, ids);
  const rendered = job.payload?.rendered || {};
  const errors = [];
  if (rendered.html && (!/^\s*<!doctype html>/i.test(rendered.html) || !/<h1(?:\s|>)/i.test(rendered.html))) errors.push('invalid_html');
  if (rendered.pdf_base64) {
    const pdf = Buffer.from(rendered.pdf_base64, 'base64');
    if (pdf.length < 1000 || pdf.subarray(0, 5).toString() !== '%PDF-') errors.push('invalid_pdf');
  }
  if (!rendered.html && !rendered.text && !rendered.pdf_base64) errors.push('empty_artifact');
  const validation = { ok: errors.length === 0, errors, checked_at: new Date().toISOString() };
  await updateJob(prisma, job, { state: validation.ok ? 'validated' : 'blocked', validation });
  if (!validation.ok) throw new Error('output_validation_failed:' + errors.join(','));
  return validation;
}
export async function persistOutputJob({ prisma, ...ids }) {
  const job = await loadJob(prisma, ids);
  if (job.payload?.state === 'complete') return job.payload.receipt;
  if (job.payload?.state !== 'validated') throw new Error('output_job_not_validated');
  const rendered = job.payload.rendered || {};
  const receipt = {
    contract: 'hyper.output-receipt.v1', ok: true, output_job_id: job.id,
    output_family: job.payload.output_contract.output_family, skill_id: job.payload.output_contract.skill_id,
    formats: job.payload.output_contract.formats, contract_sha256: job.payload.contract_sha256,
    source_sha256: job.payload.prepared.source_sha256,
    brand_reference: job.payload.output_contract.brand_reference || null,
    brand_fallback: job.payload.output_contract.brand_fallback || null,
    artifacts: Object.fromEntries(Object.entries({ html: rendered.html_sha256, text: rendered.text_sha256, pdf: rendered.pdf_sha256 }).filter(([, value]) => value)),
    delivery: job.payload.output_contract.delivery.requested
      ? { status: 'waiting_for_approval', approval_bound_to: rendered.pdf_sha256 || rendered.html_sha256 || rendered.text_sha256 }
      : { status: 'not_requested' },
  };
  await updateJob(prisma, job, { state: 'complete', receipt, completed_at: new Date().toISOString() });
  return receipt;
}
export async function readOutputJob({ prisma, orgId, userId, outputJobId }) {
  const job = await prisma.sourceArtifact.findFirst({ where: { id: outputJobId, orgId, userId, sourcePlatform: OUTPUT_JOB_SOURCE } });
  if (!job) return null;
  const payload = { ...(job.payload || {}) };
  if (payload.rendered) payload.rendered = {
    html: payload.rendered.html ? '[persisted]' : null, text: payload.rendered.text ? '[persisted]' : null,
    pdf_base64: payload.rendered.pdf_base64 ? '[persisted]' : null,
    html_sha256: payload.rendered.html_sha256, text_sha256: payload.rendered.text_sha256, pdf_sha256: payload.rendered.pdf_sha256,
  };
  return { id: job.id, ...payload };
}
