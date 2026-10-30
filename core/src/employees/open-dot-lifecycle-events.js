/**
 * Signed employee lifecycle events from Core to OpenDot, which owns the employee's archive, pause and removal state, and a
 * removal notice to Runtime, which owns the employee's room session.
 *
 * OpenDot receives `POST /api/internal/hivemind/lifecycle` signed with its bridge scheme (OPEN_DOT_LIFECYCLE_EVENT_URL and
 * OPEN_DOT_LIFECYCLE_EVENT_SECRET); without both, nothing is sent and OpenDot keeps reading Control as before. An archive or
 * unarchive is held in `policyRules.open_dot_lifecycle_event` until OpenDot acknowledges it and is retried on Control's
 * maintenance tick; events are idempotent by event id and ordered by `at`, so a duplicate or late delivery is harmless. A removal
 * has no employee row left to hold a marker, so it is retried in the process. None of this delays the administrator's request.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { lifecycleCallbackToken } from './native-lifecycle-bridge.js';

export const EVENT_KEY = 'open_dot_lifecycle_event';
const OPEN_DOT_PATH = '/api/internal/hivemind/lifecycle';
const RUNTIME_REMOVED_PATH = '/internal/hivemind/employee-removed';
const RUNTIME_LIFECYCLE_PATH = '/internal/hivemind/employee-lifecycle';
/** Delays before in-process retries of a removal notice. */
export const REMOVAL_NOTICE_DELAYS_MS = Object.freeze([5_000, 30_000, 120_000, 600_000]);
const TYPE_BY_OPERATION = Object.freeze({ pause_archive: 'archived', archive: 'archived', fresh_reset_archive: 'archived', unarchive: 'unarchived', remove: 'removed' });

/** OpenDot event endpoint and signing secret from the environment, or null when unconfigured or malformed. */
export function openDotLifecycleTarget(env = process.env) {
  let url; try { url = new URL(env.OPEN_DOT_LIFECYCLE_EVENT_URL); } catch { return null; }
  const secret = env.OPEN_DOT_LIFECYCLE_EVENT_SECRET;
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== OPEN_DOT_PATH
    || !secret || Buffer.byteLength(secret) < 32) return null;
  return { url, secret };
}

/** Request headers for one OpenDot bridge request; sign every attempt separately, the receiver refuses a reused nonce. */
export function signOpenDotRequest(secret, { method, path, body }, now = Date.now(), nonce = randomUUID()) {
  const timestamp = String(Math.floor(now / 1000));
  const canonical = [method.toUpperCase(), path, timestamp, nonce, createHash('sha256').update(body).digest('hex')].join('\n');
  return { 'x-hivemind-bridge-signature': createHmac('sha256', secret).update(canonical).digest('hex'),
    'x-hivemind-bridge-timestamp': timestamp, 'x-hivemind-bridge-nonce': nonce };
}

const isOpenDotBound = employee => {
  const marker = employee?.policyRules?.open_dot_employee;
  return marker?.version === 1 && marker.execution_backend === 'open-dot' && marker.state === 'bound' && typeof marker.dot_id === 'string' && marker.dot_id !== '';
};

/**
 * The event for one lifecycle operation on an OpenDot-bound employee, or null when OpenDot is not involved.
 * The event id is derived from the employee, type and lifecycle revision, so a replayed operation yields the same event.
 * `at` is the time the change was recorded (a removal uses `now`).
 */
export function lifecycleEventFor({ operation, employee, orgId, now = Date.now() }) {
  const type = TYPE_BY_OPERATION[operation];
  if (!type || !employee?.id || !isOpenDotBound(employee) || typeof employee.createdBy !== 'string') return null;
  const lifecycle = employee.policyRules?.native_lifecycle ?? {};
  const stamp = type === 'unarchived' ? lifecycle.unarchived_at : type === 'archived' ? (lifecycle.archive?.archived_at ?? lifecycle.archived_at) : undefined;
  const parsed = typeof stamp === 'string' ? Date.parse(stamp) : NaN;
  const at = Number.isFinite(parsed) ? parsed : now;
  const revision = Number.isSafeInteger(lifecycle.revision) ? lifecycle.revision : 0;
  return { eventId: createHash('sha256').update(`${employee.id}:${type}:${revision}`).digest('hex').slice(0, 40), type,
    organizationId: orgId ?? employee.orgId, userId: employee.createdBy, employeeId: employee.id, at };
}

