/** Core registry authority for native employee lifecycle; never provisions legacy credentials. */
import { createHash, randomUUID } from 'node:crypto';
import { validateEmployeeAppearance } from './humation-appearance.js';
import { nativeAgentStoragePrincipal } from '../harness-chat/organization-agent-access.js';
import { removeOpenDotEmployeeWithRetry } from './open-dot-removal.js';

const VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function lifecycleError(code, status = 409) { const error = new Error(code); error.status = status; throw error; }
// Session persistence is configured for the hivemind schema. Restored or
// archived schemas may contain tables with the same name; they are never an
// authority for live employee lifecycle decisions.
async function nativeHarnessSchema(tx) {
  const rows = await tx.$queryRawUnsafe("SELECT table_schema FROM information_schema.tables WHERE table_schema='hivemind' AND table_name='harness_sessions' AND table_type='BASE TABLE'");
  if (rows.length !== 1) lifecycleError('native_storage_unavailable', 503);
  return 'hivemind';
}
/** Session ids named by a fresh reset; anything malformed is rejected so the exclusion cannot widen by accident. */
function resetSessionIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 500 || value.some(id => typeof id !== 'string' || !/^session-[A-Za-z0-9_-]{1,120}$/.test(id))) lifecycleError('invalid_reset_session_ids', 400);
  return value;
}
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
  // Open Dot employees have a separate executor. Until that adapter owns the
  // dispatch path, never let an Open Dot click fall through to native DSH.
  if (Object.hasOwn(employee.policyRules || {}, 'open_dot_employee')) return false;
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
export async function manageNativeEmployee(db, principal, input, { closeout = inspectNativeCloseout, now = Date.now(), executionBackend = 'native', predefinedStarter, openDotRemoval = removeOpenDotEmployeeWithRetry } = {}) {
  await requireLifecycleAdministrator(db, principal);
  if (principal.runtimeSessionId) await requireNativeRuntime(db, principal);
  if (principal.employeeSessionId) {
    if (input?.operation !== 'configure' || input.employee_id !== principal.employeeId) lifecycleError('employee_profile_scope_required',403);
    await requireNativeEmployeeProfile(db, principal);
  }
  if (input?.operation === 'create') {
    const value = validateNativeCreation(input, -Infinity);
    if (predefinedStarter && (executionBackend !== 'open-dot' || !input.persona || !Number.isInteger(predefinedStarter.slot) || predefinedStarter.slot < 0 || predefinedStarter.slot > 2 || predefinedStarter.source !== 'hyperagents-onboarding')) lifecycleError('invalid_predefined_starter', 400);
    const profileReady = input.persona != null && (!!principal.runtimeSessionId || !!predefinedStarter);
    if (!['native','open-dot'].includes(executionBackend)) lifecycleError('invalid_execution_backend',400);
    const inputDigest = createHash('sha256').update(JSON.stringify({
      name:value.name, persona:value.persona, role:value.role, lifecycle:value.lifecycle,
      expires_at:value.expires_at, avatar_url:value.avatar_url, appearance:value.appearance,
    })).digest('hex');
    const hash = executionBackend === 'open-dot'
      ? createHash('sha256').update(JSON.stringify({execution_backend:executionBackend,input_digest:inputDigest,...(predefinedStarter ? {predefined_starter:predefinedStarter} : {})})).digest('hex')
      : createHash('sha256').update(JSON.stringify(value)).digest('hex');
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
        // DigitalEmployee has no execution-backend column. Keep the integration
        // marker in reserved policyRules metadata beside the canonical lifecycle
        // and appearance until a dedicated schema field is justified.
        policyRules: { ...(value.appearance ? {appearance:value.appearance} : {}), native_lifecycle: { version: VERSION, kind: value.lifecycle, phase: executionBackend === 'open-dot' ? 'provisioning' : 'active',
          revision: 1, profile_revision:1, onboarding_required: !profileReady,
          profile_stage: profileReady ? 'ready' : 'responsibilities',
          ...(predefinedStarter ? {predefined_starter:{version:1,...predefinedStarter}} : {}),
          ...(profileReady ? {profile_ready_at:new Date(now).toISOString(),joining_profile:{name:value.name,role:value.role,profileRevision:1,at:new Date(now).toISOString()}} : {}), expires_at: value.expires_at, creation_hash: hash, created_by: principal.userId,
          ...(principal.runtimeSessionId ? { runtime_session: principal.runtimeSessionId } : {}) },
          ...(executionBackend === 'open-dot' ? {open_dot_employee:{version:VERSION,execution_backend:'open-dot',state:'provisioning',execution_state:'pending',creation_key:value.creation_key,input_digest:inputDigest,binding_revision:1}} : {}) },
      } });
      return { employee: publicEmployee(employee), replayed: false };
    });
  }
  if (!UUID.test(input?.employee_id || '')) lifecycleError('invalid_employee_id', 400);
  if (!['configure','begin_closeout','inspect_closeout','archive','fresh_reset_archive','remove','pause_archive','unarchive'].includes(input.operation)) lifecycleError('invalid_lifecycle_operation', 400);
  const resetSessions = input.operation === 'fresh_reset_archive' ? resetSessionIds(input.reset_session_ids) : [];
  const storageUserId = resetSessions.length ? (await nativeAgentStoragePrincipal(db, principal)).userId : null;
  let outcome;
  try {
  outcome = await db.$transaction(async tx => {
    await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text AS lock', `${principal.orgId}:${input.employee_id}`);
    const row = await tx.digitalEmployee.findFirst({ where: { id: input.employee_id, orgId: principal.orgId } });
    if (!row) lifecycleError('employee_not_found', 404);
    const lifecycle = nativeLifecycle(row);
    if (!lifecycle) lifecycleError('native_employee_required');
    if (input.operation === 'remove') {
      // An administrator deletes the employee for good: the row goes, with its action intents. Library artifacts and
      // team memory are separate records and stay. An archived employee can be removed too.
      await tx.digitalEmployee.delete({ where: { id: row.id } });
      return { employee: publicEmployee(row), removed: true };
    }
    if (input.operation === 'pause_archive' || input.operation === 'unarchive') {
      // Reversible archive: the employee leaves the roster and every dispatch path (archivedAt + paused), while its
      // profile, chats, memory and files stay. Retirement (`archive`, `fresh_reset_archive`) is a different phase and is never restorable.
      const state = lifecycle.archive;
      if (input.operation === 'pause_archive') {
        if (row.archivedAt) return { employee: publicEmployee(row), replayed: true };
        if (lifecycle.phase !== 'active') lifecycleError('employee_not_archivable');
        const updated = await tx.digitalEmployee.update({ where: { id: row.id }, data: { archivedAt: new Date(now), status: 'paused',
          policyRules: { ...row.policyRules, native_lifecycle: { ...lifecycle, revision: lifecycle.revision + 1,
            archive: { reversible: true, previous_status: row.status, archived_by: principal.userId, archived_at: new Date(now).toISOString() } } } } });
        return { employee: publicEmployee(updated), replayed: false };
      }
      if (!row.archivedAt) return { employee: publicEmployee(row), replayed: true };
      if (state?.reversible !== true || lifecycle.phase !== 'active') lifecycleError('employee_not_restorable');
      const { archive: _archive, ...rest } = lifecycle;
      const restored = state.previous_status && state.previous_status !== 'paused' ? state.previous_status : 'draft';
      const updated = await tx.digitalEmployee.update({ where: { id: row.id }, data: { archivedAt: null, status: restored,
        policyRules: { ...row.policyRules, native_lifecycle: { ...rest, revision: lifecycle.revision + 1,
          unarchived_by: principal.userId, unarchived_at: new Date(now).toISOString() } } } });
      return { employee: publicEmployee(updated), replayed: false };
    }
    if (row.archivedAt) {
      if (input.operation === 'configure') lifecycleError('employee_profile_not_active');
      return { employee: publicEmployee(row), replayed: true, closeout: { ready: true, archived: true } };
    }
    if (input.operation === 'fresh_reset_archive') {
      // A human-initiated fresh start discards this user's private work. It is
      // distinct from ordinary closeout, which still requires accepted tasks
      // and a saved handoff. Never retire a starter or an employee referenced
      // by another user's surviving native work.
      if (input.confirmed !== true || input.expected_revision !== lifecycle.revision
        || row.createdBy !== principal.userId || lifecycle.predefined_starter) lifecycleError('fresh_archive_not_authorized', 403);
      const schema = await nativeHarnessSchema(tx);
      // The Runtime passes the sessions its reset is deleting. References inside those sessions are this user's own
      // private work, so they never block the archive; the exclusion applies only to the storage user's own sessions,
      // so a caller cannot hide another user's surviving work by naming its sessions.
      const references = await tx.$queryRawUnsafe(`SELECT 1 FROM ${schema}.harness_session_events
        WHERE org_id=$1::uuid AND event_type IN ('hivemind/session-owner','hivemind/hq-employee-assignment')
          AND (COALESCE(payload->'data',payload)->>'id'=$2 OR COALESCE(payload->'data',payload)->>'employeeId'=$2)
          AND NOT (user_id=$4::uuid AND session_id=ANY($3::text[]))
        LIMIT 1`, principal.orgId, row.id, resetSessions, storageUserId ?? '00000000-0000-0000-0000-000000000000');
      if (references.length) lifecycleError('fresh_archive_surviving_work', 409);
      const foreignMemory = await tx.hyperAgentOperatingMemory.count({ where: { orgId:principal.orgId,
        agentSlug:row.slug, authorUserId:{ not:principal.userId } } });
      if (foreignMemory) lifecycleError('fresh_archive_shared_memory', 409);
      const updated = await tx.digitalEmployee.update({ where:{ id:row.id }, data:{ archivedAt:new Date(now), status:'paused',
        policyRules:{ ...row.policyRules, native_lifecycle:{ ...lifecycle, phase:'archived', revision:lifecycle.revision+1,
          archived_by:principal.userId, archived_at:new Date(now).toISOString(), fresh_reset:true } } } });
      return { employee:publicEmployee(updated), replayed:false, freshReset:true };
    }
    if (input.operation === 'configure') {
      const dot = row.policyRules?.open_dot_employee;
      const dotProfileMayBeConfigured = dot?.version === VERSION && dot.execution_backend === 'open-dot'
        && dot.state === 'bound' && nativeLifecycle(row)?.phase === 'active';
      if (!employeeCanDispatch(row, now) && !dotProfileMayBeConfigured) lifecycleError('employee_profile_not_active');
      if (Object.keys(input).some(key => !['operation','employee_id','expected_profile_revision','persona','role','name','appearance'].includes(key))) lifecycleError('invalid_employee_configuration',400);
      const update = {};
      if (input.persona !== undefined) update.persona = text(input.persona,'persona',12000);
      if (input.role !== undefined) update.roleArchetype = text(input.role,'role',40);
      if (input.name !== undefined) update.name = text(input.name,'name',100);
      const appearance = input.appearance === undefined ? undefined : validateEmployeeAppearance(input.appearance);
      if (input.appearance !== undefined && !appearance) lifecycleError('invalid_employee_appearance',400);
      const appearanceOnly = Object.keys(update).length === 0 && appearance !== undefined;
      if (!Object.keys(update).length && appearance === undefined) lifecycleError('empty_employee_configuration',400);
      // A visual edit never restarts onboarding or changes responsibility/permission state.
      if (appearanceOnly) {
        let previousAppearance = null;
        try { previousAppearance = validateEmployeeAppearance(row.policyRules?.appearance); } catch { /* An authorized visual edit may repair invalid old visual metadata. */ }
        if (JSON.stringify(previousAppearance) === JSON.stringify(appearance)) return {employee:publicEmployee(row),replayed:true,appearanceOnly:true};
        const revision = lifecycle.profile_revision ?? 1;
        if (input.expected_profile_revision !== revision) lifecycleError('employee_profile_revision_conflict');
        const updated = await tx.digitalEmployee.update({where:{id:row.id},data:{policyRules:{...row.policyRules,appearance,
          native_lifecycle:{...lifecycle,profile_revision:revision+1}}}});
        return {employee:publicEmployee(updated),replayed:false,appearanceOnly:true};
      }
      const stage = principal.runtimeSessionId && update.persona ? 'ready' : 'runtime_review';
      const hash = createHash('sha256').update(JSON.stringify({update,stage,...(appearance ? {appearance} : {})})).digest('hex');
      if (lifecycle.profile_hash === hash) return {employee:publicEmployee(row),replayed:true};
      const revision = lifecycle.profile_revision ?? 1;
      if (input.expected_profile_revision !== revision) lifecycleError('employee_profile_revision_conflict');
      const updated = await tx.digitalEmployee.update({where:{id:row.id},data:{...update,
        policyRules:{...row.policyRules,...(appearance ? {appearance} : {}),native_lifecycle:{...lifecycle,profile_revision:revision+1,profile_hash:hash,
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
  } catch (error) {
    // A repeated removal finishes an Open Dot cleanup that was still pending when the employee row went; the controller
    // resolves the dot from its own employee binding, so nothing but the administrator's organization is trusted here.
    if (input.operation === 'remove' && error?.message === 'employee_not_found') {
      const cleanup = await openDotRemoval({ orgId: principal.orgId, employeeId: input.employee_id });
      if (cleanup.status === 'verified' && cleanup.dotsRemoved > 0) return { employee: { id: input.employee_id }, removed: true, replayed: true, open_dot_cleanup: cleanup };
    }
    throw error;
  }
  if (input.operation === 'remove' && outcome.removed) {
    const marker = outcome.employee.policyRules?.open_dot_employee;
    // The employee row is already gone; a pending cleanup is reported, retried in the background and on a repeated removal.
    if (marker) outcome.open_dot_cleanup = await openDotRemoval({ orgId: principal.orgId, employeeId: outcome.employee.id, dotId: marker.dot_id });
  }
  return outcome;
}

/** A signed operating claim must refer to this administrator's actual persistent Chief room. */
export async function requireNativeRuntime(db, principal) {
  principal = await nativeAgentStoragePrincipal(db,principal);
  await db.$transaction(async tx => {
    await tx.$queryRawUnsafe("SELECT set_config('app.hivemind_org_id',$1,true),set_config('app.hivemind_user_id',$2,true)", principal.orgId, principal.userId);
    const schema = await nativeHarnessSchema(tx);
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
  principal = await nativeAgentStoragePrincipal(db,principal);
  if (!UUID.test(principal.employeeId || '')) lifecycleError('employee_profile_scope_required',403);
  await db.$transaction(async tx => {
    await tx.$queryRawUnsafe("SELECT set_config('app.hivemind_org_id',$1,true),set_config('app.hivemind_user_id',$2,true)",principal.orgId,principal.userId);
    const schema=await nativeHarnessSchema(tx);
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
  const schema = await nativeHarnessSchema(tx);
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
  const storage=await nativeAgentStoragePrincipal(db,principal);
  return db.$transaction(async tx => {
    const employee = await tx.digitalEmployee.findFirst({ where: { id: employeeId, orgId: principal.orgId } });
    const lifecycle = nativeLifecycle(employee);
    if (!employee || !lifecycle) lifecycleError('native_employee_not_found', 404);
    const schema = await nativeHarnessSchema(tx);
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
    const chief = chiefs.find(row => row.user_id === storage.userId);
    return { employeeId, revision: lifecycle.revision, kind: lifecycle.kind, phase: lifecycle.phase,
      expiresAt: lifecycle.expires_at,
      ...(lifecycle.onboarding_required && lifecycle.profile_stage !== 'runtime_review' && lifecycle.phase === 'active' ? { onboarding: {name:employee.name,role:employee.roleArchetype,creationHash:lifecycle.creation_hash} } : {}),
      ...(lifecycle.profile_stage === 'runtime_review' && lifecycle.phase === 'active' ? {profileReview:{name:employee.name,role:employee.roleArchetype,persona:employee.persona,profileRevision:lifecycle.profile_revision,creationHash:lifecycle.creation_hash}} : {}),
      ...(lifecycle.profile_stage === 'ready' && lifecycle.phase === 'active' && lifecycle.joining_profile ? {joined:{...lifecycle.joining_profile,creationHash:lifecycle.creation_hash}} : {}),
      rooms, chiefs: chiefs.map(row => ({sessionId:row.id,userId:row.user_id})), chief: chief ? { sessionId: chief.id, userId: chief.user_id } : null };
  });
}
