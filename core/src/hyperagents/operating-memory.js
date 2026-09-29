// A private, chronological HIVEMIND project lane for Hyper Agents. It is never
// queried through /api/recall or promoted into the company memory graph.
export const OPERATING_MEMORY_PROJECT = 'hyper-agents';
export const OPERATING_MEMORY_KINDS = Object.freeze(['learning', 'decision_note', 'handoff', 'task_status', 'trigger_status']);
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
  const context = input?.context && typeof input.context === 'object' && !Array.isArray(input.context) ? input.context : {};
  if (JSON.stringify(context).length > 4000) throw new Error('memory_context_too_large');
  return { orgId, userId, kind, status, agentSlug, title, summary, idempotencyKey, context, ...ids };
}

export function validateOperatingMemoryFilter(input) {
  const kind = input?.kind == null ? null : String(input.kind);
  const agentSlug = input?.agent_slug == null ? null : String(input.agent_slug);
  const status = input?.status == null ? null : String(input.status);
  const roomId = input?.room_id == null ? null : String(input.room_id);
  const runId = input?.run_id == null ? null : String(input.run_id);
  if (kind && !OPERATING_MEMORY_KINDS.includes(kind)) throw new Error('invalid_memory_type');
  if (agentSlug && !SLUG.test(agentSlug)) throw new Error('invalid_agent_slug');
  if (status && !STATUSES.has(status)) throw new Error('invalid_memory_status');
  if (roomId && !UUID.test(roomId)) throw new Error('invalid_room_id');
  if (runId && !RUN_ID.test(runId)) throw new Error('invalid_run_id');
  const limit = Number(input?.limit ?? 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('invalid_limit');
  return { kind, agentSlug, status, roomId, runId, limit };
}

function publicRecord(row) {
  return {
    id: row.id, project: OPERATING_MEMORY_PROJECT, kind: row.kind, status: row.status,
    agentSlug: row.agent_slug, title: row.title, summary: row.summary,
    roomId: row.room_id, runId: row.run_id, triggerId: row.trigger_id,
    context: row.context, createdAt: row.created_at,
  };
}

export async function saveOperatingMemory(prisma, input, identity, options = {}) {
  const row = validateOperatingMemory(input, { ...identity, source: options.source || 'agent' });
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
    || String(persisted.run_id || '') !== String(row.run_id || ''))) throw new Error('memory_idempotency_conflict');
  return { ok: true, replayed: !created.length, memory: publicRecord(persisted) };
}

export async function recallOperatingMemory(prisma, orgId, input = {}) {
  if (!UUID.test(String(orgId || ''))) throw new Error('invalid_identity');
  const filter = validateOperatingMemoryFilter(input);
  const clauses = ['org_id = $1::uuid', "project_slug = 'hyper-agents'"];
  const args = [orgId];
  for (const [column, value, cast] of [
    ['kind', filter.kind, ''], ['agent_slug', filter.agentSlug, ''], ['status', filter.status, ''],
    ['room_id', filter.roomId, '::uuid'], ['run_id', filter.runId, ''],
  ]) {
    if (value) { args.push(value); clauses.push(`${column} = $${args.length}${cast}`); }
  }
  args.push(filter.limit);
  const rows = await prisma.$queryRawUnsafe(`
    SELECT id, kind, status, agent_slug, title, summary, room_id, run_id, trigger_id, context, created_at
    FROM hivemind.hyper_agent_operating_memories
    WHERE ${clauses.join(' AND ')}
    ORDER BY created_at DESC, id DESC LIMIT $${args.length}`, ...args);
  return { ok: true, project: OPERATING_MEMORY_PROJECT, count: rows.length, memories: rows.map(publicRecord) };
}
