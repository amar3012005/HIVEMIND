/** Core-owned HIVE registry seam for employees created or adopted by Open Dot. */
import { createHash } from 'node:crypto';
import { manageNativeEmployee, nativeLifecycle, requireLifecycleAdministrator, inspectNativeCloseout, lifecycleError } from './native-lifecycle.js';

const VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BINDING_URL = 'https://dots.singulancelabs.com/api/hivemind/employees';
const MAX_BINDING_BYTES = 64 * 1024;

function publicEmployee(row) {
  return { id: row.id, name: row.name, slug: row.slug, avatarUrl: row.avatarUrl,
    persona: row.persona, roleArchetype: row.roleArchetype, status: row.status,
    archivedAt: row.archivedAt, policyRules: row.policyRules || {} };
}

function lifecycleSummary(employee) {
  const lifecycle = nativeLifecycle(employee);
  return lifecycle ? { phase: lifecycle.phase, revision: lifecycle.revision,
    profile_revision: lifecycle.profile_revision, profile_stage: lifecycle.profile_stage,
    onboarding_required: lifecycle.onboarding_required } : null;
}

function text(value, name, max = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) lifecycleError(`invalid_${name}`, 400);
  return value.trim();
}

function assertExactKeys(input, allowed, error = 'invalid_open_dot_employee_request') {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !allowed.includes(key))) lifecycleError(error, 400);
}

/**
 * Open Dot's fixed BFF proves the persisted employee claim. The user session
 * cookie is forwarded alone; caller-supplied URLs, tenant IDs, and identity
 * fields are never used to construct authority.
 */
