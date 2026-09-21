import { internalFetch } from '../internal/internal-fetch.js';

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
  return jsonResponse(res, { error: 'Unknown AgentScope capability.' }, 404);
}
