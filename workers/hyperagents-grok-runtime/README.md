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
