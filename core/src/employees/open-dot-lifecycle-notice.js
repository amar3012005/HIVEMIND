/**
 * Signed lifecycle notices from OpenDot to Core. OpenDot owns the deletion of its employees: it removes the Dot, its conversations and
 * its files first, then tells Core so the registry row goes and Runtime releases the room. This is the reverse direction of the signed
 * events in `open-dot-lifecycle-events.js` and uses the same scheme and the same secret (OPEN_DOT_LIFECYCLE_EVENT_SECRET):
 * `POST /v1/service/open-dot/lifecycle-notice` with the headers `x-hivemind-bridge-signature` (hex HMAC-SHA256 of
 * `METHOD\npath\ntimestamp\nnonce\nsha256hex(body)`), `x-hivemind-bridge-timestamp` (unix seconds, within 60 s) and
 * `x-hivemind-bridge-nonce` (a UUID used once). The body is `{"eventId","type":"removed","organizationId","userId","employeeId","at"}`.
 *
 * The notice carries no user session, so OpenDot can repeat it until Core confirms. Core accepts it only for an employee that carries
 * an OpenDot marker, in the stated organization and created by the stated user; an employee Core no longer has is already removed.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { announceEmployeeLifecycle } from './open-dot-lifecycle-events.js';

export const NOTICE_PATH = '/v1/service/open-dot/lifecycle-notice';
export const NOTICE_WINDOW_SECONDS = 60;
const NOTICE_NONCE_CAPACITY = 100_000;
const MAX_BODY_BYTES = 4096;
const ID = /^[A-Za-z0-9_-]{1,200}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SIGNATURE = /^[0-9a-f]{64}$/;
const TIMESTAMP = /^[1-9][0-9]{0,11}$/;

/** A refused notice with the HTTP status to answer. */
export class LifecycleNoticeError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

/** Nonces seen inside the signature window, bounded by count. A full memory refuses new notices instead of forgetting live nonces. */
export class NoticeNonceCache {
  #expiry = new Map();
  constructor(capacity = NOTICE_NONCE_CAPACITY) { this.capacity = capacity; }
  claim(nonce, expiresAt, now) {
    const held = this.#expiry.get(nonce);
    if (held !== undefined && held >= now) return 'replayed';
    if (held === undefined && this.#expiry.size >= this.capacity) {
      for (const [key, expiry] of this.#expiry) if (expiry < now) this.#expiry.delete(key);
      if (this.#expiry.size >= this.capacity) return 'full';
    }
    this.#expiry.set(nonce, expiresAt);
    return 'claimed';
  }
}
const processNonces = new NoticeNonceCache();

/** The shared secret, or null when the channel is unconfigured (a notice is then refused with 503). */
export function noticeSecret(env = process.env) {
  const secret = env.OPEN_DOT_LIFECYCLE_EVENT_SECRET;
  return secret && Buffer.byteLength(secret) >= 32 ? secret : null;
}

/**
 * Checks the signature of one notice against its exact body bytes and claims its nonce.
 * @returns 'verified', 'rejected' (bad or stale signature, reused nonce) or 'unavailable' (nonce memory full).
 */
export function verifyNoticeSignature(secret, { method, path, headers, body }, now = Date.now(), nonces = processNonces) {
  const signature = headers['x-hivemind-bridge-signature'], timestamp = headers['x-hivemind-bridge-timestamp'], nonce = headers['x-hivemind-bridge-nonce'];
  if (!SIGNATURE.test(signature || '') || !TIMESTAMP.test(timestamp || '') || !NONCE.test(nonce || '')) return 'rejected';
  const seconds = Number(timestamp);
  if (Math.abs(Math.floor(now / 1000) - seconds) > NOTICE_WINDOW_SECONDS) return 'rejected';
  const canonical = [method.toUpperCase(), path, timestamp, nonce, createHash('sha256').update(body).digest('hex')].join('\n');
  const expected = createHmac('sha256', secret).update(canonical).digest();
  const provided = Buffer.from(signature, 'hex');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return 'rejected';
  const claim = nonces.claim(nonce, (seconds + NOTICE_WINDOW_SECONDS + 1) * 1000, now);
  return claim === 'claimed' ? 'verified' : claim === 'full' ? 'unavailable' : 'rejected';
}

/** Parses a verified notice body; throws {@link LifecycleNoticeError} 400 when it is not exactly a removal notice. */
export function parseNotice(body) {
  if (body.byteLength > MAX_BODY_BYTES) throw new LifecycleNoticeError('lifecycle_notice_too_large', 413);
  let value;
  try { value = JSON.parse(body.toString('utf8')); } catch { throw new LifecycleNoticeError('invalid_lifecycle_notice', 400); }
  const { eventId, type, organizationId, userId, employeeId, at } = value && typeof value === 'object' ? value : {};
  if (typeof eventId !== 'string' || !ID.test(eventId) || type !== 'removed' || typeof organizationId !== 'string' || !ID.test(organizationId)
    || typeof userId !== 'string' || !ID.test(userId) || typeof employeeId !== 'string' || !UUID.test(employeeId) || !Number.isSafeInteger(at) || at < 1) {
    throw new LifecycleNoticeError('invalid_lifecycle_notice', 400);
  }
  return Object.freeze({ eventId, type, organizationId, userId, employeeId, at });
}

/**
 * Applies a removal notice: deletes the employee row and tells Runtime and OpenDot in the background, as an administrator's removal does.
 * Idempotent: an employee that is already gone answers `applied: false`. An employee that is not an OpenDot employee of this user is refused
 * with 409, so a signed notice can never remove another person's or a native employee.
 * @returns `{ received: true, applied }`.
 */
export async function applyLifecycleNotice(db, notice, { announce = announceEmployeeLifecycle } = {}) {
  const principal = { orgId: notice.organizationId, userId: notice.userId };
  const removed = await db.$transaction(async tx => {
    await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text AS lock', `${principal.orgId}:${notice.employeeId}`);
    const row = await tx.digitalEmployee.findFirst({ where: { id: notice.employeeId, orgId: principal.orgId } });
    if (!row) return null;
    if (!row.policyRules?.open_dot_employee || row.createdBy !== principal.userId) throw new LifecycleNoticeError('employee_not_open_dot_owner', 409);
    await tx.digitalEmployee.delete({ where: { id: row.id } });
    return row;
  });
  if (!removed) return { received: true, applied: false };
  // The caller does not wait for the announcement; Runtime and OpenDot treat a repeat as a no-op.
  Promise.resolve(announce(db, principal, 'remove', { employee: removed, removed: true })).catch(() => console.warn('[open-dot-lifecycle] removal announcement unavailable'));
  return { received: true, applied: true };
}
