// A private, chronological HIVEMIND project lane for Hyper Agents. It is never
// queried through /api/recall or promoted into the company memory graph.
export const OPERATING_MEMORY_PROJECT = 'hyper-agents';
export const OPERATING_MEMORY_KINDS = Object.freeze(['learning', 'decision_note', 'handoff', 'task_status', 'trigger_status', 'user_agenda', 'uncertainty']);
export const RUNTIME_MEMORY_KINDS = Object.freeze(['user_agenda', 'uncertainty']);
const STATUSES = new Set(['recorded', 'active', 'completed', 'incomplete', 'errored', 'paused']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_ID = /^(?:trigger-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{0,119}$/;

export function validateOperatingMemory(input, { orgId, userId, source = 'agent' } = {}) {
  if (!UUID.test(String(orgId || '')) || !UUID.test(String(userId || ''))) throw new Error('invalid_identity');
  const kind = String(input?.kind || '');
  const status = String(input?.status || 'recorded');
  const agentSlug = String(input?.agent_slug || '').trim();
  const title = String(input?.title || '').trim();
  const summary = String(input?.summary || '').trim();
  const idempotencyKey = String(input?.idempotency_key || '').trim();
  if (!OPERATING_MEMORY_KINDS.includes(kind) || !STATUSES.has(status)) throw new Error('invalid_memory_type_or_status');
  if (source === 'agent' && !['learning', 'decision_note', 'handoff'].includes(kind)) throw new Error('runtime_receipt_required');
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
  const context = input?.context && typeof input.context === 'object' && !Array.isArray(input.context) ? { ...input.context } : {};
  const supersedesId = input?.supersedes_id == null ? null : String(input.supersedes_id);
  if (Object.hasOwn(context, 'supersedesId')) throw new Error('reserved_memory_context_key');
  if (supersedesId && !UUID.test(supersedesId)) throw new Error('invalid_supersedes_id');
  if (supersedesId && !['learning', 'decision_note', 'handoff', ...RUNTIME_MEMORY_KINDS].includes(kind)) throw new Error('invalid_supersession_kind');
  if (RUNTIME_MEMORY_KINDS.includes(kind)) {
    const permitted = new Set(['sessionId', 'state', 'priority', 'evidence', 'impact', 'confirmationRef']);
    if (Object.keys(context).some(key => !permitted.has(key))) throw new Error('invalid_runtime_memory_metadata');
    if (!/^session-[a-z0-9-]{1,120}$/.test(context.sessionId || '')) throw new Error('invalid_runtime_memory_session');
    const states = kind === 'user_agenda' ? ['confirmed', 'superseded'] : ['open', 'resolved', 'superseded'];
    if (!states.includes(context.state)) throw new Error('invalid_runtime_memory_state');
    if (!Number.isInteger(context.priority) || context.priority < 0 || context.priority > 100) throw new Error('invalid_runtime_memory_priority');
    if (context.impact !== undefined && (typeof context.impact !== 'string' || context.impact.length > 500)) throw new Error('invalid_runtime_memory_impact');
    if (context.evidence !== undefined && (!Array.isArray(context.evidence) || context.evidence.length > 8 || context.evidence.some(ref => typeof ref !== 'string' || !ref.trim() || ref.length > 300))) throw new Error('invalid_runtime_memory_evidence');
    if (kind === 'user_agenda' && !/^(?:event:[0-9]+|call:[a-zA-Z0-9_-]{1,120})$/.test(context.confirmationRef || '')) throw new Error('invalid_agenda_confirmation');
    if (kind === 'uncertainty' && context.confirmationRef !== undefined) throw new Error('invalid_runtime_memory_metadata');
    if (context.state !== (kind === 'user_agenda' ? 'confirmed' : 'open') && !supersedesId) throw new Error('invalid_runtime_memory_resolution');
  }
  if (supersedesId) context.supersedesId = supersedesId;
  if (JSON.stringify(context).length > 4000) throw new Error('memory_context_too_large');
  return { orgId, userId, kind, status, agentSlug, title, summary, idempotencyKey, context, ...ids };
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
  if (kind && !OPERATING_MEMORY_KINDS.includes(kind)) throw new Error('invalid_memory_type');
  if (agentSlug && !SLUG.test(agentSlug)) throw new Error('invalid_agent_slug');
  if (status && !STATUSES.has(status)) throw new Error('invalid_memory_status');
  if (roomId && !UUID.test(roomId)) throw new Error('invalid_room_id');
  if (runId && !RUN_ID.test(runId)) throw new Error('invalid_run_id');
  if (query && query.length > 500) throw new Error('invalid_query');
  const limit = Number(input?.limit ?? 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('invalid_limit');
  return { kind, agentSlug, status, roomId, runId, query, limit, state };
}

function publicRecord(row) {
  return {
    id: row.id, project: OPERATING_MEMORY_PROJECT, kind: row.kind, status: row.status,
    agentSlug: row.agent_slug, title: row.title, summary: row.summary,
    roomId: row.room_id, runId: row.run_id, triggerId: row.trigger_id,
    context: row.context, supersedesId: row.context?.supersedesId || null, createdAt: row.created_at,
  };
}

export async function saveOperatingMemory(prisma, input, identity, options = {}) {
  // Serialize successors to prevent delayed calls from branching an already
  // resolved question or superseded user direction. Replay keeps its receipt.
  if (RUNTIME_MEMORY_KINDS.includes(input?.kind) && !options.runtimeTransaction) {
    return prisma.$transaction(tx => saveOperatingMemory(tx, input, identity, { ...options, runtimeTransaction: true }));
  }
  const row = validateOperatingMemory(input, { ...identity, source: options.source || 'agent' });
  if (row.context.supersedesId) {
    const prior = await prisma.$queryRawUnsafe(`
      SELECT id FROM hivemind.hyper_agent_operating_memories
      WHERE id = $1::uuid AND org_id = $2::uuid AND project_slug = 'hyper-agents'
        AND kind = $3 AND agent_slug = $4
        AND ($5::uuid IS NULL OR author_user_id = $5::uuid) LIMIT 1 ${RUNTIME_MEMORY_KINDS.includes(row.kind) ? 'FOR UPDATE' : ''}`,
    row.context.supersedesId, row.orgId, row.kind, row.agentSlug, RUNTIME_MEMORY_KINDS.includes(row.kind) ? row.userId : null);
    if (!prior.length) throw new Error('superseded_memory_unavailable');
    if (RUNTIME_MEMORY_KINDS.includes(row.kind)) {
      const successors = await prisma.$queryRawUnsafe(`SELECT id FROM hivemind.hyper_agent_operating_memories
        WHERE org_id=$1::uuid AND context->>'supersedesId'=$2 AND idempotency_key<>$3 LIMIT 1`,
        row.orgId, row.context.supersedesId, row.idempotencyKey);
      if (successors.length) throw new Error('superseded_memory_already_replaced');
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

export async function recallOperatingMemory(prisma, orgId, input = {}, options = {}) {
  if (!UUID.test(String(orgId || ''))) throw new Error('invalid_identity');
  const filter = validateOperatingMemoryFilter(input);
  if ((RUNTIME_MEMORY_KINDS.includes(filter.kind) || filter.state) && !options.runtimeUserId) throw new Error('runtime_memory_required');
  const clauses = ['m.org_id = $1::uuid', "m.project_slug = 'hyper-agents'", `NOT EXISTS (
    SELECT 1 FROM hivemind.hyper_agent_operating_memories successor
    WHERE successor.org_id = m.org_id AND successor.project_slug = 'hyper-agents'
      AND successor.context->>'supersedesId' = m.id::text)`];
  const args = [orgId];
  if (!options.runtimeUserId) clauses.push("m.kind NOT IN ('user_agenda', 'uncertainty')");
  else {
    if (!UUID.test(options.runtimeUserId)) throw new Error('invalid_identity');
    args.push(options.runtimeUserId);
    clauses.push(`(m.kind NOT IN ('user_agenda', 'uncertainty') OR m.author_user_id = $${args.length}::uuid)`);
  }
  if (filter.state) { args.push(filter.state); clauses.push(`m.context->>'state' = $${args.length}`); }
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
    SELECT m.id, m.kind, m.status, m.agent_slug, m.title, m.summary, m.room_id, m.run_id, m.trigger_id, m.context, m.created_at
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
