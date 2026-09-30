# HyperAgents private operating memory

HyperAgents use a separate PostgreSQL table, `hivemind.hyper_agent_operating_memories`, for reusable agent learnings, decision notes, handoffs, and runtime task/trigger receipts. This is tenant-scoped by `org_id` and deliberately excluded from ordinary HIVE-MIND company recall, profiles, and the company-memory approval/promotion flow.

## Toolkit surfaces

- Core exposes `hyperagents_memory` through the shared authenticated `/api/mcp` endpoint. Any connected agent with a tenant credential sees it in `tools/list` and can call `action="recall"`; `action="save"` also requires the credential's normal `memory:write` entitlement. No Cloudflare task-agent deployment is needed for this server toolkit.
- Recall is shared across agents in the same organization. Omit `agent_slug` to search the tenant's operating memory, or supply it to filter. Save requires `agent_slug`, `kind`, `title`, `summary`, and a stable `idempotency_key`. The server binds organization and author from the authenticated credential.

## Storage and safety

The table uses an organization-scoped idempotency key, a reserved `hyper-agents` project, bounded note fields, and server-side validation for slugs, statuses, run references, and supersession. Agent writes can only create `recorded` learning/decision/handoff notes. Only trusted runtime calls can write authoritative task or trigger status receipts. Retrieval is bounded to 20 notes and scoped by organization, with optional agent, kind, status, room, and run filters.

The Core container's normal migration step must apply `20260930120000_hyper_agent_operating_memory` before the new tool is used. The change is additive and the existing company-memory tables are unchanged.
