/** Core registry authority for native employee lifecycle; never provisions legacy credentials. */
import { createHash, randomUUID } from 'node:crypto';
import { validateEmployeeAppearance } from './humation-appearance.js';

const VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function lifecycleError(code, status = 409) { const error = new Error(code); error.status = status; throw error; }
function text(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) lifecycleError(`invalid_${name}`, 400);
  return value.trim();
}
export function nativeLifecycle(employee) {
  const value = employee?.policyRules?.native_lifecycle;
  return value?.version === VERSION ? value : null;
}
export function employeeCanDispatch(employee, now = Date.now()) {
  if (!employee || employee.archivedAt || employee.status === 'paused') return false;
  const lifecycle = nativeLifecycle(employee);
  if (Object.hasOwn(employee.policyRules || {}, 'native_lifecycle') && !lifecycle) return false;
  return !lifecycle || (lifecycle.phase === 'active' && ['durable','temporary'].includes(lifecycle.kind) &&
    (lifecycle.kind !== 'temporary' || Date.parse(lifecycle.expires_at) > now));
}
export function validateNativeCreation(input, now = Date.now()) {
  const allowed = ['operation','creation_key','name','persona','role','avatar_url','lifecycle','expires_at','appearance'];
  if (!input || Object.keys(input).some(key => !allowed.includes(key))) lifecycleError('invalid_employee_creation', 400);
  const key = text(input.creation_key, 'creation_key', 160);
  if (!/^[A-Za-z0-9._:-]+$/.test(key)) lifecycleError('invalid_creation_key', 400);
  const name = text(input.name, 'name', 100);
  const persona = input.persona == null ? 'You are a newly created company employee. Use your saved name and identity. Introduce yourself plainly, recall available company context, and ask the user which responsibilities they want you to own through the existing native question tool, with grounded suggestions and a free-text option. Do not invent a role, company facts or approval. Confirm the agreed responsibilities before saving your own bounded profile. Existing permissions remain unchanged.' : text(input.persona, 'persona', 12000);
  const role = text(input.role || 'Specialist', 'role', 40);
  const kind = input.lifecycle || 'durable';
  if (!['durable','temporary'].includes(kind)) lifecycleError('invalid_lifecycle', 400);
  let expires_at = null;
  if (kind === 'temporary') {
    if (typeof input.expires_at !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(input.expires_at)
      || !Number.isFinite(Date.parse(input.expires_at)) || Date.parse(input.expires_at) <= now) lifecycleError('future_deadline_required', 400);
    expires_at = new Date(input.expires_at).toISOString();
  } else if (input.expires_at != null) lifecycleError('durable_deadline_not_allowed', 400);
  const avatar_url = input.avatar_url == null ? null : text(input.avatar_url, 'avatar_url', 2000);
  if (avatar_url) {
    let url; try { url = new URL(avatar_url); } catch { lifecycleError('invalid_avatar_url', 400); }
    if (url.protocol !== 'https:') lifecycleError('invalid_avatar_url', 400);
  }
  return { creation_key: key, name, persona, role, lifecycle: kind, expires_at, avatar_url, appearance: validateEmployeeAppearance(input.appearance) };
}
export async function requireLifecycleAdministrator(db, principal) {
  const membership = await db.userOrganization.findUnique({
    where: { userId_orgId: { userId: principal.userId, orgId: principal.orgId } },
    select: { isActive: true, role: true },
  });
  if (!membership?.isActive || !['owner','admin'].includes(membership.role)) lifecycleError('administrator_membership_required', 403);
}
function publicEmployee(row) {
  return { id: row.id, name: row.name, slug: row.slug, avatarUrl: row.avatarUrl,
    persona: row.persona, roleArchetype: row.roleArchetype, status: row.status,
    archivedAt: row.archivedAt, policyRules: row.policyRules };
}
/** One org-scoped transaction serializes replay and mutation on the existing registry. */
export async function manageNativeEmployee(db, principal, input, { closeout = inspectNativeCloseout, now = Date.now() } = {}) {
  await requireLifecycleAdministrator(db, principal);
  if (principal.runtimeSessionId) await requireNativeRuntime(db, principal);
  if (principal.employeeSessionId) {
    if (input?.operation !== 'configure' || input.employee_id !== principal.employeeId) lifecycleError('employee_profile_scope_required',403);
    await requireNativeEmployeeProfile(db, principal);
  }
  if (input?.operation === 'create') {
    const value = validateNativeCreation(input, -Infinity);
    const hash = createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const slug = `employee-${createHash('sha256').update(`${principal.orgId}:${value.creation_key}`).digest('hex').slice(0, 24)}`;
    return db.$transaction(async tx => {
      // PostgreSQL returns void here; Prisma raw queries need a readable column type.
      await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text AS lock', `${principal.orgId}:${slug}`);
      const existing = await tx.digitalEmployee.findUnique({ where: { orgId_slug: { orgId: principal.orgId, slug } } });
      if (existing) {
        if (nativeLifecycle(existing)?.creation_hash !== hash) lifecycleError('creation_key_content_conflict');
        return { employee: publicEmployee(existing), replayed: true };
      }
      if (value.lifecycle === 'temporary' && Date.parse(value.expires_at) <= now) lifecycleError('future_deadline_required', 400);
      const employee = await tx.digitalEmployee.create({ data: {
        id: randomUUID(), orgId: principal.orgId, createdBy: principal.userId, slug,
        name: value.name, persona: value.persona, roleArchetype: value.role, avatarUrl: value.avatar_url,
        scope: 'organization', status: 'draft', model: 'native-harness', llmProvider: 'native-harness',
        tools: [], enabledConnectors: [],
        policyRules: { ...(value.appearance ? {appearance:value.appearance} : {}), native_lifecycle: { version: VERSION, kind: value.lifecycle, phase: 'active',
          revision: 1, profile_revision:1, onboarding_required: !principal.runtimeSessionId || input.persona == null,
          profile_stage: principal.runtimeSessionId && input.persona != null ? 'ready' : 'responsibilities',
          ...(principal.runtimeSessionId && input.persona != null ? {profile_ready_at:new Date(now).toISOString(),joining_profile:{name:value.name,role:value.role,profileRevision:1,at:new Date(now).toISOString()}} : {}), expires_at: value.expires_at, creation_hash: hash, created_by: principal.userId,
          ...(principal.runtimeSessionId ? { runtime_session: principal.runtimeSessionId } : {}) } },
      } });
      return { employee: publicEmployee(employee), replayed: false };
    });
  }
  if (!UUID.test(input?.employee_id || '')) lifecycleError('invalid_employee_id', 400);
  if (!['configure','begin_closeout','inspect_closeout','archive'].includes(input.operation)) lifecycleError('invalid_lifecycle_operation', 400);
  return db.$transaction(async tx => {
    await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text AS lock', `${principal.orgId}:${input.employee_id}`);
    const row = await tx.digitalEmployee.findFirst({ where: { id: input.employee_id, orgId: principal.orgId } });
    if (!row) lifecycleError('employee_not_found', 404);
    const lifecycle = nativeLifecycle(row);
    if (!lifecycle) lifecycleError('native_employee_required');
    if (row.archivedAt) {
      if (input.operation === 'configure') lifecycleError('employee_profile_not_active');
      return { employee: publicEmployee(row), replayed: true, closeout: { ready: true, archived: true } };
    }
    if (input.operation === 'configure') {
      if (!employeeCanDispatch(row, now)) lifecycleError('employee_profile_not_active');
      if (Object.keys(input).some(key => !['operation','employee_id','expected_profile_revision','persona','role','name'].includes(key))) lifecycleError('invalid_employee_configuration',400);
      const update = {};
      if (input.persona !== undefined) update.persona = text(input.persona,'persona',12000);
      if (input.role !== undefined) update.roleArchetype = text(input.role,'role',40);
      if (input.name !== undefined) update.name = text(input.name,'name',100);
      if (!Object.keys(update).length) lifecycleError('empty_employee_configuration',400);
      const stage = principal.runtimeSessionId && update.persona ? 'ready' : 'runtime_review';
      const hash = createHash('sha256').update(JSON.stringify({update,stage})).digest('hex');
      if (lifecycle.profile_hash === hash) return {employee:publicEmployee(row),replayed:true};
      const revision = lifecycle.profile_revision ?? 1;
      if (input.expected_profile_revision !== revision) lifecycleError('employee_profile_revision_conflict');
      const updated = await tx.digitalEmployee.update({where:{id:row.id},data:{...update,
        policyRules:{...row.policyRules,native_lifecycle:{...lifecycle,profile_revision:revision+1,profile_hash:hash,
          profile_stage:stage,onboarding_required:stage !== 'ready',
          ...(stage === 'ready' ? {profile_ready_at:lifecycle.profile_ready_at ?? new Date(now).toISOString(),joining_profile:lifecycle.joining_profile ?? {name:update.name ?? row.name,role:update.roleArchetype ?? row.roleArchetype,profileRevision:revision+1,at:new Date(now).toISOString()}} : {})}}}});
      return {employee:publicEmployee(updated),replayed:false};
    }
    if (input.operation === 'begin_closeout') {
      if (lifecycle.phase === 'closing') return { employee: publicEmployee(row), replayed: true };
      if (input.expected_revision !== lifecycle.revision) lifecycleError('lifecycle_revision_conflict');
      const updated = await tx.digitalEmployee.update({ where: { id: row.id }, data: {
        policyRules: { ...row.policyRules, native_lifecycle: { ...lifecycle, phase: 'closing',
          revision: lifecycle.revision + 1, closing_at: new Date(now).toISOString() } },
      } });
      return { employee: publicEmployee(updated), replayed: false };
    }
    const evidence = await closeout(tx, principal, row);
    if (input.operation === 'inspect_closeout') return { employee: publicEmployee(row), closeout: evidence };
    if (input.expected_revision !== lifecycle.revision) lifecycleError('lifecycle_revision_conflict');
    if (!evidence.ready) return { employee: publicEmployee(row), closeout: evidence, code: 'closeout_required' };
    const updated = await tx.digitalEmployee.update({ where: { id: row.id }, data: {
      archivedAt: new Date(now), status: 'paused', policyRules: { ...row.policyRules,
        native_lifecycle: { ...lifecycle, phase: 'archived', revision: lifecycle.revision + 1,
          archived_by: principal.userId, archived_at: new Date(now).toISOString(), closeout: evidence } },
    } });
    return { employee: publicEmployee(updated), closeout: evidence, replayed: false };
  });
}

