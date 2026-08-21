import crypto from 'crypto';

export const AUTHORITY_SNAPSHOT_SCHEMA_VERSION = 1;
export const AUTHORITY_SNAPSHOT_TTL_MS = 5 * 60 * 1000;

const REPO_ID = /^repo-[a-f0-9]{16}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isIcarusRepoId(value) {
  return typeof value === 'string' && REPO_ID.test(value);
}

export function isUuid(value) {
  return typeof value === 'string' && UUID.test(value);
}

// Match ICARUS Rust's stable_json: recursively sort object keys while preserving array order.
// A transport can therefore verify the returned digest without trusting JSON object insertion
// order or a server-specific serializer.
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function authoritySnapshotDigest(snapshot) {
  const canonical = { ...snapshot, digest: '' };
  return crypto.createHash('sha256').update(stableJson(canonical)).digest('hex');
}

function boundedSummary(value) {
  const summary = String(value || '').replace(/\s+/g, ' ').trim();
  return summary.slice(0, 8_192);
}

/**
 * Build the narrow authority envelope consumed by the Rust harness.  The caller is responsible
 * for tenant and project-membership checks before passing records here.  Only explicitly tagged
 * approved decision memories become ICARUS decisions: ordinary memories, embeddings, agent
 * transcripts, credentials, and arbitrary repository data have no representation in this wire
 * type.
 */
export function buildAuthoritySnapshot({ userId, orgId, projectId, repoId, decisions, now = new Date() }) {
  if (!isIcarusRepoId(repoId)) throw new Error('invalid ICARUS repo_id');
  if (!isUuid(userId) || !isUuid(orgId) || !isUuid(projectId)) throw new Error('invalid authority scope');
  const issuedAt = new Date(now).toISOString();
  const approved = (decisions || []).map((memory) => ({
    id: String(memory.id),
    revision: String(memory.version || 1),
    status: 'approved',
    summary: boundedSummary(memory.content || memory.title),
    tags: (memory.tags || []).filter((tag) => typeof tag === 'string').slice(0, 32),
  })).filter((decision) => isUuid(decision.id) && decision.summary.length > 0);
  const revision = crypto.createHash('sha256')
    .update(stableJson(approved.map(({ id, revision: decisionRevision }) => ({ id, revision: decisionRevision }))))
    .digest('hex')
    .slice(0, 24);
  const snapshot = {
    schema_version: AUTHORITY_SNAPSHOT_SCHEMA_VERSION,
    scope: { user_id: userId, org_id: orgId, project_id: projectId },
    repo_id: repoId,
    revision,
    issued_at: issuedAt,
    expires_at: new Date(new Date(now).getTime() + AUTHORITY_SNAPSHOT_TTL_MS).toISOString(),
    decisions: approved,
    approvals: [],
    team_skills: [],
    digest: '',
  };
  snapshot.digest = authoritySnapshotDigest(snapshot);
  return snapshot;
}
