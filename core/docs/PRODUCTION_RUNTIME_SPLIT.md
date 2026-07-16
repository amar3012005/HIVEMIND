# Production Runtime Split

This branch introduces a minimal runtime split for `hm-core` so production can
separate latency-sensitive HTTP traffic from recurring maintenance jobs.

## Roles

- `HIVEMIND_RUNTIME_ROLE=all`
  Default. Backward-compatible. Runs HTTP plus recurring maintenance jobs in one process.
- `HIVEMIND_RUNTIME_ROLE=app`
  Runs the HTTP/API process and connector background paths only.
  Skips recurring maintenance jobs and sidecar warm paths.
- `HIVEMIND_RUNTIME_ROLE=maintenance`
  Runs recurring maintenance jobs only. Does not bind the HTTP port.
- `HIVEMIND_RUNTIME_ROLE=sidecar`
  Runs recall warmup and the DR sidecar only. Does not bind the main HTTP port.

## Commands

From `core/`:

```bash
npm run server
npm run worker:maintenance
npm run worker:sidecar
```

Recommended production split:

```bash
HIVEMIND_RUNTIME_ROLE=app npm run server
HIVEMIND_RUNTIME_ROLE=maintenance npm run worker:maintenance
HIVEMIND_RUNTIME_ROLE=sidecar npm run worker:sidecar
```

## Queue-Required Knowledge Uploads

Production now treats durable KB queueing as mandatory:

- `NODE_ENV=production` forces queued knowledge uploads
- `HIVEMIND_REQUIRE_QUEUED_KB_UPLOADS=true` forces the same behavior outside production
- if the KB queue is unavailable, `/api/knowledge/upload` returns `503 queue_unavailable`

That removes the old inline fallback that could pin an HTTP worker for minutes.

## Container Shape

For the current branch, the production-safe split is:

- `hm-core-app`
  `HIVEMIND_RUNTIME_ROLE=app`
- `hm-core-maintenance`
  `HIVEMIND_RUNTIME_ROLE=maintenance`
- `hm-core-sidecar`
  `HIVEMIND_RUNTIME_ROLE=sidecar`
- `hm-control`
- `hm-fe`
- `hm-redis`
- `hm-postgres`
- `hm-qdrant`

Heavy sidecars like `hm-employees`, `hm-docling`, and `hm-playwright` should remain separate from the app runtime.

## Operational Notes

- `all` mode remains available for rollback and for smaller environments.
- `maintenance` and `sidecar` still import the same `server.js`, so behavior stays aligned with the app process without a second framework or runtime stack.
- This is an incremental split, not the final architecture. It removes duplicated recurring jobs first; deeper route extraction can happen later.