/** One signed delivery to OpenDot; never throws. Returns `delivered`, `skipped` (not configured) or `pending`. */
export async function deliverOpenDotLifecycleEvent(event, { env = process.env, fetchImpl = fetch } = {}) {
  const target = openDotLifecycleTarget(env);
  if (!target) return { status: 'skipped', reason: 'open_dot_lifecycle_unconfigured' };
  const body = JSON.stringify({ eventId: event.eventId, type: event.type, organizationId: event.organizationId, userId: event.userId, employeeId: event.employeeId, at: event.at });
  try {
    const response = await fetchImpl(target.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { 'content-type': 'application/json', ...signOpenDotRequest(target.secret, { method: 'POST', path: target.url.pathname + target.url.search, body }) }, body });
    const raw = await response.text();
    if (raw.length > 8000) throw Error('oversized');
    const result = JSON.parse(raw);
    return response.ok && result?.received === true ? { status: 'delivered', applied: result.applied === true } : { status: 'pending', reason: 'open_dot_lifecycle_unconfirmed' };
  } catch { return { status: 'pending', reason: 'open_dot_lifecycle_unreachable' }; }
}

/** Runtime's removal notice endpoint beside the lifecycle callback URL, or null when that callback is not configured. */
export function runtimeRemovalTarget(env = process.env) {
  let url; try { url = new URL(env.HIVEMIND_EMPLOYEE_LIFECYCLE_URL); } catch { return null; }
  const secret = env.HIVE_HARNESS_RUNNER_SERVICE_SECRET;
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== RUNTIME_LIFECYCLE_PATH
    || !secret || Buffer.byteLength(secret) < 32) return null;
  url.pathname = RUNTIME_REMOVED_PATH;
  return { url, secret };
}

/** One signed removal notice to Runtime, which releases and deletes the employee's room session; never throws. */
export async function notifyRuntimeEmployeeRemoved({ orgId, userId, employeeId }, { env = process.env, fetchImpl = fetch } = {}) {
  const target = runtimeRemovalTarget(env);
  if (!target) return { status: 'skipped', reason: 'runtime_removal_unconfigured' };
  const payload = { orgId, userId, employeeId };
  try {
    const response = await fetchImpl(target.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${lifecycleCallbackToken(payload, target.secret, Date.now(), 'hivemind-employee-removed')}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload) });
    const raw = await response.text();
    if (raw.length > 8000) throw Error('oversized');
    const result = JSON.parse(raw);
    return response.ok && result?.status === 'removed' && result.employeeId === employeeId ? { status: 'delivered' } : { status: 'pending', reason: 'runtime_removal_unconfirmed' };
  } catch { return { status: 'pending', reason: 'runtime_removal_unreachable' }; }
}

/** Runs `attempt` now and, while it stays pending, again on `delays`. Returns the first result. */
export async function withRetries(attempt, { delays = REMOVAL_NOTICE_DELAYS_MS, schedule = setTimeout, log = console.warn, label = 'lifecycle-notice' } = {}) {
  const first = await attempt();
  if (first.status !== 'pending') return first;
  const again = index => {
    if (index >= delays.length) { log(`[${label}] still pending after retries`, { reason: first.reason }); return; }
    const timer = schedule(async () => { if ((await attempt()).status === 'pending') again(index + 1); }, delays[index]);
    timer?.unref?.();
  };
  again(0);
  return first;
}

async function lockedEmployee(db, id, work) {
  return db.$transaction(async tx => {
    const initial = await tx.digitalEmployee.findUnique({ where: { id } });
    if (!initial) return work(tx, null);
    await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text AS lock', `${initial.orgId}:${id}`);
    return work(tx, await tx.digitalEmployee.findUnique({ where: { id } }));
  });
}

/**
 * Called after a lifecycle operation succeeded; the caller does not wait for it. Archive and unarchive are recorded on the employee,
 * then delivered to OpenDot; a removal is delivered to OpenDot and to Runtime with in-process retries.
 */
