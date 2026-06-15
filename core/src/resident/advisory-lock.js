/**
 * Postgres advisory lock for governance agents.
 *
 * Prevents two hm-core instances from running the same agent for the same
 * org concurrently. Lock key is derived from (orgId, agentName) via hashtext
 * so it fits the 64-bit signed int that pg_try_advisory_lock requires.
 *
 * Transaction-scoped (pg_try_advisory_xact_lock) — released AUTOMATICALLY by
 * Postgres on COMMIT/ROLLBACK. Callers MUST pass an interactive-transaction
 * client (`$transaction(async (tx) => ...)`); the lock lives for that tx only.
 * This removes the session-lock leak (swallowed unlock errors / pooled-conn
 * mismatch left a connection parked holding the lock forever).
 */

const LOCK_NAMESPACE = 0x6776; // 'gv' — disambiguates from other advisory lock users.

function clampInt32(value) {
  // pg_try_advisory_lock(int, int) takes two int4 args. hashtext returns int4
  // already, so just normalize sign.
  return value | 0;
}

/**
 * Try to acquire a TRANSACTION-scoped advisory lock.
 * Resolves to { acquired: boolean, key1, key2 }.
 *
 * H5 fix: this uses pg_try_advisory_xact_lock (NOT pg_try_advisory_lock).
 * Transaction-scoped locks are released AUTOMATICALLY by Postgres on COMMIT or
 * ROLLBACK — there is no manual unlock and therefore no leak path. The previous
 * session-scoped lock leaked two ways: (1) pg_advisory_unlock errors were
 * swallowed and the connection returned to the pool still holding the lock, and
 * (2) on a pooled client the unlock could target a DIFFERENT physical connection
 * than the one that acquired it, so it never actually released. xact locks fix
 * both — but REQUIRE the `prisma` arg to be an interactive-transaction client
 * (`$transaction(async (tx) => ...)`); the lock lives only for that tx.
 */
export async function tryAcquireGovernanceLock(tx, { orgId, agentName }) {
  if (!tx || !orgId || !agentName) {
    return { acquired: false, reason: 'missing_args' };
  }
  const key1 = LOCK_NAMESPACE;
  // Postgres hashtext(text) -> int4. We hash org+agent for collision safety.
  const rows = await tx.$queryRawUnsafe(
    'SELECT hashtext($1::text) AS h',
    `${orgId}:${agentName}`
  );
  const key2 = clampInt32(rows?.[0]?.h ?? 0);

  const lockRows = await tx.$queryRawUnsafe(
    'SELECT pg_try_advisory_xact_lock($1::int, $2::int) AS got',
    key1,
    key2
  );
  const got = lockRows?.[0]?.got === true;
  if (!got) {
    return { acquired: false, key1, key2, reason: 'busy' };
  }
  return { acquired: true, key1, key2 };
}

/**
 * No-op for transaction-scoped locks (kept for call-site compatibility).
 * pg_try_advisory_xact_lock auto-releases on COMMIT/ROLLBACK, so there is
 * nothing to unlock. Returns true.
 */
export async function releaseGovernanceLock(/* tx, lock */) {
  return true;
}

/**
 * High-level wrapper: acquire a transaction-scoped lock, run fn.
 * MUST be called with an interactive-transaction client (tx) so the xact lock
 * is bound to — and auto-released with — that transaction.
 * Throws { code: 'GOVERNANCE_LOCK_BUSY' } if another instance holds it.
 */
export async function withGovernanceLock(tx, { orgId, agentName }, fn) {
  if (tx && typeof tx.$transaction === 'function') {
    // A non-transaction client was passed — the xact lock would be acquired on
    // a pooled connection and released immediately (next statement runs on a
    // possibly different connection), giving NO mutual exclusion. Fail loud
    // rather than silently providing a useless lock.
    throw new Error('withGovernanceLock requires an interactive-transaction client (tx), not a pooled PrismaClient');
  }
  const lock = await tryAcquireGovernanceLock(tx, { orgId, agentName });
  if (!lock.acquired) {
    const err = new Error(`Governance lock busy for ${agentName}@${orgId}`);
    err.code = 'GOVERNANCE_LOCK_BUSY';
    throw err;
  }
  // No release needed — xact lock drops when the surrounding $transaction ends.
  return await fn();
}
