import pg from 'pg';
import { AppRuntimeError } from './contract.js';
import { createPostgresAppRuntimeTransactionRunner } from './postgres-transaction.js';

let pool;
let runner;

/** Lazily bounded CRM pool; disabled environments open no CRM connections.
 * Use a restricted credential for the same database containing platform identity.
 */
export function getAppRuntimeTransactionRunner(env = process.env) {
  if (runner) return runner;
  const connectionString = env.HIVE_APP_RUNTIME_DATABASE_URL || env.DATABASE_URL;
  if (!connectionString) throw new AppRuntimeError('unavailable', 'CRM database is not configured');
  let parsed;
  try { parsed = new URL(connectionString); }
  catch { throw new AppRuntimeError('unavailable', 'CRM database configuration is invalid'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new AppRuntimeError('unavailable', 'CRM requires PostgreSQL');
  }
  pool = new pg.Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
    query_timeout: 25000,
    allowExitOnIdle: true,
    application_name: 'hivemind-crm',
  });
  pool.on('error', () => console.warn('[CRM] idle database connection failed'));
  runner = createPostgresAppRuntimeTransactionRunner(pool);
  return runner;
}
