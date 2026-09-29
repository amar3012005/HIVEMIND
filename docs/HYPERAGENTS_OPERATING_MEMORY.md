# Hyper Agents operating memory

Hyper Agents uses a private `Hyper Agents` project in HIVEMIND and a separate
`hivemind.hyper_agent_operating_memories` ledger. Only the internal Control Plane
route `/internal/hyper/operating-memory` reads or writes it. The route requires
the master service credential and active organization membership. The caller's
organization is applied to every query; the project slug is fixed in storage.
The normal `/api/recall`, public memory list, company profile, and cognitive
promotion pipeline never query this table.

Each entry records `kind`, `status`, author agent slug and user ID, a short
title/summary, optional room/WorkRun/trigger references, idempotency key, and
creation time. Recall accepts optional kind, agent, status, room, and WorkRun
filters and returns at most 20 entries ordered newest first. An empty result is
an empty operating history for those filters, not proof that company work did
not happen.

The `hyperagents_memory` tool lets a bound agent recall operational history or
save a concise learning, decision note, or handoff without human approval. It
cannot write `task_status` or `trigger_status`. The Workflow records task and
trigger outcomes from durable receipts; specialist handoffs are recorded only
after the delegated agent returns. Records help continuity but do not replace
the canonical WorkRun, trigger occurrence, provider receipt, or artifact. Agents
must check those receipts before claiming external actions or deliverables.

Company-brain writes still use `hivemind_meta` and its existing approval gate.
No operational entry is promoted to company memory by this path. A future
promotion should be an explicit, reviewed operation with source receipts.

Release sequence: apply the additive SQL migration, deploy the Control Plane
from a source revision that includes the active task-trigger routes, verify an
internal save/filtered recall with two agents in one org and a cross-org denial,
then deploy the Task Agent Worker. Do not release an older Control Plane image
over the active Mac B trigger service.
