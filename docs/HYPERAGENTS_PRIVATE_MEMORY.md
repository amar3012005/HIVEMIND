# HyperAgents private operating memory

HyperAgents use a separate PostgreSQL table, `hivemind.hyper_agent_operating_memories`, for reusable agent learnings, decision notes, handoffs, and runtime task/trigger receipts. This is tenant-scoped by `org_id` and deliberately excluded from ordinary HIVE-MIND company recall, profiles, and the company-memory approval/promotion flow.

## Toolkit surfaces

- Cloudflare Think task agents receive the `hyperagents_memory` tool. Its `operation` is `recall` or `save`; save is limited to `learning`, `decision_note`, and `handoff`, and is not gated by company-memory approval.
- Core exposes the same operation through authenticated `/api/mcp` as the `hyperagents_memory` tool. The API key supplies the user and organization identity. Save requires the credential's normal `memory:write` entitlement.
- Worker-to-Core calls use `/internal/hyper/operating-memory` with the server-held master key. Core also validates that the supplied user is an active member of the supplied organization. The master key is never sent to the model or browser.

## Storage and safety

The table uses an organization-scoped idempotency key, a reserved `hyper-agents` project, bounded note fields, and server-side validation for slugs, statuses, run references, and supersession. Agent writes can only create `recorded` learning/decision/handoff notes. Only trusted runtime calls can write authoritative task or trigger status receipts. Retrieval is bounded to 20 notes and scoped by organization, with optional agent, kind, status, room, and run filters.

Apply the migration `20260930120000_hyper_agent_operating_memory` before enabling the updated Core/worker build. This change has not been deployed; the migration has not been applied to any database.
