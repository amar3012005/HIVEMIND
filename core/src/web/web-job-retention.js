/**
 * Web Intelligence job retention.
 *
 * Finished jobs (`succeeded` / `failed`) keep their accounting columns forever
 * (id, org, user, type, status, timestamps, pages_processed, duration_ms,
 * runtime_used, error_*, `request`). After the retention window the heavy jsonb
 * outputs (`result`, `progress`, `provider_attempts`) are trimmed. A job whose
 * results were saved to memory keeps a pointer to the memory ids instead, so the
 * saved copy stays reachable from the job. Usage settlements live in their own
 * table and never read these columns.
 *
 * Each run updates a bounded number of rows, in short batches that skip rows
 * locked by a live writer, so there are no long locks and a retry job is safe.
 */

const SCHEMA_TABLE = 'hivemind.web_intel_jobs';
const DAY_MS = 86_400_000;

/** Rows whose heavy columns are already below this many bytes are treated as trimmed. */
export const TRIMMED_BYTES_FLOOR = 1024;
/** Maximum memory ids kept in a pointer, so a pointer stays under TRIMMED_BYTES_FLOOR. */
export const MAX_POINTER_MEMORY_IDS = 10;

const HEAVY_BYTES = 'COALESCE(pg_column_size(result),0) + pg_column_size(progress) + pg_column_size(provider_attempts)';

function positiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= min ? Math.min(n, max) : fallback;
}

/** Reads retention settings from the environment; `HIVEMIND_WEB_JOB_RETENTION_DAYS=0` disables the job. */
export function readRetentionConfig(env = process.env) {
  const rawDays = env.HIVEMIND_WEB_JOB_RETENTION_DAYS;
  const disabled = rawDays !== undefined && rawDays !== '' && Number(rawDays) === 0;
  return {
    enabled: !disabled && String(env.HIVEMIND_WEB_JOB_RETENTION_ENABLED ?? 'true').toLowerCase() !== 'false',
    retentionDays: positiveInt(rawDays, 30, { min: 1, max: 3650 }),
    batchSize: positiveInt(env.HIVEMIND_WEB_JOB_RETENTION_BATCH, 25, { max: 500 }),
    maxBatches: positiveInt(env.HIVEMIND_WEB_JOB_RETENTION_MAX_BATCHES, 8, { max: 100 }),
    intervalMs: positiveInt(env.HIVEMIND_WEB_JOB_RETENTION_INTERVAL_MS, 6 * 3600_000, { min: 60_000 }),
    initialDelayMs: positiveInt(env.HIVEMIND_WEB_JOB_RETENTION_INITIAL_DELAY_MS, 5 * 60_000, { min: 1000 }),
  };
}

const CANDIDATES_SQL = `
  SELECT id, ${HEAVY_BYTES} AS heavy_bytes
  FROM ${SCHEMA_TABLE}
  WHERE status IN ('succeeded', 'failed')
    AND COALESCE(completed_at, updated_at) < $1::timestamptz
    AND ${HEAVY_BYTES} > ${TRIMMED_BYTES_FLOOR}`;

/** SELECT used by both the dry run and the trim: counts candidate rows and the bytes they hold. */
export const DRY_RUN_SQL = `
  SELECT status, COUNT(*)::int AS rows, COALESCE(SUM(heavy_bytes), 0)::bigint AS bytes
  FROM (SELECT status, ${HEAVY_BYTES} AS heavy_bytes FROM ${SCHEMA_TABLE}
        WHERE status IN ('succeeded', 'failed')
          AND COALESCE(completed_at, updated_at) < $1::timestamptz
          AND ${HEAVY_BYTES} > ${TRIMMED_BYTES_FLOOR}) t
  GROUP BY status`;