export async function verifyOpenDotBinding({ employeeId, creationKey, principal, sessionCookie, fetchImpl = fetch }) {
  if (!UUID.test(employeeId || '')) lifecycleError('invalid_employee_id', 400);
  const key = text(creationKey, 'creation_key');
  if (!/^[A-Za-z0-9._:-]+$/.test(key)) lifecycleError('invalid_creation_key', 400);
  if (!sessionCookie) lifecycleError('hive_session_cookie_required', 401);
  let response;
  try {
    response = await fetchImpl(`${BINDING_URL}/${encodeURIComponent(employeeId)}/binding`, {
      method: 'GET',
      headers: { Cookie: `hm_cp_session=${encodeURIComponent(sessionCookie)}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    lifecycleError('open_dot_binding_unavailable', 503);
  }
  if (!response?.ok) {
    if (response?.status >= 500) lifecycleError('open_dot_binding_unavailable', 503);
    if (response?.status === 401 || response?.status === 403) lifecycleError('open_dot_binding_forbidden', 403);
    lifecycleError('open_dot_binding_unverified', 409);
  }
  let raw;
  try {
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const chunks = []; let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BINDING_BYTES) {
          await reader.cancel();
          lifecycleError('open_dot_binding_response_too_large', 502);
        }
        chunks.push(Buffer.from(value));
      }
      raw = Buffer.concat(chunks).toString('utf8');
    } else {
      raw = await response.text();
      if (Buffer.byteLength(raw) > MAX_BINDING_BYTES) lifecycleError('open_dot_binding_response_too_large', 502);
    }
  } catch (error) {
    if (error?.status) throw error;
    lifecycleError('open_dot_binding_unavailable', 503);
  }
  let proof;
  try { proof = JSON.parse(raw); } catch { lifecycleError('open_dot_binding_unverified', 409); }
  const dotId = typeof proof?.dotId === 'string' ? proof.dotId.trim() : '';
  if (proof?.organizationId !== principal.orgId || proof?.userId !== principal.userId
      || proof?.employeeId !== employeeId || proof?.creationKey !== key
      || !dotId || dotId.length > 160) lifecycleError('open_dot_binding_unverified', 409);
  return Object.freeze({ dotId, organizationId: principal.orgId, userId: principal.userId,
    employeeId, creationKey: key });
}

export async function createOpenDotEmployee(db, principal, input) {
  assertExactKeys(input, ['operation','creation_key','name','persona','role','avatar_url','appearance']);
  if (input.operation !== 'create') lifecycleError('invalid_open_dot_employee_operation', 400);
  const result = await manageNativeEmployee(db, principal, input, { executionBackend: 'open-dot' });
  const lifecycle = nativeLifecycle(result.employee);
  const marker = result.employee.policyRules?.open_dot_employee;
  return { ...result, employee: publicEmployee(result.employee), scope: { organizationId: principal.orgId, userId: principal.userId },
    lifecycle: lifecycle ? lifecycleSummary(result.employee) : null,
    open_dot_employee: marker || null };
}

/** Verify Dot ownership first, then atomically attach only server-owned registry metadata. */
export async function bindOpenDotEmployee(db, principal, input, { proof, now = Date.now() } = {}) {
  assertExactKeys(input, ['operation','employee_id','creation_key','expected_binding_revision']);
  if (!['bind','adopt'].includes(input.operation)) lifecycleError('invalid_open_dot_employee_operation', 400);
  if (!UUID.test(input.employee_id || '')) lifecycleError('invalid_employee_id', 400);
  const creationKey = text(input.creation_key, 'creation_key');
  if (!/^[A-Za-z0-9._:-]+$/.test(creationKey)) lifecycleError('invalid_creation_key', 400);
  if (!Number.isInteger(input.expected_binding_revision) || input.expected_binding_revision < 0) {
    lifecycleError('invalid_expected_binding_revision', 400);
  }
  if (!proof || proof.employeeId !== input.employee_id || proof.creationKey !== creationKey
      || proof.organizationId !== principal.orgId || proof.userId !== principal.userId
      || typeof proof.dotId !== 'string' || !proof.dotId) lifecycleError('open_dot_binding_unverified', 409);

  await requireLifecycleAdministrator(db, principal);
  return db.$transaction(async tx => {
    await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text AS lock', `${principal.orgId}:open-dot-id:${proof.dotId}`);
    await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text AS lock', `${principal.orgId}:open-dot:${input.employee_id}`);
    const duplicateDot = await tx.digitalEmployee.findFirst({ where: { orgId: principal.orgId,
      id: { not: input.employee_id }, policyRules: { path: ['open_dot_employee','dot_id'], equals: proof.dotId } }, select: { id: true } });
    if (duplicateDot) lifecycleError('open_dot_id_already_bound', 409);
    const row = await tx.digitalEmployee.findFirst({ where: { id: input.employee_id, orgId: principal.orgId } });
    if (!row) lifecycleError('employee_not_found', 404);
    if (row.archivedAt || row.status === 'paused') lifecycleError('employee_profile_not_active');
    if (input.operation === 'adopt' && ['running','deploying'].includes(row.status)) {
      lifecycleError('open_dot_employee_needs_reconciliation', 409);
    }
    const lifecycle = nativeLifecycle(row);
    if (Object.hasOwn(row.policyRules || {}, 'native_lifecycle') && !lifecycle) lifecycleError('native_employee_required');
    if (lifecycle && !['active','provisioning'].includes(lifecycle.phase)) lifecycleError('employee_profile_not_active');

    const current = row.policyRules?.open_dot_employee;
    if (current && (current.version !== VERSION || current.execution_backend !== 'open-dot')) {
      lifecycleError('open_dot_registry_metadata_conflict');
    }
    const isNewCreation = input.operation === 'bind';
    if (isNewCreation && (!current || current.state !== 'provisioning' || current.creation_key !== creationKey)) {
      lifecycleError('open_dot_creation_not_pending', 409);
    }
    if (!isNewCreation && current && current.creation_key !== creationKey) {
      lifecycleError('open_dot_employee_already_bound', 409);
    }
    if (current?.state === 'bound') {
      if (current.dot_id === proof.dotId && current.creation_key === creationKey) {
        return { employee: publicEmployee(row), replayed: true, scope: { organizationId: principal.orgId, userId: principal.userId },
          lifecycle: lifecycleSummary(row), open_dot_employee: current };
      }
      lifecycleError('open_dot_employee_already_bound', 409);
    }
    const currentRevision = current?.binding_revision ?? 0;
    if (input.expected_binding_revision !== currentRevision) lifecycleError('open_dot_binding_revision_conflict', 409);
    if (input.operation === 'adopt' && current) lifecycleError('open_dot_employee_already_bound', 409);
    if (input.operation === 'adopt' && lifecycle) {
      const closeout = await inspectNativeCloseout(tx, principal, row);
      const activeWork = closeout.blockers.filter(blocker => blocker !== 'verified_private_closeout_required');
      if (activeWork.length) lifecycleError('open_dot_employee_needs_reconciliation', 409);
    }

    const nextBindingRevision = currentRevision + 1;
    const marker = {
      version: VERSION,
      execution_backend: 'open-dot',
      state: 'bound',
      // This stage establishes registry ownership and UI routing only. The
      // cross-engine executor stays pending until a dedicated adapter exists.
      execution_state: 'pending',
      dot_id: proof.dotId,
      creation_key: creationKey,
      input_digest: current?.input_digest || createHash('sha256').update(JSON.stringify({
        id: row.id, name: row.name, persona: row.persona, role: row.roleArchetype,
        avatar_url: row.avatarUrl, appearance: row.policyRules?.appearance || null,
      })).digest('hex'),
      binding_revision: nextBindingRevision,
      bound_at: new Date(now).toISOString(),
    };
    const policyRules = { ...row.policyRules, open_dot_employee: marker };
    if (lifecycle?.phase === 'provisioning') {
      policyRules.native_lifecycle = { ...lifecycle, phase: 'active', revision: lifecycle.revision + 1,
        open_dot_bound_at: marker.bound_at };
    } else if (!lifecycle) {
      // Legacy DigitalEmployee rows have no native lifecycle seam for Runtime
      // onboarding/profile writes. Attach metadata only; keep their canonical
      // identity, appearance, tools, and connector grants untouched.
      const profileHash = createHash('sha256').update(JSON.stringify({
        id: row.id, name: row.name, persona: row.persona, role: row.roleArchetype,
        avatar_url: row.avatarUrl, appearance: row.policyRules?.appearance || null,
      })).digest('hex');
      policyRules.native_lifecycle = { version: VERSION, kind: 'durable', phase: 'active', revision: 1,
        profile_revision: 1, onboarding_required: true, profile_stage: 'responsibilities', expires_at: null,
        creation_hash: profileHash, created_by: row.createdBy, adopted_from_open_dot: true,
        open_dot_bound_at: marker.bound_at };
    }
    const employee = await tx.digitalEmployee.update({ where: { id: row.id }, data: { policyRules } });
    return { employee: publicEmployee(employee), replayed: false, scope: { organizationId: principal.orgId, userId: principal.userId },
      lifecycle: lifecycleSummary(employee),
      open_dot_employee: marker };
  });
}

export function validateOpenDotAdoptionRequest(input) {
  assertExactKeys(input, ['operation','employee_id','creation_key','expected_binding_revision']);
  if (input?.operation !== 'adopt') lifecycleError('invalid_open_dot_employee_operation', 400);
  return { operation: 'adopt', employee_id: input.employee_id,
    creation_key: text(input.creation_key, 'creation_key'),
    expected_binding_revision: input.expected_binding_revision };
}