/** A signed operating claim must refer to this administrator's actual persistent Chief room. */
export async function requireNativeRuntime(db, principal) {
  await db.$transaction(async tx => {
    await tx.$queryRawUnsafe("SELECT set_config('app.hivemind_org_id',$1,true),set_config('app.hivemind_user_id',$2,true)", principal.orgId, principal.userId);
    const schemas = await tx.$queryRawUnsafe("SELECT table_schema FROM information_schema.tables WHERE table_name='harness_sessions'");
    if (schemas.length !== 1 || !/^[a-z_][a-z0-9_]*$/.test(schemas[0].table_schema)) lifecycleError('native_storage_unavailable', 503);
    const schema = schemas[0].table_schema;
    const sessions = await tx.$queryRawUnsafe(`SELECT header FROM ${schema}.harness_sessions WHERE id=$1 AND org_id=$2::uuid AND user_id=$3::uuid`, principal.runtimeSessionId, principal.orgId, principal.userId);
    const header = sessions[0]?.header;
    if (!header || header.parentSession) lifecycleError('runtime_session_required', 403);
    const events = await tx.$queryRawUnsafe(`SELECT event_type,payload FROM ${schema}.harness_session_events WHERE session_id=$1 AND org_id=$2::uuid AND user_id=$3::uuid AND event_type IN ('agent-preset/selected','hivemind/session-owner') ORDER BY sequence`, principal.runtimeSessionId, principal.orgId, principal.userId);
    let preset = header.agentPreset; let owner;
    for (const event of events) {
      const data = event.payload.data ?? event.payload;
      if (event.event_type === 'agent-preset/selected') preset = data.agentPreset;
      if (event.event_type === 'hivemind/session-owner') owner = data;
    }
    if (preset !== 'hivemind-hq' || owner?.id !== null || owner.slug !== 'runtime') lifecycleError('runtime_session_required', 403);
  });
}