// `updated_at` is deliberately untouched so trimming never reorders job lists.
// The pointer is an array so clients that iterate `results` keep working.
export const TRIM_BATCH_SQL = `
  WITH picked AS (
    ${CANDIDATES_SQL}
    ORDER BY COALESCE(completed_at, updated_at) ASC
    LIMIT $2
    FOR UPDATE SKIP LOCKED
  )
  UPDATE ${SCHEMA_TABLE} j
  SET result = CASE
        WHEN j.status = 'succeeded' AND jsonb_typeof(j.request -> 'saved_memory_ids') = 'array'
          THEN jsonb_build_array(jsonb_build_object(
            'retention', 'trimmed',
            'saved_to', 'memory',
            'memory_ids', j.request -> 'saved_memory_ids'))
        WHEN j.status = 'succeeded' THEN '[]'::jsonb
        ELSE NULL END,
      progress = '[]'::jsonb,
      provider_attempts = '[]'::jsonb
  FROM picked
  WHERE j.id = picked.id
  RETURNING picked.heavy_bytes AS before_bytes,
            (COALESCE(pg_column_size(j.result),0) + pg_column_size(j.progress) + pg_column_size(j.provider_attempts)) AS after_bytes`;

/**
 * Counts what a run would trim without writing.
 * @param {{ $queryRawUnsafe: Function }} prisma
 * @param {{ retentionDays?: number, now?: Date }} [options]
 * @returns {Promise<{ cutoff: string, rows: number, bytes: number, byStatus: Record<string, { rows: number, bytes: number }> }>}
 */
export async function dryRunWebIntelRetention(prisma, { retentionDays = 30, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  const found = await prisma.$queryRawUnsafe(DRY_RUN_SQL, cutoff);
  const byStatus = {};
  let rows = 0; let bytes = 0;
  for (const row of found) {
    byStatus[row.status] = { rows: Number(row.rows), bytes: Number(row.bytes) };
    rows += Number(row.rows); bytes += Number(row.bytes);
  }
  return { cutoff: cutoff.toISOString(), rows, bytes, byStatus };
}

/**
 * Trims finished jobs older than the retention window, at most `batchSize * maxBatches` rows per call.
 * @returns {Promise<{ trimmed: number, bytesFreed: number, batches: number, cutoff: string, durationMs: number, more: boolean }>}
 */
export async function trimWebIntelJobs(prisma, options = {}) {
  const cfg = { ...readRetentionConfig(), ...options };
  const now = options.now || new Date();
  const cutoff = new Date(now.getTime() - cfg.retentionDays * DAY_MS);
  const started = Date.now();
  let trimmed = 0; let bytesFreed = 0; let batches = 0; let more = false;
  for (; batches < cfg.maxBatches;) {
    const rows = await prisma.$queryRawUnsafe(TRIM_BATCH_SQL, cutoff, cfg.batchSize);
    batches += 1;
    for (const row of rows) {
      trimmed += 1;
      bytesFreed += Math.max(0, Number(row.before_bytes) - Number(row.after_bytes));
    }
    if (rows.length < cfg.batchSize) break;
    if (batches === cfg.maxBatches) more = true;
  }
  return { trimmed, bytesFreed, batches, cutoff: cutoff.toISOString(), durationMs: Date.now() - started, more };
}

/** Formats the one-line run summary. */
export function formatRetentionSummary(r, retentionDays) {
  return `[web-intel-retention] trimmed=${r.trimmed} freed_bytes=${r.bytesFreed} batches=${r.batches} `
    + `retention_days=${retentionDays} cutoff=${r.cutoff} more=${r.more} duration_ms=${r.durationMs}`;
}

/**
 * Starts the recurring retention job. One run at a time per process; ticks never overlap.
 * @returns {{ stop: () => void, runOnce: () => Promise<object|null> } | null} `null` when disabled or no database.
 */
export function startWebIntelRetentionScheduler({ prisma, logger = console, env = process.env } = {}) {
  const cfg = readRetentionConfig(env);
  if (!prisma || !cfg.enabled) return null;
  let busy = false;
  const runOnce = async () => {
    if (busy) return null;
    busy = true;
    try {
      const result = await trimWebIntelJobs(prisma, cfg);
      logger.log(formatRetentionSummary(result, cfg.retentionDays));
      return result;
    } catch (error) {
      logger.warn(`[web-intel-retention] run failed: ${String(error?.message || error).slice(0, 160)}`);
      return null;
    } finally { busy = false; }
  };
  const interval = setInterval(runOnce, cfg.intervalMs); interval.unref?.();
  const first = setTimeout(runOnce, cfg.initialDelayMs); first.unref?.();
  return { runOnce, stop: () => { clearInterval(interval); clearTimeout(first); } };
}
