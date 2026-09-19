# Visual Generation lifecycle

Shared `visual.production.v1` service for every authenticated HIVE agent and product surface.

- `/start` writes identifier-only messages to Cloudflare Queues.
- One deterministic Workflow instance hydrates tenant context from Core, builds a production spec, generates a reusable style anchor for sets, critiques the master, performs at most one revision, generates coordinated variants, and stores outputs in R2.
- Core PostgreSQL remains the source of truth for job state and append-only stage events.
- `/artifact` is service-credential protected; browser and MCP callers retrieve assets through tenant-authenticated Core routes.
- Queue retries, a DLQ, deterministic Workflow IDs, idempotent Core events, and per-step retries make burst load and replay safe.

Required secret:

```text
HIVEMIND_VISUAL_GENERATION_SECRET=<same value in Core>
```

Core can override `VISUAL_GENERATION_WORKFLOW_ENABLED` and
`HIVEMIND_VISUAL_GENERATION_URL`; production defaults to this Worker's public
route and reuses the existing visual-lifecycle service credential when a
dedicated generation credential has not yet been provisioned.
