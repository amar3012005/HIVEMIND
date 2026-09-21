import { internalFetch } from '../internal/internal-fetch.js';
import crypto from 'node:crypto';
import { appendWorkRunEvent, completeWorkRun } from '../employees/work-runs.js';

const UUID = /^[0-9a-f-]{36}$/i;
const GLOBAL_PLAYBOOKS = Object.freeze([
  { id: 'global:general', name: 'General', description: 'Use company context only when needed; choose a specific playbook only when it helps.', scope: 'global', version: '1.0.0', instructions: 'Answer directly when possible. For company work, inspect context, select relevant capabilities, then use AgentScope Tasks to plan and execute.' },
  { id: 'global:prospect-discovery', name: 'Prospect discovery', description: 'Discover, verify, and qualify ICP-matching companies.', scope: 'global', version: '1.0.0', instructions: 'Read company context and existing prospects. Create native Tasks with dependencies. Verify against first-party sources. Save only qualified prospects and register the resulting artifact.' },
  { id: 'global:market-research', name: 'Market research', description: 'Create a sourced market brief.', scope: 'global', version: '1.0.0', instructions: 'Read company context, create native Tasks, use primary sources, distinguish facts from inference, and register a written artifact.' },
  { id: 'global:competitive-analysis', name: 'Competitive analysis', description: 'Compare named competitors with evidence.', scope: 'global', version: '1.0.0', instructions: 'Create a native Task plan. Verify competitor claims, cite sources, and register the comparison artifact.' },
]);

function asEntries(value, scope) {
  const raw = Array.isArray(value) ? value : Array.isArray(value?.playbooks) ? value.playbooks : value ? [value] : [];
  return raw.map((item, index) => {
    const value = item && typeof item === 'object' ? item : {};
    const instructions = typeof item === 'string' ? item : String(value.instructions || value.content || value.text || '').trim();
    if (!instructions) return null;
    const safe = String(value.id || value.slug || value.name || `${scope}-${index + 1}`).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
    return { id: `${scope}:${safe}`, name: String(value.name || value.title || `${scope} playbook ${index + 1}`), description: String(value.description || `${scope} operating guidance.`), scope, version: String(value.version || '1.0.0'), instructions };
  }).filter(Boolean);
}

async function principal(req, prisma) {
  const userId = String(req.headers['x-hm-user-id'] || '').replace(/^org:[0-9a-f-]{36}:user:/i, '');
  const askedOrg = String(req.headers['x-hm-org-id'] || '').trim();
  if (!UUID.test(userId)) return { error: 'X-HM-User-Id must be a valid UUID' };
  const membership = await prisma.userOrganization.findFirst({
    where: { userId, isActive: true, ...(UUID.test(askedOrg) ? { orgId: askedOrg } : {}) },
    orderBy: { joinedAt: 'asc' }, select: { orgId: true },
  });
  return membership ? { userId, orgId: membership.orgId } : { error: 'No active organization membership exists.' };
}

async function workRunScope(prisma, sessionId, p) {
  if (!sessionId) return { roomPlaybook: null, localPlaybooks: null, runId: null };
  const rows = await prisma.$queryRawUnsafe(
    `SELECT w.id, w.scope, r.room_playbook FROM "hivemind"."work_runs" w JOIN "hivemind"."hyper_rooms" r ON r.id = w.room_id
     WHERE w.agentscope_session_id = $1 AND w.user_id = $2::uuid AND w.org_id = $3::uuid LIMIT 1`, sessionId, p.userId, p.orgId,
  );
  const row = rows?.[0] || {};
  return { roomPlaybook: row.room_playbook, localPlaybooks: row.scope?.local_playbooks, runId: row.id || null };
}

function decodeArtifact(contentBase64) {
  const encoded = String(contentBase64 || '').replace(/\s/g, '');
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
    throw new Error('content_base64 must be valid base64 data');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length) throw new Error('Artifact content must not be empty');
  if (bytes.length > 8 * 1024 * 1024) throw new Error('Artifact exceeds the 8 MiB WorkRun limit');
  return bytes;
}

