/**
 * Postgres advisory lock for governance agents.
 *
 * Prevents two hm-core instances from running the same agent for the same
 * org concurrently. Lock key is derived from (orgId, agentName) via hashtext
 * so it fits the 64-bit signed int that pg_try_advisory_lock requires.
 *
 * Session-scoped — released when the Prisma connection is returned to pool
 * or on explicit release(). For long agent runs the holder must keep the
 * same Prisma session active; we use $transaction with a 30-minute timeout
 * for that reason.
 */

import { randomUUID } from 'node:crypto';

const LOCK_NAMESPACE = 0x6776; // 'gv' — disambiguates from other advisory lock users.

function clampInt32(value) {
  // pg_try_advisory_lock(int, int) takes two int4 args. hashtext returns int4
  // already, so just normalize sign.
  return value | 0;
}

/**
 * Try to acquire a session-scoped advisory lock.
 * Resolves to { acquired: boolean, releaseKey?: string, key1, key2 }.
 *
 * IMPORTANT: caller MUST call release(prisma, releaseKey) when done, or wrap
 * in a transaction (the lock is released when the session ends).
 */
export async function tryAcquireGovernanceLock(prisma, { orgId, agentName }) {
  if (!prisma || !orgId || !agentName) {
    return { acquired: false, reason: 'missing_args' };
  }
  const key1 = LOCK_NAMESPACE;
  // Postgres hashtext(text) -> int4. We hash org+agent for collision safety.
  const rows = await prisma.$queryRawUnsafe(
    'SELECT hashtext($1::text) AS h',
    `${orgId}:${agentName}`
  );
  const key2 = clampInt32(rows?.[0]?.h ?? 0);

  const lockRows = await prisma.$queryRawUnsafe(
    'SELECT pg_try_advisory_lock($1::int, $2::int) AS got',
    key1,
    key2
  );
  const got = lockRows?.[0]?.got === true;
  if (!got) {
    return { acquired: false, key1, key2, reason: 'busy' };
  }
  return {
    acquired: true,
    key1,
    key2,
    releaseKey: randomUUID(),
  };
}

export async function releaseGovernanceLock(prisma, { key1, key2 }) {
  if (!prisma || key1 == null || key2 == null) return false;
  try {
    const rows = await prisma.$queryRawUnsafe(
      'SELECT pg_advisory_unlock($1::int, $2::int) AS released',
      key1,
      key2
    );
    return rows?.[0]?.released === true;
  } catch {
    return false;
  }
}

/**
 * High-level wrapper: acquire lock, run fn, release lock.
 * Throws { code: 'GOVERNANCE_LOCK_BUSY' } if another instance holds it.
 */
export async function withGovernanceLock(prisma, { orgId, agentName }, fn) {
  const lock = await tryAcquireGovernanceLock(prisma, { orgId, agentName });
  if (!lock.acquired) {
    const err = new Error(`Governance lock busy for ${agentName}@${orgId}`);
    err.code = 'GOVERNANCE_LOCK_BUSY';
    throw err;
  }
  try {
    return await fn();
  } finally {
    await releaseGovernanceLock(prisma, lock);
  }
}