/** Self refinement is bound to an actual tenant-owned persistent employee root. */
export async function requireNativeEmployeeProfile(db, principal) {
  if (!UUID.test(principal.employeeId || '')) lifecycleError('employee_profile_scope_required',403);
  await db.$transaction(async tx => {
    await tx.$queryRawUnsafe("SELECT set_config('app.hivemind_org_id',$1,true),set_config('app.hivemind_user_id',$2,true)",principal.orgId,principal.userId);
    const schemas=await tx.$queryRawUnsafe("SELECT table_schema FROM information_schema.tables WHERE table_name='harness_sessions'");
    if (schemas.length!==1 || !/^[a-z_][a-z0-9_]*$/.test(schemas[0].table_schema)) lifecycleError('native_storage_unavailable',503);
    const schema=schemas[0].table_schema;
    const sessions=await tx.$queryRawUnsafe(`SELECT header FROM ${schema}.harness_sessions WHERE id=$1 AND org_id=$2::uuid AND user_id=$3::uuid`,principal.employeeSessionId,principal.orgId,principal.userId);
    const header=sessions[0]?.header;
    if (!header || header.parentSession) lifecycleError('employee_profile_scope_required',403);
    const events=await tx.$queryRawUnsafe(`SELECT event_type,payload FROM ${schema}.harness_session_events WHERE session_id=$1 AND org_id=$2::uuid AND user_id=$3::uuid AND event_type IN ('agent-preset/selected','hivemind/session-owner') ORDER BY sequence`,principal.employeeSessionId,principal.orgId,principal.userId);
    let preset=header.agentPreset,owner;
    for (const event of events) {
      const data=event.payload.data??event.payload;
      if (event.event_type==='agent-preset/selected') preset=data.agentPreset;
      if (event.event_type==='hivemind/session-owner') owner=data;
    }
    if (preset!=='hivemind-hyperagents' || owner?.id!==principal.employeeId) lifecycleError('employee_profile_scope_required',403);
  });
}

