# Web Intelligence job retention

`core/src/web/web-job-retention.js` trims the heavy jsonb of finished `hivemind.web_intel_jobs` rows. In production, 265 succeeded rows held about 216 MB in `result`, `progress` and `provider_attempts` (up to 1.6 MB per row), which caused the Core out-of-memory crash fixed in #772.

## Behavior

- Eligible rows: `status IN ('succeeded','failed')`, `COALESCE(completed_at, updated_at)` older than the retention window, and more than 1 KiB in the three heavy columns. Queued and running jobs are never touched.
- Trimmed: `result`, `progress`, `provider_attempts`. A succeeded job gets `result = []` (array-safe for clients that iterate results), a failed job gets `NULL`; the other two become `[]`.
- Kept: id, org, user, type, status, `request` (so retry still works), timestamps (`updated_at` is not changed, so list order is stable), `pages_processed`, `duration_ms`, `runtime_used`, `error_*`. Usage reads (`ACCOUNTING_SELECT`, `LIST_SELECT`) and `web_intel_usage_settlements` never use the trimmed columns.
- Saved results: `POST /api/web/jobs/:id/save-to-memory` records up to 10 memory ids in `request.saved_memory_ids`. A trimmed saved job keeps `result = [{retention:'trimmed', saved_to:'memory', memory_ids:[...]}]`; the content lives in the memories.
- Batching: each batch picks up to `HIVEMIND_WEB_JOB_RETENTION_BATCH` rows with `FOR UPDATE SKIP LOCKED` in a single short statement; at most `HIVEMIND_WEB_JOB_RETENTION_MAX_BATCHES` batches per run. A backlog drains over several runs.
- Log: one line per run, `[web-intel-retention] trimmed=N freed_bytes=B batches=K retention_days=D cutoff=... more=bool duration_ms=T`.

## Configuration

| Variable | Default |
| --- | --- |
| `HIVEMIND_WEB_JOB_RETENTION_DAYS` | `30` (`0` disables) |
| `HIVEMIND_WEB_JOB_RETENTION_ENABLED` | `true` |
| `HIVEMIND_WEB_JOB_RETENTION_BATCH` | `25` (max 500) |
| `HIVEMIND_WEB_JOB_RETENTION_MAX_BATCHES` | `8` (max 100) |
| `HIVEMIND_WEB_JOB_RETENTION_INTERVAL_MS` | `21600000` (6 h) |
| `HIVEMIND_WEB_JOB_RETENTION_INITIAL_DELAY_MS` | `300000` |

The window is global across tenants; selection is by row age and never crosses or merges orgs.

## Space

A plain UPDATE leaves the old TOAST data as dead tuples until autovacuum runs; disk shrinks only after a `VACUUM` (and a table rewrite for the OS to get the space back). Memory pressure in Core is resolved at trim time, since the rows are no longer large to read.
