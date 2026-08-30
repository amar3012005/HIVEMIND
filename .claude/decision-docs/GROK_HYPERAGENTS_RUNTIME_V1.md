# Grok-style HyperAgents runtime v1

## Authority

- A Room is a collaboration and governance boundary, never an AI employee.
- Every hired `DigitalEmployee` has one stable, opaque Cloudflare Agent identity.
- PostgreSQL owns turn, assignment, lease, artifact, receipt, and terminal state.
- Cloudflare Workflows own retryable outer execution and external waits.
- The Employees-side real ReAct/LangGraph-compatible loop owns bounded cognition.
- HIVEMIND owns semantic memory, evidence, entities, and recall.

## Runtime modes

`hyperagents_grok_agents_v1` is a cumulative string flag. The mode is evaluated
at admission, stored on `HyperTurn`, and cannot be changed in flight. Unknown
values and evaluation failures resolve to `off`.

`off` preserves the existing runtime. `shadow_roster` materializes and compares
the full roster. `persistent_agents` provisions stable identities.
`durable_assignments` starts the Cloudflare Room Workflow. `real_tools` replaces
the simulated single-call WorkOrder worker with the selected participant's own
tool-using agent. Later modes cumulatively authorize collaboration, browser,
skills, routines, and the complete runtime.

## Recovery

Workflow IDs are `room-{turn_id}-v{processing_version}` and WorkOrder IDs remain
the existing `(turn_id, order_key)` idempotency boundary. Core reclaims an
execution lease only after ten minutes without progress. Completed Workflow
steps and append-only WorkResults are reused. An enabled failure is surfaced
and retried; it never silently falls back to a simulated teammate.

## Local operator flow

1. Run the Worker with `wrangler dev --env local --port 8789`.
2. Set the same non-production `HYPER_GROK_WORKFLOW_SECRET` in Worker and Core.
3. Set `HYPER_GROK_RUNTIME_ENABLED=true` and keep `HIVEMIND_LOCAL_MODE=true`.
4. Target the local test organization/user in Flagship, beginning with
   `shadow_roster` and advancing one mode after its canaries pass.
5. Inspect `roster_evaluated`, `agent_activated`, assignment, receipt, and seal
   events plus the corresponding PostgreSQL rows.

Production requires a separate governed promotion and must start with the flag
defaulting to `off`.
