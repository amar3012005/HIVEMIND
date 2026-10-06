import { AppRuntimeError } from './contract.js';

/** Fixed service SQL runs on one checked-out pg connection per transaction.
 * The store sets transaction-local tenant scope and checks live membership.
 */
export function createPostgresAppRuntimeTransactionRunner(pool) {
  if (typeof pool?.connect !== 'function') throw new TypeError('PostgreSQL pool required');
  return async (_principal, execute) => {
    const client = await pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '20s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '20s'");
      const { rows: [role] } = await client.query(
        'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user',
      );
      if (!role || role.rolsuper || role.rolbypassrls) {
        throw new AppRuntimeError('unavailable', 'CRM requires a database role that cannot bypass row-level security');
      }
      const result = await execute(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { discard = true; }
      throw error;
    } finally { client.release(discard); }
  };
}
