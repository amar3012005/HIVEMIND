// A private, chronological HIVEMIND project lane for Hyper Agents. It is never
// queried through /api/recall or promoted into the company memory graph.
export const OPERATING_MEMORY_PROJECT = 'hyper-agents';
import {
  TEAM_KINDS, KEYED_KINDS, CONFIRMABLE_KINDS, PROMOTION_THRESHOLD, MAX_CONFIRMATIONS, TEAM_CONTEXT_MAX_CHARS,
  BRIEF_DEFAULT_LIMIT, normalizeTeamFields, assertNoForeignTeamFields, deriveIdempotencyKey,
  publicConfirmations, publicTeamContext, tokenize, buildBrief,
} from './team-memory.js';

export const OPERATING_MEMORY_KINDS = Object.freeze(['learning', 'decision_note', 'handoff', 'task_status', 'trigger_status', 'user_agenda', 'uncertainty', ...TEAM_KINDS]);
const AGENT_KINDS = Object.freeze(['learning', 'decision_note', 'handoff', ...TEAM_KINDS]);
export const RUNTIME_MEMORY_KINDS = Object.freeze(['user_agenda', 'uncertainty']);
const STATUSES = new Set(['recorded', 'active', 'completed', 'incomplete', 'errored', 'paused']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_ID = /^(?:trigger-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{0,119}$/;

export function validateOperatingMemory(input, { orgId, userId, source = 'agent' } = {}) {
  if (!UUID.test(String(orgId || '')) || !UUID.test(String(userId || ''))) throw new Error('invalid_identity');
  const kind = String(input?.kind || '');
  const isTeam = TEAM_KINDS.includes(kind);
  // For `agenda`, the request's `status` is the agenda status (in context); the row stays `recorded`.
  const status = isTeam ? 'recorded' : String(input?.status || 'recorded');
  const agentSlug = String(input?.agent_slug || '').trim();
  if (!OPERATING_MEMORY_KINDS.includes(kind) || !STATUSES.has(status)) throw new Error('invalid_memory_type_or_status');
  let team = null;
  if (isTeam) team = normalizeTeamFields(kind, input);
  else assertNoForeignTeamFields(kind, input);
  const title = String(input?.title || team?.title || '').trim();
  const summary = String(input?.summary || team?.summary || '').trim();
  const suppliedKey = String(input?.idempotency_key || '').trim();
  const idempotencyKey = suppliedKey || (team ? deriveIdempotencyKey(kind, agentSlug, team.fields) : '');
  if (source === 'agent' && !AGENT_KINDS.includes(kind)) throw new Error('runtime_receipt_required');
  if (source === 'agent' && status !== 'recorded') throw new Error('runtime_status_required');
  if (RUNTIME_MEMORY_KINDS.includes(kind) && (source !== 'runtime' || agentSlug !== 'runtime')) throw new Error('runtime_memory_required');
  if (!SLUG.test(agentSlug)) throw new Error('invalid_agent_slug');
  if (!title || title.length > 180 || !summary || summary.length > 2400) throw new Error('invalid_memory_content');
  if (!idempotencyKey || idempotencyKey.length > 200) throw new Error('invalid_idempotency_key');
  const ids = {};
  for (const key of ['room_id', 'run_id', 'trigger_id']) {
    const value = input?.[key];
    if (value != null && value !== '') {
      if (!(key === 'run_id' ? RUN_ID : UUID).test(String(value))) throw new Error(`invalid_${key}`);
      ids[key] = String(value);
    }
  }
  if ((kind === 'task_status' && !ids.run_id) || (kind === 'trigger_status' && !ids.trigger_id)) throw new Error('receipt_reference_required');
  const context = team ? { ...team.fields }
    : input?.context && typeof input.context === 'object' && !Array.isArray(input.context) ? { ...input.context } : {};
  const supersedesId = input?.supersedes_id == null ? null : String(input.supersedes_id);
  if (Object.hasOwn(context, 'supersedesId')) throw new Error('reserved_memory_context_key');
  if (supersedesId && !UUID.test(supersedesId)) throw new Error('invalid_supersedes_id');
  // progress and agenda replace their predecessor by key; the server links it.
  if (supersedesId && !['learning', 'decision_note', 'handoff', 'lesson', 'procedure', ...RUNTIME_MEMORY_KINDS].includes(kind)) throw new Error('invalid_supersession_kind');
  if (RUNTIME_MEMORY_KINDS.includes(kind)) {
    const permitted = new Set(['sessionId', 'state', 'priority', 'evidence', 'impact', 'confirmationRef', 'agendaKey']);
    if (Object.keys(context).some(key => !permitted.has(key))) throw new Error('invalid_runtime_memory_metadata');
    if (!/^session-[a-z0-9-]{1,120}$/.test(context.sessionId || '')) throw new Error('invalid_runtime_memory_session');
    const states = kind === 'user_agenda' ? ['confirmed', 'superseded'] : ['open', 'resolved', 'superseded'];
    if (kind === 'uncertainty' && supersedesId && !states.includes(context.state)) {
      const error = new Error('invalid_uncertainty_update_state');
      error.hint = 'Set context.state explicitly to resolved, open, or superseded when updating an uncertainty. Use resolved only when the question has been answered; no memory was saved.';
      throw error;
    }
    if (!states.includes(context.state)) throw new Error('invalid_runtime_memory_state');
    if (!Number.isInteger(context.priority) || context.priority < 0 || context.priority > 100) throw new Error('invalid_runtime_memory_priority');
    if (context.impact !== undefined && (typeof context.impact !== 'string' || context.impact.length > 500)) throw new Error('invalid_runtime_memory_impact');
    if (context.evidence !== undefined && (!Array.isArray(context.evidence) || context.evidence.length > 8 || context.evidence.some(ref => typeof ref !== 'string' || !ref.trim() || ref.length > 300))) throw new Error('invalid_runtime_memory_evidence');
    if (context.agendaKey !== undefined && (kind !== 'user_agenda' || typeof context.agendaKey !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(context.agendaKey))) throw new Error('invalid_agenda_key');
    if (kind === 'user_agenda' && !/^(?:event:[0-9]+|call:[a-zA-Z0-9_-]{1,120})$/.test(context.confirmationRef || '')) throw new Error('invalid_agenda_confirmation');
    if (kind === 'uncertainty' && context.confirmationRef !== undefined) throw new Error('invalid_runtime_memory_metadata');
    if (context.state !== (kind === 'user_agenda' ? 'confirmed' : 'open') && !supersedesId) throw new Error('invalid_runtime_memory_resolution');
  }
  if (supersedesId) context.supersedesId = supersedesId;
  if (JSON.stringify(context).length > (team ? TEAM_CONTEXT_MAX_CHARS : 4000)) throw new Error('memory_context_too_large');
  return { orgId, userId, kind, status, agentSlug, title, summary, idempotencyKey, context, teamKey: team?.key, keyDerived: Boolean(team && !suppliedKey), ...ids };
}

export function validateOperatingMemoryFilter(input) {
  const state = input?.state == null ? null : String(input.state);
  if (state && !['open', 'resolved', 'superseded', 'confirmed'].includes(state)) throw new Error('invalid_runtime_memory_state');
  const kind = input?.kind == null ? null : String(input.kind);
  const agentSlug = input?.agent_slug == null ? null : String(input.agent_slug);
  const status = input?.status == null ? null : String(input.status);
  const roomId = input?.room_id == null ? null : String(input.room_id);
  const runId = input?.run_id == null ? null : String(input.run_id);
  const query = input?.query == null ? null : String(input.query).trim();
  const mode = input?.mode == null ? null : String(input.mode);
  if (mode && !['brief', 'full'].includes(mode)) throw new Error('invalid_recall_mode');
  const context = input?.context == null ? null : input.context;
  if (context != null && (typeof context !== 'string' || context.length > 2000)) throw new Error('invalid_recall_context');
  const hints = input?.hints == null ? [] : input.hints;
  if (!Array.isArray(hints) || hints.length > 8 || hints.some(hint => typeof hint !== 'string' || !hint.trim() || hint.length > 80)) throw new Error('invalid_recall_hints');
  if (input?.promoted != null && typeof input.promoted !== 'boolean') throw new Error('invalid_promoted');
  const id = input?.id == null ? null : String(input.id);
  if (id && !UUID.test(id)) throw new Error('invalid_memory_id');
  if (kind && !OPERATING_MEMORY_KINDS.includes(kind)) throw new Error('invalid_memory_type');
  if (agentSlug && !SLUG.test(agentSlug)) throw new Error('invalid_agent_slug');
  if (status && !STATUSES.has(status)) throw new Error('invalid_memory_status');
  if (roomId && !UUID.test(roomId)) throw new Error('invalid_room_id');
  if (runId && !RUN_ID.test(runId)) throw new Error('invalid_run_id');
  if (query && query.length > 500) throw new Error('invalid_query');
  // A bare recall (no targeting filter) is the compact brief; any legacy filter keeps the full listing.
  const targeted = [kind, status, roomId, runId, query, state, id, agentSlug].some(Boolean);
  const brief = mode === 'brief' || (mode == null && !targeted);
  if (brief && [kind, status, roomId, runId, state, id].some(Boolean)) throw new Error('invalid_brief_filter');
  const limit = Number(input?.limit ?? (brief ? BRIEF_DEFAULT_LIMIT : 10));
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('invalid_limit');
  const promoted = input?.promoted === true;
  return { kind, agentSlug, status, roomId, runId, query, limit, state, brief, context, hints: hints.map(hint => hint.trim()), promoted, id };
}

function publicRecord(row) {
  const team = TEAM_KINDS.includes(row.kind);
  return {
    id: row.id, project: OPERATING_MEMORY_PROJECT, kind: row.kind, status: row.status,
    agentSlug: row.agent_slug, title: row.title, summary: row.summary,
    roomId: row.room_id, runId: row.run_id, triggerId: row.trigger_id,
    context: team ? publicTeamContext(row.context) : row.context, supersedesId: row.context?.supersedesId || null, createdAt: row.created_at,
    ...(team ? { updatedAt: row.created_at } : {}),
    ...(CONFIRMABLE_KINDS.includes(row.kind) ? { promoted: row.context?.promoted === true, confirmedBy: publicConfirmations(row.context) } : {}),
  };
}

export async function saveOperatingMemory(prisma, input, identity, options = {}) {
  // Serialize successors to prevent delayed calls from branching an already
  // resolved question or superseded user direction. Replay keeps its receipt.
  // A supersession is compare-and-set against the replaced head: serialize it
  // so two agents cannot both replace the same memory and fork its history.
  if ((RUNTIME_MEMORY_KINDS.includes(input?.kind) || KEYED_KINDS.includes(input?.kind) || input?.supersedes_id != null) && !options.runtimeTransaction) {
    return prisma.$transaction(tx => saveOperatingMemory(tx, input, identity, { ...options, runtimeTransaction: true }));
  }
  const row = validateOperatingMemory(input, { ...identity, source: options.source || 'agent' });
  if (options.runtimeSessionId && RUNTIME_MEMORY_KINDS.includes(row.kind) && row.context.sessionId !== options.runtimeSessionId) throw new Error('runtime_memory_scope_required');
  if (row.kind === 'user_agenda' && row.context.agendaKey) {
    const headScope=options.runtimeSessionId || row.userId;
    await prisma.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', `${row.orgId}:${headScope}:agenda:${row.context.agendaKey}`);
    const current = await prisma.$queryRawUnsafe(`SELECT m.id,m.idempotency_key FROM hivemind.hyper_agent_operating_memories m
      WHERE m.org_id=$1::uuid AND ($2::uuid IS NULL OR m.author_user_id=$2::uuid)
        AND ($4::text IS NULL OR m.context->>'sessionId'=$4)
        AND m.agent_slug='runtime' AND m.kind='user_agenda' AND m.project_slug='hyper-agents'
        AND m.context->>'agendaKey'=$3 AND m.context->>'state'='confirmed'
        AND NOT EXISTS (SELECT 1 FROM hivemind.hyper_agent_operating_memories successor
          WHERE successor.org_id=m.org_id AND successor.kind=m.kind AND successor.context->>'supersedesId'=m.id::text)`,
      row.orgId, options.runtimeSessionId ? null : row.userId, row.context.agendaKey, options.runtimeSessionId || null);
    if (current.some(prior => prior.idempotency_key !== row.idempotencyKey && prior.id !== row.context.supersedesId)) throw new Error('agenda_supersession_required');
  }

  if (KEYED_KINDS.includes(row.kind)) {
    // Upsert by key: serialize writers, replay an identical retry, and link the
    // current head so the newest revision replaces it (history is kept).
    const keyField = row.kind === 'progress' ? 'task_key' : 'agenda_key';
    await prisma.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', `${row.orgId}:${row.kind}:${row.teamKey}`);
    const head = await prisma.$queryRawUnsafe(`
      SELECT m.id FROM hivemind.hyper_agent_operating_memories m
      WHERE m.org_id = $1::uuid AND m.project_slug = 'hyper-agents' AND m.kind = $2 AND m.context->>'${keyField}' = $3
        AND NOT EXISTS (SELECT 1 FROM hivemind.hyper_agent_operating_memories successor
          WHERE successor.org_id = m.org_id AND successor.context->>'supersedesId' = m.id::text)
      ORDER BY m.created_at DESC, m.id DESC LIMIT 1 FOR UPDATE`, row.orgId, row.kind, row.teamKey);
    const replay = (await prisma.$queryRawUnsafe(`
      SELECT * FROM hivemind.hyper_agent_operating_memories WHERE org_id = $1::uuid AND idempotency_key = $2 LIMIT 1`, row.orgId, row.idempotencyKey))[0];
    if (replay) {
      if (replay.kind !== row.kind || replay.agent_slug !== row.agentSlug || replay.summary !== row.summary) throw new Error('memory_idempotency_conflict');
      // A content-derived key that matches an older revision is a new revision (A, B, A again), not a retry.
      if (!row.keyDerived || replay.id === head[0]?.id) return { ok: true, replayed: true, memory: publicRecord(replay) };
      row.idempotencyKey = `${row.idempotencyKey}:r${Date.now().toString(36)}`;
    }
    if (head.length) row.context.supersedesId = head[0].id;
  }
  if (row.context.supersedesId) {
    const prior = await prisma.$queryRawUnsafe(`
      SELECT id FROM hivemind.hyper_agent_operating_memories
      WHERE id = $1::uuid AND org_id = $2::uuid AND project_slug = 'hyper-agents'
        AND kind = $3 AND ($4::text IS NULL OR agent_slug = $4)
        AND ($5::uuid IS NULL OR author_user_id = $5::uuid)
        AND ($6::text IS NULL OR context->>'sessionId'=$6) LIMIT 1 FOR UPDATE`,
    row.context.supersedesId, row.orgId, row.kind, TEAM_KINDS.includes(row.kind) ? null : row.agentSlug, RUNTIME_MEMORY_KINDS.includes(row.kind) && !options.runtimeSessionId ? row.userId : null, options.runtimeSessionId || null);
    if (!prior.length) throw new Error('superseded_memory_unavailable');
    const successors = await prisma.$queryRawUnsafe(`SELECT id FROM hivemind.hyper_agent_operating_memories
      WHERE org_id=$1::uuid AND context->>'supersedesId'=$2 AND idempotency_key<>$3 LIMIT 1`,
      row.orgId, row.context.supersedesId, row.idempotencyKey);
    if (successors.length) {
      const conflict = new Error('superseded_memory_already_replaced');
      conflict.status = 409;
      conflict.currentId = successors[0].id;
      throw conflict;
    }
  }
  const project = await prisma.project.upsert({
    where: { orgId_slug: { orgId: row.orgId, slug: OPERATING_MEMORY_PROJECT } },
    update: {},
    create: {
      orgId: row.orgId, name: 'Hyper Agents', slug: OPERATING_MEMORY_PROJECT,
      description: 'Private system-owned operating memory for Hyper Agents.',
      policy: 'private', selfEvolveEnabled: false, createdBy: row.userId,
    },
    select: { id: true, name: true, policy: true },
  });
  if (project.name !== 'Hyper Agents' || project.policy !== 'private') throw new Error('reserved_project_conflict');
  await prisma.projectMember.upsert({
    where: { projectId_userId: { projectId: project.id, userId: row.userId } },
    update: {}, create: { projectId: project.id, userId: row.userId, role: 'owner' },
  });
  const created = await prisma.$queryRawUnsafe(`
    INSERT INTO hivemind.hyper_agent_operating_memories
      (org_id, project_id, idempotency_key, kind, status, agent_slug, author_user_id, room_id, run_id, trigger_id, title, summary, context)
    VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, $8::uuid, $9, $10::uuid, $11, $12, $13::jsonb)
    ON CONFLICT (org_id, idempotency_key) DO NOTHING
    RETURNING *`, row.orgId, project.id, row.idempotencyKey, row.kind, row.status, row.agentSlug, row.userId,
    row.room_id || null, row.run_id || null, row.trigger_id || null, row.title, row.summary, JSON.stringify(row.context));
  const persisted = created[0] || (await prisma.$queryRawUnsafe(`
    SELECT * FROM hivemind.hyper_agent_operating_memories WHERE org_id = $1::uuid AND idempotency_key = $2 LIMIT 1`, row.orgId, row.idempotencyKey))[0];
  if (!persisted) throw new Error('memory_receipt_unavailable');
  if (!created.length && (persisted.kind !== row.kind || persisted.status !== row.status
    || persisted.agent_slug !== row.agentSlug || persisted.summary !== row.summary
    || String(persisted.run_id || '') !== String(row.run_id || '')
    || String(persisted.context?.supersedesId || '') !== String(row.context.supersedesId || '')
    || (RUNTIME_MEMORY_KINDS.includes(row.kind) && (persisted.author_user_id !== row.userId || persisted.title !== row.title || JSON.stringify(Object.entries(persisted.context || {}).sort()) !== JSON.stringify(Object.entries(row.context).sort()))))) throw new Error('memory_idempotency_conflict');
  return { ok: true, replayed: !created.length, memory: publicRecord(persisted) };
}

const PROMOTED_CLAUSE = `(m.kind IN ('lesson', 'procedure') AND m.context->>'promoted' = 'true')`;
const RECALL_COLUMNS = 'm.id, m.kind, m.status, m.agent_slug, m.title, m.summary, m.room_id, m.run_id, m.trigger_id, m.context, m.created_at';
const SUPERSEDED_EXISTS = `EXISTS (
    SELECT 1 FROM hivemind.hyper_agent_operating_memories successor
    WHERE successor.org_id = m.org_id AND successor.project_slug = 'hyper-agents'
      AND successor.context->>'supersedesId' = m.id::text)`;
const NOT_SUPERSEDED = `NOT ${SUPERSEDED_EXISTS}`;

// Compact ranked brief across every shared kind. Runtime-private kinds are never included.
async function briefOperatingMemory(prisma, orgId, filter) {
  const clauses = ['m.org_id = $1::uuid', "m.project_slug = 'hyper-agents'", NOT_SUPERSEDED, "m.kind NOT IN ('user_agenda', 'uncertainty')"];
  if (filter.promoted) clauses.push(PROMOTED_CLAUSE);
  const where = clauses.join(' AND ');
  const contextText = [filter.context, filter.query].filter(Boolean).join(' ');
  const recent = await prisma.$queryRawUnsafe(`
    SELECT ${RECALL_COLUMNS} FROM hivemind.hyper_agent_operating_memories m
    WHERE ${where} ORDER BY m.created_at DESC, m.id DESC LIMIT 200`, orgId);
  const terms = [...new Set([...tokenize(contextText), ...filter.hints.flatMap(tokenize)])].slice(0, 16);
  let related = [];
  if (terms.length) {
    related = await prisma.$queryRawUnsafe(`
      SELECT ${RECALL_COLUMNS} FROM hivemind.hyper_agent_operating_memories m
      WHERE ${where} AND to_tsvector('simple', m.title || ' ' || m.summary) @@ to_tsquery('simple', $2)
      ORDER BY ts_rank(to_tsvector('simple', m.title || ' ' || m.summary), to_tsquery('simple', $2)) DESC, m.created_at DESC LIMIT 100`,
    orgId, terms.join(' | '));
  }
  const rows = [...new Map([...recent, ...related].map(row => [row.id, row])).values()];
  const { items, truncated } = buildBrief(rows, { context: contextText, hints: filter.hints, agentSlug: filter.agentSlug, limit: filter.limit });
  return { ok: true, project: OPERATING_MEMORY_PROJECT, mode: 'brief', count: items.length, truncated, items };
}

/**
 * Record an employee's confirmation of a lesson or procedure. Two confirmations
 * promote it. Authorship is bound to the authenticated principal; the employee
 * slug is recorded as supplied, like on save.
 * @param {object} prisma Prisma client or transaction.
 * @param {{ id: string, agent_slug: string, idempotency_key?: string }} input
 * @param {{ orgId: string, userId: string }} identity Server-bound identity.
 * @returns {Promise<{ ok: true, replayed: boolean, promoted: boolean, confirmations: number, memory: object }>}
 */
export async function confirmOperatingMemory(prisma, input, identity, options = {}) {
  if (!options.transaction) return prisma.$transaction(tx => confirmOperatingMemory(tx, input, identity, { ...options, transaction: true }));
  const { orgId, userId } = identity;
  if (!UUID.test(String(orgId || '')) || !UUID.test(String(userId || ''))) throw new Error('invalid_identity');
  const id = String(input?.id || '');
  const agentSlug = String(input?.agent_slug || '').trim();
  const key = input?.idempotency_key == null ? null : String(input.idempotency_key).trim();
  if (!UUID.test(id)) throw new Error('invalid_memory_id');
  if (!SLUG.test(agentSlug)) throw new Error('invalid_agent_slug');
  if (key !== null && (!key || key.length > 200)) throw new Error('invalid_idempotency_key');
  const rows = await prisma.$queryRawUnsafe(`
    SELECT m.*, ${SUPERSEDED_EXISTS} AS superseded
    FROM hivemind.hyper_agent_operating_memories m
    WHERE m.id = $1::uuid AND m.org_id = $2::uuid AND m.project_slug = 'hyper-agents' LIMIT 1 FOR UPDATE OF m`, id, orgId);
  const row = rows[0];
  if (!row || RUNTIME_MEMORY_KINDS.includes(row.kind)) { const error = new Error('memory_not_found'); error.status = 404; throw error; }
  if (!CONFIRMABLE_KINDS.includes(row.kind)) throw new Error('invalid_confirm_kind');
  if (row.superseded) throw new Error('superseded_memory_unavailable');
  const context = { ...(row.context || {}) };
  const confirmations = Array.isArray(context.confirmations) ? [...context.confirmations] : [];
  const replayed = key !== null && confirmations.some(entry => entry.key === key);
  if (!replayed) {
    confirmations.push({ agent_slug: agentSlug, user_id: userId, at: new Date().toISOString(), ...(key !== null ? { key } : {}) });
    context.confirmations = confirmations.slice(-MAX_CONFIRMATIONS);
    if (context.promoted !== true && confirmations.length >= PROMOTION_THRESHOLD) {
      context.promoted = true;
      context.promoted_at = new Date().toISOString();
    }
    const updated = await prisma.$queryRawUnsafe(`
      UPDATE hivemind.hyper_agent_operating_memories SET context = $1::jsonb
      WHERE id = $2::uuid AND org_id = $3::uuid RETURNING *`, JSON.stringify(context), id, orgId);
    row.context = updated[0]?.context ?? context;
  }
  return { ok: true, replayed, promoted: row.context.promoted === true, confirmations: (row.context.confirmations || []).length, memory: publicRecord(row) };
}

export async function recallOperatingMemory(prisma, orgId, input = {}, options = {}) {
  if (!UUID.test(String(orgId || ''))) throw new Error('invalid_identity');
  const filter = validateOperatingMemoryFilter(input);
  if (filter.brief) return briefOperatingMemory(prisma, orgId, filter);
  if ((RUNTIME_MEMORY_KINDS.includes(filter.kind) || filter.state) && !options.runtimeUserId) throw new Error('runtime_memory_required');
  const clauses = ['m.org_id = $1::uuid', "m.project_slug = 'hyper-agents'", `NOT EXISTS (
    SELECT 1 FROM hivemind.hyper_agent_operating_memories successor
    WHERE successor.org_id = m.org_id AND successor.project_slug = 'hyper-agents'
      AND successor.context->>'supersedesId' = m.id::text)`];
  const args = [orgId];
  if (!options.runtimeUserId) clauses.push("m.kind NOT IN ('user_agenda', 'uncertainty')");
  else {
    if (!UUID.test(options.runtimeUserId)) throw new Error('invalid_identity');
    if (options.runtimeSessionId) {
      if (!/^session-[a-z0-9-]{1,120}$/.test(options.runtimeSessionId)) throw new Error('invalid_runtime_memory_session');
      args.push(options.runtimeSessionId);
      clauses.push(`(m.kind NOT IN ('user_agenda', 'uncertainty') OR m.context->>'sessionId'=$${args.length})`);
    } else {
      args.push(options.runtimeUserId);
      clauses.push(`(m.kind NOT IN ('user_agenda', 'uncertainty') OR m.author_user_id = $${args.length}::uuid)`);
    }
  }
  if (filter.state) { args.push(filter.state); clauses.push(`m.context->>'state' = $${args.length}`); }
  if (filter.id) { args.push(filter.id); clauses.push(`m.id = $${args.length}::uuid`); }
  if (filter.promoted) clauses.push(PROMOTED_CLAUSE);
  for (const [column, value, cast] of [
    ['kind', filter.kind, ''], ['agent_slug', filter.agentSlug, ''], ['status', filter.status, ''],
    ['room_id', filter.roomId, '::uuid'], ['run_id', filter.runId, ''],
  ]) {
    if (value) { args.push(value); clauses.push(`m.${column} = $${args.length}${cast}`); }
  }
  let ranking = '';
  if (filter.query) {
    const stop = new Set(['with', 'from', 'that', 'this', 'what', 'when', 'where', 'about', 'have', 'their', 'them', 'your', 'into', 'will', 'task', 'work']);
    const terms = [...new Set(filter.query.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])]
      .filter((term) => !stop.has(term)).slice(0, 12);
    if (terms.length) {
      args.push(terms.join(' | '));
      const vector = `to_tsvector('simple', m.title || ' ' || m.summary)`;
      const tsquery = `to_tsquery('simple', $${args.length})`;
      clauses.push(`${vector} @@ ${tsquery}`);
      ranking = `ts_rank(${vector}, ${tsquery}) DESC, `;
    }
  }
  args.push(filter.limit);
  const rows = await prisma.$queryRawUnsafe(`
    SELECT ${RECALL_COLUMNS}
    FROM hivemind.hyper_agent_operating_memories m
    WHERE ${clauses.join(' AND ')}
    ORDER BY ${filter.kind === 'uncertainty' ? "(m.context->>'priority')::integer DESC, " : ''}${ranking}m.created_at DESC, m.id DESC LIMIT $${args.length}`, ...args);
  return { ok: true, project: OPERATING_MEMORY_PROJECT, count: rows.length, memories: rows.map(publicRecord) };
}

export async function recordTriggerDefinition(prisma, trigger) {
  const employee = await prisma.digitalEmployee.findFirst({
    where: { id: trigger.employee_id, orgId: trigger.org_id }, select: { slug: true },
  });
  if (!employee?.slug) throw new Error('trigger_employee_unavailable');
  return saveOperatingMemory(prisma, {
    kind: 'trigger_status', status: trigger.status === 'active' ? 'active' : trigger.status === 'paused' ? 'paused' : 'recorded',
    agent_slug: employee.slug, title: Number(trigger.version || 1) > 1 ? 'Durable trigger updated' : 'Durable trigger created',
    summary: `Scheduled ${trigger.kind} task: ${String(trigger.task || '').slice(0, 700)}`,
    idempotency_key: `trigger-definition:${trigger.id}:v${trigger.version || 1}`,
    trigger_id: trigger.id, room_id: trigger.room_id,
    context: { kind: trigger.kind, nextRunAt: trigger.next_run_at, timezone: trigger.timezone, outputFormat: trigger.task_packet?.output_format },
  }, { orgId: trigger.org_id, userId: trigger.user_id }, { source: 'runtime' });
}