export async function announceEmployeeLifecycle(db, principal, operation, result, deps = {}) {
  const { deliver = deliverOpenDotLifecycleEvent, notifyRuntime = notifyRuntimeEmployeeRemoved, retries = withRetries, now = Date.now() } = deps;
  const employee = result?.employee;
  if (!employee?.id || !TYPE_BY_OPERATION[operation]) return { status: 'ignored' };
  const event = lifecycleEventFor({ operation, employee, orgId: principal.orgId, now });
  if (operation === 'remove') {
    // The room belongs to the person who owns the OpenDot room, which is the creator of a bound employee.
    const owner = typeof employee.createdBy === 'string' ? employee.createdBy : principal.userId;
    if (isOpenDotBound(employee)) await retries(() => notifyRuntime({ orgId: principal.orgId, userId: owner, employeeId: employee.id }, deps), { label: 'runtime-removal' });
    return event ? retries(() => deliver(event, deps), { label: 'open-dot-lifecycle' }) : { status: 'ignored' };
  }
  if (!event || result.replayed === true && !employee.policyRules?.[EVENT_KEY]) return { status: 'ignored' };
  if (!openDotLifecycleTarget(deps.env ?? process.env)) return { status: 'skipped' };
  await lockedEmployee(db, employee.id, async (tx, row) => {
    if (!row) return;
    await tx.digitalEmployee.update({ where: { id: row.id }, data: { policyRules: { ...row.policyRules, [EVENT_KEY]: { version: 1, ...event, state: 'pending', attempts: 0, next_attempt_at: 0 } } } });
  });
  return settleEvent(db, employee.id, event, deliver, deps, now);
}

async function settleEvent(db, employeeId, event, deliver, deps, now) {
  const outcome = await deliver(event, deps);
  await lockedEmployee(db, employeeId, async (tx, row) => {
    const marker = row?.policyRules?.[EVENT_KEY];
    // A newer lifecycle change replaced this marker; leave it alone.
    if (!row || marker?.eventId !== event.eventId) return;
    const attempts = Math.min((marker.attempts ?? 0) + 1, 32);
    const next = outcome.status === 'pending' ? { ...marker, state: 'pending', attempts, next_attempt_at: now + Math.min(300_000, 1000 * 2 ** Math.min(attempts, 8)) }
      : { ...marker, state: 'delivered', attempts, next_attempt_at: 0, delivered_at: now };
    await tx.digitalEmployee.update({ where: { id: row.id }, data: { policyRules: { ...row.policyRules, [EVENT_KEY]: next } } });
  });
  return outcome;
}

/** Retries pending archive and unarchive events on Control's maintenance tick; bounded work per tick. */
export async function recoverPendingLifecycleEvents(db, { limit = 4, now = () => Date.now(), deliver = deliverOpenDotLifecycleEvent, env = process.env, fetchImpl } = {}) {
  if (!openDotLifecycleTarget(env)) return { attempted: 0, delivered: 0 };
  const at = now();
  const rows = await db.$queryRawUnsafe(`SELECT id FROM "hivemind"."digital_employees" e
    WHERE e.policy_rules->'${EVENT_KEY}'->>'state'='pending'
      AND CASE WHEN e.policy_rules->'${EVENT_KEY}'->>'next_attempt_at' ~ '^[0-9]{1,16}$' THEN (e.policy_rules->'${EVENT_KEY}'->>'next_attempt_at')::numeric ELSE 0 END <= $2
    ORDER BY e.updated_at ASC LIMIT $1`, limit, at);
  let delivered = 0;
  for (const { id } of rows) {
    const row = await db.digitalEmployee.findUnique({ where: { id } });
    const marker = row?.policyRules?.[EVENT_KEY];
    if (!marker || marker.state !== 'pending') continue;
    const event = { eventId: marker.eventId, type: marker.type, organizationId: marker.organizationId, userId: marker.userId, employeeId: marker.employeeId, at: marker.at };
    const outcome = await settleEvent(db, id, event, e => deliver(e, { env, ...(fetchImpl ? { fetchImpl } : {}) }), {}, at);
    if (outcome.status === 'delivered') delivered++;
  }
  return { attempted: rows.length, delivered };
}
