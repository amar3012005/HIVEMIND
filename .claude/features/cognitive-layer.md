# Cognitive Layer

Status: released 2026-08-02

All Cognition settings, history, status, manual runs, retention, and deletion
routes require the canonical active organization-admin policy. The real
`/api/cognition/*` namespace is entitlement-gated. Tenant responses no longer
include global recent state or unscoped governance agent state.

Organization synthesis only includes organization memories by default. Personal
memories require both organization enablement and an active individual opt-in;
the implementation fails closed while no individual consent UI exists. Manual
runs notify the initiating administrator and retain observable asynchronous
behavior.

Focused contracts verify the real route namespace, canonical guards, no global
agent-state query, and consent-gated private input. Remote `.amr` storage parity
and retry behavior need a dedicated live canary before personal-memory synthesis
is enabled broadly.
