# Grok-style HyperAgents runtime

This Worker is the durable outer runtime for feature-flagged HyperRoom turns.
It keeps only coordination metadata: opaque tenant-scoped agent identities,
capability manifests, assignment state, and Workflow receipts. PostgreSQL and
HIVEMIND remain authoritative for Rooms, WorkOrders, artifacts, evidence, and
semantic memory.

The cumulative Flagship flag is `hyperagents_grok_agents_v1`. Its string value
must be one of `off`, `shadow_roster`, `persistent_agents`,
`durable_assignments`, `real_tools`, `collaboration`, `browser`, `skills`,
`routines`, or `full`. Unknown values and Flagship failures resolve to `off`.

Local and production resources have distinct names. Production additionally
requires the Core environment acknowledgement
`HYPER_GROK_PRODUCTION_ACK=enable-grok-hyperagents-v1`; never point a local
runtime at the production Core, database, browser, or credentials.

Messages contain identifiers only. A Workflow loads the authorized Room roster
from Core, provisions each persistent hired Agent, executes the latched turn,
and verifies the persisted terminal result. No enabled turn silently falls
back to the legacy simulated-worker path.

## Runtime contract

- `shadow_roster` compares roster selection without changing execution.
- `persistent_agents` provisions immutable organization-scoped Agent identities.
- `durable_assignments` launches deterministic Room and WorkOrder Workflows.
- `real_tools` requires each selected employee to run its own bounded tool loop.
- `collaboration` enables bounded delegation and durable handoff events.
- `browser` enables Browser Run sessions and authority-gated Sandbox processes.
- `skills` enables versioned skill manifests; activation requires successful
  receipts from two distinct WorkOrders.
- `routines` enables Agent-owned cron, interval, and delayed schedules.
- `full` is the cumulative complete mode.

Room control is durable. Pause, resume, cancellation, and steering are stored
on the HyperTurn and returned on every Employees callback. Browser targets are
restricted to public HTTPS destinations. Sandbox execution accepts argv (not
an interpolated shell command), uses an allowlist, requires an explicit
authority grant, and is isolated by opaque tenant/work-order identity. Browser
and Sandbox responses are bounded; provider actions become PostgreSQL receipts.

The Worker does not store prompts, customer content, connector credentials, or
semantic memory. Workflow payloads contain opaque identifiers and versioned
runtime metadata only.

## Verification

```powershell
npm run check
npm test
npm run dry-run
```

The dry run must list both Workflow bindings, `HIRED_HYPER_AGENT`, `Sandbox`,
`BROWSER`, and the local Sandbox image. It does not provision or deploy them.
