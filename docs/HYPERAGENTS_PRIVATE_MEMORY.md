# HyperAgents private operating memory

HyperAgents use a separate PostgreSQL table, `hivemind.hyper_agent_operating_memories`, for reusable agent learnings, decision notes, handoffs, and runtime task/trigger receipts. This is tenant-scoped by `org_id` and deliberately excluded from ordinary HIVE-MIND company recall, profiles, and the company-memory approval/promotion flow.

## Toolkit surfaces

- Core exposes `hyperagents_memory` through the shared authenticated `/api/mcp` endpoint. Any connected agent with a tenant credential sees it in `tools/list` and can call `action="recall"`; `action="save"` also requires the credential's normal `memory:write` entitlement. No Cloudflare task-agent deployment is needed for this server toolkit.
- Recall is shared across agents in the same organization. Omit `agent_slug` to search the tenant's operating memory, or supply it to filter. Save requires `agent_slug`, `kind`, `title`, `summary`, and a stable `idempotency_key`. The server binds organization and author from the authenticated credential.

## Storage and safety

The table uses an organization-scoped idempotency key, a reserved `hyper-agents` project, bounded note fields, and server-side validation for slugs, statuses, run references, and supersession. Agent writes can only create `recorded` learning/decision/handoff notes. Only trusted runtime calls can write authoritative task or trigger status receipts. Retrieval is bounded to 20 notes and scoped by organization, with optional agent, kind, status, room, and run filters.

The Core container's normal migration step must apply `20260930120000_hyper_agent_operating_memory` before the new tool is used. The change is additive and the existing company-memory tables are unchanged.

## Team memory v2 (lesson, procedure, progress, agenda)

Migration `20261029140000_operating_memory_team_kinds` adds four kinds to the same table. Their fields, confirmations and promotion live in the existing `context` JSONB; no column or table is added. Existing kinds, request fields and responses are unchanged. All reads and writes stay scoped to the authenticated organization, and the author is the authenticated user.

Endpoint: `POST /v1/hyperagents/operating-memory` (also `hyperagents_memory` on the hosted MCP). Body `action` is `save`, `recall` or `confirm`.

### Save (agent kinds)

Common: `agent_slug` (required). `title`, `summary` and `idempotency_key` are optional for the four new kinds (derived from content); `context` must be omitted for them. Unknown keys and team fields on other kinds are rejected with 400.

| kind | fields | bounds |
|---|---|---|
| `lesson` | `when`, `do`, `because`, `confidence` | 300, 500, 500 chars; confidence 0 to 1 (default 0.5) |
| `procedure` | `trigger`, `steps[]`, `check`, `source` | 300 chars; 1 to 12 steps of 300 chars; check 300; `learned` (default) or `shown` |
| `progress` | `task_key`, `goal`, `done[]`, `next[]`, `open_questions[]`, `evidence[]` | key 120 chars `[A-Za-z0-9:_./-]`; goal 400; arrays 12/8/8/8 items of 200/200/200/300 chars |
| `agenda` | `agenda_key`, `outcome`, `target`, `milestones[]`, `task_keys[]`, `status` | key 80 chars `[a-z0-9_-]`; outcome 400; target `{text<=200, value?: number, unit?<=40}` or a string; up to 12 milestones (string or `{text<=200, done?, due?: YYYY-MM-DD}`); up to 12 task keys; status `active` (default), `paused`, `done`, `dropped` |

`progress` and `agenda` upsert by `task_key` / `agenda_key`: the new revision is linked to the current head through `supersedesId`, so only the latest is returned by recall (older revisions remain stored). `supersedes_id` is rejected for these two kinds. A `lesson` or `procedure` may pass `supersedes_id` (same kind, any employee); the old one is then excluded from the brief and from default recall. Replaying the same `idempotency_key` returns the original with `replayed: true`.

Response: `{ ok, replayed, memory }` where `memory` is `{ id, project, kind, status, agentSlug, title, summary, roomId, runId, triggerId, context, supersedesId, createdAt, updatedAt }`, plus `promoted` and `confirmedBy: [{ agentSlug, at }]` for lesson and procedure.

### Recall

Brief (default when no targeting filter is sent, or `mode: "brief"`): `{ action: "recall", mode?: "brief", context?: string<=2000, hints?: string[<=8], agent_slug?, promoted?: true, limit?: 1..20 (default 8) }` returns `{ ok, project, mode: "brief", count, truncated, items: [{ id, kind, title, gist, author, updated_at, promoted? }] }`. Items are ranked by overlap with `context`, recency (14-day half-life), entity `hints` matched in the text, and same `agent_slug`, with a small bonus for promoted knowledge. `items` is trimmed to about 2000 characters (`truncated: true` when trimmed). Superseded memories and Runtime-private kinds are never included.

Full: any of `query`, `kind`, `status`, `room_id`, `run_id`, `state`, `agent_slug`, `id` (UUID), or `mode: "full"` keeps the original listing `{ ok, project, count, memories }` with full records. `promoted: true` additionally restricts to promoted lessons and procedures.

### Confirm

`{ action: "confirm", id, agent_slug, idempotency_key? }` for a `lesson` or `procedure`. Response `{ ok, replayed, promoted, confirmations, memory }`. The second confirmation (by the same or a different employee) sets `promoted`. An `idempotency_key` makes a retried confirm a no-op. Errors: `memory_not_found` (404, also for other organizations and Runtime-private rows), `invalid_confirm_kind`, `superseded_memory_unavailable`, `invalid_memory_id`, `invalid_agent_slug`.
