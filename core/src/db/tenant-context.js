/**
 * Transaction-local tenant context for the legacy Core RLS policies.
 *
 * The legacy policies on `memories`, `users`, `platform_integrations`,
 * `sessions`, `sync_logs` and `vector_embeddings` read
 * `current_setting('app.current_org_id', true)` and
 * `current_setting('app.current_user_id', true)`. These helpers set both with
 * `set_config(name, value, true)` as the first statement of a transaction, so
 * the values are discarded at COMMIT or ROLLBACK and can never reach the next
 * request that borrows the pooled connection. The session-level
 * `set_app_context()` function in schema.sql must not be used for this reason.
 *
 * Two naming conventions are set together. `app.current_*` is read by the
 * legacy schema.sql policies. `app.hivemind_org_id` / `app.hivemind_user_id` is
 * read by the harness/app-runtime policies and by the runner-role policies in
 * core/prisma/staged/20261024_core_rls_runner_tables, so one transaction-local
 * context satisfies both.
 *
 * Everything is gated by HIVEMIND_RLS_TENANT_CONTEXT (default off). With the
 * flag off, every helper calls `fn` with the client or pool it was given and
 * issues no statement, so existing behaviour is unchanged.
 *
 * Callers pass orgId/userId from the authenticated principal only, never from
 * a request body. A missing id is sent as '' which the policies read as unset
 * (NULLIF(..., '')), so it matches no tenant-owned row.
 *
 * Dependency-free on purpose: unit tests run without @prisma/client or pg.
 * Staged rollout: .hivemind/notes/core-rls-staging-runbook-20261024.md.
 */

export const TENANT_CONTEXT_FLAG = 'HIVEMIND_RLS_TENANT_CONTEXT';

/** Parameterized statement used on raw pg clients ($1 = org id, $2 = user id). */
export const TENANT_CONTEXT_SQL =
  "SELECT set_config('app.current_org_id', $1::text, true), set_config('app.current_user_id', $2::text, true), set_config('app.hivemind_org_id', $1::text, true), set_config('app.hivemind_user_id', $2::text, true)";

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean} true only when HIVEMIND_RLS_TENANT_CONTEXT is 'true' or '1'
 */
export function isTenantContextEnabled(env = process.env) {
  const value = env?.[TENANT_CONTEXT_FLAG];
  return value === 'true' || value === '1';
}

/**
 * @param {{orgId?: string|null, userId?: string|null}} [ctx]
 * @returns {[string, string]} org and user setting values; '' for a missing id
 */
export function tenantContextValues({ orgId, userId } = {}) {
  return [orgId ? String(orgId) : '', userId ? String(userId) : ''];
}

/**
 * Sets the transaction-local context on a Prisma transaction client.
 * Must be called inside `$transaction`; outside one, Postgres discards the
 * value at the end of the implicit single-statement transaction.
 *
 * @param {{$executeRaw: Function}} tx Prisma interactive-transaction client
 * @param {{orgId?: string|null, userId?: string|null}} ctx authenticated principal ids
 * @returns {Promise<void>}
 */
export async function applyPrismaTenantContext(tx, ctx) {
  const [org, user] = tenantContextValues(ctx);
  await tx.$executeRaw`SELECT set_config('app.current_org_id', ${org}::text, true), set_config('app.current_user_id', ${user}::text, true), set_config('app.hivemind_org_id', ${org}::text, true), set_config('app.hivemind_user_id', ${user}::text, true)`;
}

/**
 * Runs `fn` inside a Prisma interactive transaction whose first statement
 * sets the tenant context. With the flag off, runs `fn(prisma)` directly.
 *
 * @template T
 * @param {{$transaction: Function}} prisma Prisma client
 * @param {{orgId?: string|null, userId?: string|null}} ctx authenticated principal ids
 * @param {(db: any) => Promise<T>} fn work to run against the transaction client
 * @param {{env?: Record<string, string|undefined>, transactionOptions?: object}} [options]
 * @returns {Promise<T>} the value returned by `fn`
 */
export async function withTenant(prisma, ctx, fn, { env = process.env, transactionOptions } = {}) {
  if (!isTenantContextEnabled(env)) return fn(prisma);
  return prisma.$transaction(async (tx) => {
    await applyPrismaTenantContext(tx, ctx);
    return fn(tx);
  }, transactionOptions ?? defaultTransactionOptions(env));
}

/**
 * Sets the transaction-local context on a raw pg client that is already
 * inside BEGIN.
 *
 * @param {{query: Function}} client pg client
 * @param {{orgId?: string|null, userId?: string|null}} ctx authenticated principal ids
 * @returns {Promise<void>}
 */
export async function applyPgTenantContext(client, ctx) {
  await client.query(TENANT_CONTEXT_SQL, tenantContextValues(ctx));
}

/**
 * Runs `fn` on a dedicated pg connection inside BEGIN/COMMIT with the tenant
 * context set first. ROLLBACK on error; the connection is always released,
 * and destroyed if ROLLBACK itself fails. With the flag off, runs `fn(pool)`
 * directly so callers keep using `pool.query` unchanged.
 *
 * @template T
 * @param {{connect: Function}} pool pg Pool
 * @param {{orgId?: string|null, userId?: string|null}} ctx authenticated principal ids
 * @param {(db: any) => Promise<T>} fn work to run against the client
 * @param {{env?: Record<string, string|undefined>}} [options]
 * @returns {Promise<T>} the value returned by `fn`
 */
export async function withTenantPg(pool, ctx, fn, { env = process.env } = {}) {
  if (!isTenantContextEnabled(env)) return fn(pool);
  const client = await pool.connect();
  let releaseError;
  try {
    await client.query('BEGIN');
    await applyPgTenantContext(client, ctx);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // A failed ROLLBACK leaves the connection state unknown; release(err) destroys it instead of returning it to the pool.
      releaseError = rollbackError;
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

/**
 * Store-level entry point used by PrismaGraphStore.
 *
 * - flag off, no orgId, or a non-central org (`routable` false: .amr, remote
 *   agent or self-host customer Postgres): `fn(client)` unchanged;
 * - already inside a Prisma transaction: set the context on it, then `fn(client)`;
 * - otherwise: a dedicated `withTenant` transaction.
 *
 * @template T
 * @param {{client: any, inTransaction?: boolean, ctx: {orgId?: string|null, userId?: string|null}, routable?: boolean, env?: Record<string, string|undefined>}} scope
 * @param {(db: any) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function runTenantScoped({ client, inTransaction = false, ctx, routable = true, env = process.env }, fn) {
  if (!isTenantContextEnabled(env) || !ctx?.orgId || !routable) return fn(client);
  if (inTransaction) {
    await applyPrismaTenantContext(client, ctx);
    return fn(client);
  }
  return withTenant(client, ctx, fn, { env });
}

function defaultTransactionOptions(env) {
  const timeout = Number(env?.HIVEMIND_RLS_TX_TIMEOUT_MS);
  return { timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 30000 };
}
