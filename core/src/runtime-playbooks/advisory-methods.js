/** Tenant-scoped advisory methods; never executable stages or task-completion gates. */
import { createHash, randomUUID } from 'node:crypto';
import { isOrganizationAdmin } from '../workspace/access-policy.js';
import { effectiveRoles, hasPermission } from '../auth/permissions.js';

export class AdvisoryMethodError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
function fail(code, status) { throw new AdvisoryMethodError(code, status); }
function text(value, max, key) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`advisory_invalid_${key}`);
  return value;
}
function strings(value, max, key) {
  if (!Array.isArray(value) || value.length > max || value.some(v => typeof v !== 'string' || !v.trim() || v.length > 500))
    fail(`advisory_invalid_${key}`);
  return [...new Set(value)];
}
export function normalizeAdvisoryProposal(input) {
  const methodId = text(input.method_id, 160, 'method_id');
  if (!/^company-[a-z0-9-]{1,152}$/.test(methodId)) fail('advisory_invalid_method_id');
  if (!Number.isSafeInteger(input.prior_version) || input.prior_version < 0 || input.prior_version > 2147483646) fail('advisory_invalid_prior_version');
  const body = input.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('advisory_invalid_body');
  if (!Array.isArray(input.evidence_refs) || input.evidence_refs.length === 0) fail('advisory_evidence_required');
  const normalized = {
    title: text(body.title, 180, 'title'), description: text(body.description, 1000, 'description'),
    content: text(body.content, 24000, 'content'), domains: strings(body.domains, 12, 'domains'),
    intents: strings(body.intents || [], 12, 'intents'), parentGlobalIds: strings(body.parentGlobalIds || [], 8, 'parents'),
    limitations: text(body.limitations, 2400, 'limitations'),
  };
  return { methodId, priorVersion: input.prior_version, body: normalized,
    rationale: text(input.rationale, 4000, 'rationale'), evidenceRefs: strings(input.evidence_refs, 24, 'evidence_refs') };
}
export function advisoryProposalHash(principal, proposal) {
  return createHash('sha256').update(JSON.stringify({ orgId: principal.orgId, userId: principal.userId, ...proposal })).digest('hex');
}
async function membership(db, principal, admin = false) {
  if (!principal?.orgId || !principal?.userId) fail('advisory_tenant_required', 403);
  const row = await db.userOrganization.findUnique({ where: { userId_orgId: { userId: principal.userId, orgId: principal.orgId } } });
  if (!row?.isActive || effectiveRoles(row).includes('guest') || effectiveRoles(row).includes('service_account') || (admin && !(isOrganizationAdmin(row) || hasPermission(effectiveRoles(row), 'org', 'manage'))))
    fail('advisory_not_authorized', 403);
}
async function latest(db, orgId, methodId) {
  const rows = await db.$queryRawUnsafe('SELECT COALESCE(MAX(version),0)::integer AS version FROM hivemind.advisory_playbook_revisions WHERE organization_id=$1::uuid AND method_id=$2 AND status=\'approved\'', orgId, methodId);
  return rows[0].version;
}
export async function proposeAdvisoryMethod(db, principal, input) {
  await membership(db, principal);
  const proposal = normalizeAdvisoryProposal(input);
  const hash = advisoryProposalHash(principal, proposal);
  const rows = await db.$queryRawUnsafe(`INSERT INTO hivemind.advisory_playbook_revisions
    (id,organization_id,proposed_by_user_id,method_id,prior_version,version,body,rationale,evidence_refs,content_hash)
    VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10)
    ON CONFLICT (organization_id,proposed_by_user_id,content_hash) DO UPDATE SET content_hash=EXCLUDED.content_hash
    RETURNING *`, randomUUID(), principal.orgId, principal.userId, proposal.methodId, proposal.priorVersion,
    proposal.priorVersion + 1, JSON.stringify(proposal.body), proposal.rationale, JSON.stringify(proposal.evidenceRefs), hash);
  return rows[0];
}
export async function readAdvisoryMethods(db, principal, id) {
  await membership(db, principal);
  if (id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) fail('advisory_invalid_id');
  if (id) return (await db.$queryRawUnsafe('SELECT * FROM hivemind.advisory_playbook_revisions WHERE organization_id=$1::uuid AND id=$2::uuid', principal.orgId, id))[0] || null;
  return db.$queryRawUnsafe(`SELECT DISTINCT ON (method_id) * FROM hivemind.advisory_playbook_revisions
    WHERE organization_id=$1::uuid AND status='approved' ORDER BY method_id,version DESC LIMIT 50`, principal.orgId);
}
export async function decideAdvisoryMethod(db, principal, id, hash, approved) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) fail('advisory_invalid_id');
  if (typeof approved !== 'boolean') fail('advisory_invalid_decision');
  // Native model answers/service tickets cannot claim human publication authority.
  if (principal?.kind !== 'human-session') fail('advisory_human_session_required', 403);
  await membership(db, principal, true);
  return db.$transaction(async tx => {
    const row = (await tx.$queryRawUnsafe('SELECT * FROM hivemind.advisory_playbook_revisions WHERE organization_id=$1::uuid AND id=$2::uuid FOR UPDATE', principal.orgId, id))[0];
    if (!row) fail('advisory_not_found', 404);
    if (row.content_hash !== hash) fail('advisory_approval_hash_mismatch', 409);
    if (row.status !== 'pending') {
      if (row.status === (approved ? 'approved' : 'rejected')) return row;
      fail('advisory_already_decided', 409);
    }
    await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', `${principal.orgId}:${row.method_id}`);
    if (approved && await latest(tx, principal.orgId, row.method_id) !== row.prior_version)
      fail('advisory_prior_version_conflict', 409);
    return (await tx.$queryRawUnsafe(`UPDATE hivemind.advisory_playbook_revisions SET status=$3,approved_by_user_id=$4::uuid,decided_at=now()
      WHERE organization_id=$1::uuid AND id=$2::uuid RETURNING *`, principal.orgId, id, approved ? 'approved' : 'rejected', principal.userId))[0];
  });
}