async function scopedWorkRun(prisma, sessionId, p) {
  if (!sessionId) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, room_id, turn_id, status FROM "hivemind"."work_runs"
     WHERE agentscope_session_id = $1 AND user_id = $2::uuid AND org_id = $3::uuid LIMIT 1`,
    sessionId, p.userId, p.orgId,
  );
  return rows?.[0] || null;
}

export async function handleAgentScopeCapabilityRoute({ req, res, parseBody, jsonResponse, prisma, pathname }) {
  const p = await principal(req, prisma);
  if (p.error) return jsonResponse(res, { error: p.error }, 403);
  const body = req.method === 'GET' ? {} : await parseBody(req).catch(() => ({}));
  if (pathname === '/internal/hivemind/company-context') {
    const rooms = await prisma.$queryRawUnsafe(
      `SELECT name, goal, "agent_connectors"->'_company' AS company FROM "hivemind"."hyper_rooms"
       WHERE org_id = $1::uuid AND archived_at IS NULL AND "agent_connectors" ? '_company' ORDER BY created_at DESC LIMIT 1`, p.orgId,
    );
    const user = await prisma.user.findUnique({ where: { id: p.userId }, select: { id: true, email: true, displayName: true } });
    const company = rooms?.[0]?.company || null;
    return jsonResponse(res, { status: 'completed', operator: user ? { user_id: user.id, email: user.email, full_name: user.displayName || null } : null, company: company || null, note: company ? undefined : 'No company profile is on file.' });
  }
  if (pathname === '/internal/hivemind/playbooks' || pathname === '/internal/hivemind/playbooks/get') {
    const scope = await workRunScope(prisma, String(body?.agentscope_session_id || ''), p);
    const catalog = [...GLOBAL_PLAYBOOKS, ...asEntries(scope.roomPlaybook, 'org'), ...asEntries(scope.localPlaybooks, 'local')];
    if (pathname.endsWith('/get')) {
      const playbook = catalog.find((entry) => entry.id === String(body?.id || ''));
      if (!playbook) return jsonResponse(res, { error: 'unknown playbook' }, 404);
      if (scope.runId) await prisma.$queryRawUnsafe(
        'UPDATE "hivemind"."work_runs" SET playbook_id = $2, playbook_version = $3, updated_at = now() WHERE id = $1::uuid', scope.runId, playbook.id, playbook.version,
      );
      return jsonResponse(res, { status: 'completed', playbook });
    }
    return jsonResponse(res, { status: 'completed', playbooks: catalog.map(({ instructions, ...entry }) => entry) });
  }
  if (pathname === '/internal/hivemind/recall') {
    const query = String(body?.query || '').trim();
    if (!query) return jsonResponse(res, { error: 'query is required' }, 400);
    const response = await internalFetch(`${String(process.env.HIVEMIND_CORE_API_BASE_URL || process.env.HIVEMIND_API_URL || 'http://localhost:8050').replace(/\/$/, '')}/api/recall`, { service: 'hm-core', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { query, limit: Math.max(1, Math.min(25, Number(body.limit) || 8)), mode: 'quick' }, userId: p.userId, orgId: p.orgId, timeoutMs: 60_000 });
    const payload = await response.json().catch(() => ({}));
    return jsonResponse(res, payload, response.status);
  }
  if (pathname === '/internal/hivemind/artifacts') {
    const sessionId = String(body?.agentscope_session_id || '').trim();
    const run = await scopedWorkRun(prisma, sessionId, p);
    if (!run) return jsonResponse(res, { error: 'No active WorkRun matches this AgentScope session.' }, 404);
    let bytes;
    try { bytes = decodeArtifact(body?.content_base64); }
    catch (error) { return jsonResponse(res, { error: error.message }, 400); }
    const path = String(body?.path || '').trim().replace(/^\/+/, '');
    const title = String(body?.title || '').trim();
    if (!path || path.includes('..') || !title) return jsonResponse(res, { error: 'A safe relative path and title are required.' }, 400);
    const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
    const artifact = await prisma.sourceArtifact.upsert({
      where: { userId_orgId_checksum_sourcePlatform: { userId: p.userId, orgId: p.orgId, checksum, sourcePlatform: 'agentscope_workrun' } },
      create: {
        userId: p.userId, orgId: p.orgId, artifactType: 'generated', sourcePlatform: 'agentscope_workrun',
        sourceId: `${run.id}:${path}`, contentType: String(body?.content_type || 'application/octet-stream').slice(0, 100),
        sizeBytes: bytes.length, checksum, storageLocation: 'inline:source_artifacts.payload',
        payload: { contract: 'agentscope-workrun-artifact.v1', content_base64: bytes.toString('base64'), title, path },
        metadata: { workrun_id: run.id, room_id: run.room_id, turn_id: run.turn_id, path, title },
      },
      update: {},
      select: { id: true, checksum: true, contentType: true, sizeBytes: true, createdAt: true },
    });
    await prisma.$queryRawUnsafe(
      `UPDATE "hivemind"."work_runs"
       SET result_artifact_ids = CASE WHEN result_artifact_ids ? $2 THEN result_artifact_ids ELSE result_artifact_ids || jsonb_build_array($2::text) END,
           updated_at = now() WHERE id = $1::uuid`, run.id, artifact.id,
    );
    await appendWorkRunEvent(prisma, run.id, { t: 'artifact.created', artifact_id: artifact.id, path, title, ts: Date.now() });
    return jsonResponse(res, { status: 'completed', artifact: { id: artifact.id, title, path, content_type: artifact.contentType, size_bytes: Number(artifact.sizeBytes), checksum: artifact.checksum } });
  }
  if (pathname === '/internal/hivemind/workruns/complete') {
    const run = await scopedWorkRun(prisma, String(body?.agentscope_session_id || '').trim(), p);
    if (!run) return jsonResponse(res, { error: 'No active WorkRun matches this AgentScope session.' }, 404);
    const summary = String(body?.summary || '').trim();
    if (!summary) return jsonResponse(res, { error: 'summary is required' }, 400);
    const outcome = await completeWorkRun(prisma, run.id, { result: { summary, completed_by: 'agentscope' } });
    if (!outcome.ok) return jsonResponse(res, { error: outcome.reason || 'Unable to complete WorkRun.' }, 409);
    return jsonResponse(res, { status: 'completed', workrun_id: run.id, result: outcome.run?.result || { summary } });
  }
  return jsonResponse(res, { error: 'Unknown AgentScope capability.' }, 404);
}