/** Include native session-backed children of the exact employee roots, within this organization only. */
function employeeSessionIds(sessions, owners, employeeId) {
  const ids = new Set(sessions.filter(row => owners.get(row.id)?.id === employeeId).map(row => row.id));
  for (let depth = 0; depth < 32; depth += 1) {
    let changed = false;
    for (const row of sessions) if (!ids.has(row.id) && ids.has(row.header?.parentSession)) {
      ids.add(row.id); changed = true;
    }
    if (!changed) return ids;
  }
  lifecycleError('employee_session_ancestry_limit', 503);
}

/** Read current native task acceptance and successful private closeout memory, never employee prose. */
export async function inspectNativeCloseout(tx, principal, employee) {
  const schemas = await tx.$queryRawUnsafe("SELECT table_schema FROM information_schema.tables WHERE table_name='harness_sessions'");
  if (schemas.length !== 1 || !/^[a-z_][a-z0-9_]*$/.test(schemas[0].table_schema)) lifecycleError('native_storage_unavailable', 503);
  const schema = schemas[0].table_schema;
  // Organization employee closeout must not silently omit another authorized user's work.
  // Core's existing authority pool can read these records; the restricted runner cannot.
  const roles = await tx.$queryRawUnsafe('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
  if (!roles[0]?.rolsuper && !roles[0]?.rolbypassrls) lifecycleError('organization_closeout_read_authority_required', 503);
  const events = await tx.$queryRawUnsafe(`SELECT session_id,event_type,payload,sequence FROM ${schema}.harness_session_events WHERE org_id=$1::uuid AND event_type IN ('hivemind/hq-employee-assignment','team/task','hivemind/hq-task-review','hivemind/employee-delegation-start','hivemind/employee-delegation-end','hivemind/session-owner','turn/start','turn/end') ORDER BY session_id,sequence`, principal.orgId);
  const assignments = new Map(); const tasks = new Map(); const reviews = new Map();
  const delegations = new Map(), owners = new Map(), turns = new Map(); let lastAssignmentAt = 0;
  for (const event of events) {
    const data = event.payload.data ?? event.payload;
    if (event.event_type === 'hivemind/session-owner') owners.set(event.session_id, data);
    if (event.event_type === 'turn/start' || event.event_type === 'turn/end') turns.set(event.session_id, event.event_type);
    const taskData = event.event_type === 'team/task' ? data.task : data;
    const key = `${event.session_id}:${taskData?.taskId ?? taskData?.id}`;
    if (event.event_type === 'hivemind/hq-employee-assignment') {
      if (data.employeeId === employee.id) {
        assignments.set(key, data); lastAssignmentAt = Math.max(lastAssignmentAt, Number(event.payload.time) || 0);
      } else assignments.delete(key);
    }
    if (event.event_type === 'team/task') tasks.set(key, taskData);
    if (event.event_type === 'hivemind/hq-task-review') reviews.set(key, data);
    if (event.event_type === 'hivemind/employee-delegation-start' && data.employeeId === employee.id) delegations.set(`${event.session_id}:${data.delegationId}`, false);
    if (event.event_type === 'hivemind/employee-delegation-end' && data.employeeId === employee.id) delegations.set(`${event.session_id}:${data.delegationId}`, true);
  }
  const sessions = await tx.$queryRawUnsafe(`SELECT id,header FROM ${schema}.harness_sessions WHERE org_id=$1::uuid`, principal.orgId);
  const employeeRooms = employeeSessionIds(sessions, owners, employee.id);
  const blockers = [];
  if ([...turns].some(([sessionId, boundary]) => employeeRooms.has(sessionId) && boundary === 'turn/start')) blockers.push('employee_active_turn_requires_closeout');
  if ([...tasks].some(([key, task]) => employeeRooms.has(key.slice(0, key.lastIndexOf(':'))) && !['completed','deleted'].includes(task?.status))) blockers.push('employee_child_work_requires_closeout');
  if ([...delegations.values()].some(done => !done)) blockers.push('employee_child_work_requires_closeout');
  for (const [key] of assignments) {
    const task = tasks.get(key); const review = reviews.get(key);
    if (task?.status === 'deleted') continue;
    if (task?.status !== 'completed' || review?.status !== 'accepted' || review?.reviewer !== 'runtime'
      || review.taskRevision !== task.revision - 1) blockers.push('assigned_work_requires_runtime_review');
  }
  const memory = await tx.hyperAgentOperatingMemory.findFirst({ where: { orgId: principal.orgId,
    agentSlug: employee.slug, projectSlug: 'hyper-agents', status: 'recorded', kind: { in: ['handoff','learning'] } },
    orderBy: { createdAt: 'desc' }, select: { id: true, createdAt: true } });
  if (!memory || new Date(memory.createdAt).getTime() < lastAssignmentAt) blockers.push('verified_private_closeout_required');
  return { ready: blockers.length === 0, blockers: [...new Set(blockers)],
    reviewed_task_count: assignments.size, ...(memory ? { memory_id: memory.id } : {}) };
}

/** Administrator-only attestation for the existing native host's limited lifecycle effects. */
export async function nativeLifecycleHostProof(db, principal, employeeId) {
  await requireLifecycleAdministrator(db, principal);
  return db.$transaction(async tx => {
    const employee = await tx.digitalEmployee.findFirst({ where: { id: employeeId, orgId: principal.orgId } });
    const lifecycle = nativeLifecycle(employee);
    if (!employee || !lifecycle) lifecycleError('native_employee_not_found', 404);
    const schemas = await tx.$queryRawUnsafe("SELECT table_schema FROM information_schema.tables WHERE table_name='harness_sessions'");
    if (schemas.length !== 1 || !/^[a-z_][a-z0-9_]*$/.test(schemas[0].table_schema)) lifecycleError('native_storage_unavailable', 503);
    const schema = schemas[0].table_schema;
    const roles = await tx.$queryRawUnsafe('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
    if (!roles[0]?.rolsuper && !roles[0]?.rolbypassrls) lifecycleError('organization_closeout_read_authority_required', 503);
    const sessions = await tx.$queryRawUnsafe(`SELECT id,user_id,header FROM ${schema}.harness_sessions WHERE org_id=$1::uuid ORDER BY updated_at DESC`, principal.orgId);
    const events = await tx.$queryRawUnsafe(`SELECT session_id,event_type,payload FROM ${schema}.harness_session_events WHERE org_id=$1::uuid AND event_type IN ('agent-preset/selected','hivemind/session-owner') ORDER BY session_id,sequence`, principal.orgId);
    const owners = new Map(), presets = new Map();
    for (const event of events) {
      const data = event.payload.data ?? event.payload;
      if (event.event_type === 'hivemind/session-owner') owners.set(event.session_id, data);
      if (event.event_type === 'agent-preset/selected') presets.set(event.session_id, data.agentPreset);
    }
    const owned = employeeSessionIds(sessions, owners, employeeId);
    const rooms = sessions.filter(row => owned.has(row.id)).map(row => ({ sessionId: row.id, userId: row.user_id }));
    const chiefs = sessions.filter(row => !row.header.parentSession
      && (presets.get(row.id) ?? row.header.agentPreset) === 'hivemind-hq'
      && owners.get(row.id)?.slug === 'runtime' && owners.get(row.id)?.id === null);
    if (rooms.length > 1000 || chiefs.length > 1000) lifecycleError('native_room_enumeration_limit', 503);
    const chief = chiefs.find(row => row.user_id === principal.userId);
    return { employeeId, revision: lifecycle.revision, kind: lifecycle.kind, phase: lifecycle.phase,
      expiresAt: lifecycle.expires_at,
      ...(lifecycle.onboarding_required && lifecycle.profile_stage !== 'runtime_review' && lifecycle.phase === 'active' ? { onboarding: {name:employee.name,role:employee.roleArchetype,creationHash:lifecycle.creation_hash} } : {}),
      ...(lifecycle.profile_stage === 'runtime_review' && lifecycle.phase === 'active' ? {profileReview:{name:employee.name,role:employee.roleArchetype,persona:employee.persona,profileRevision:lifecycle.profile_revision,creationHash:lifecycle.creation_hash}} : {}),
      ...(lifecycle.profile_stage === 'ready' && lifecycle.phase === 'active' && lifecycle.joining_profile ? {joined:{...lifecycle.joining_profile,creationHash:lifecycle.creation_hash}} : {}),
      rooms, chiefs: chiefs.map(row => ({sessionId:row.id,userId:row.user_id})), chief: chief ? { sessionId: chief.id, userId: chief.user_id } : null };
  });
}
