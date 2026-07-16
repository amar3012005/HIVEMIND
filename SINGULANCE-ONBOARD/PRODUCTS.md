# Products

## Product Thesis

SINGULANCE gives a company three connected capabilities:

1. **Remember:** retain reliable organizational context.
2. **Reason and act:** give scoped AI workers persistent roles and company context.
3. **Speak:** operate through a real-time voice interface when appropriate.

The products are connected by tenant identity, organization context,
entitlements, auditability, and the HIVEMIND memory substrate. They must not
become three incompatible applications.

## HIVEMIND: The Brain

HIVEMIND is the organizational memory and retrieval layer. Its current surfaces
include memories, search/recall, memory graph, document and knowledge-base
ingestion, connectors, workspaces, organizations, projects, teams, invitations,
roles, API keys, MCP, meeting notes, profile/settings, usage, billing, and
platform administration.

Routes are centralized in
[`HiveMindApp.jsx`](../frontend/Da-vinci/src/components/hivemind/app/HiveMindApp.jsx).
Core memory runtime starts at [`core/src/server.js`](../core/src/server.js);
identity/control/billing runtime starts at
[`core/src/control-plane-server.js`](../core/src/control-plane-server.js).

## HyperAgents: The Operating System

HyperAgents is the agentic workforce layer at `/hivemind/app/employees/*`. It
turns company context into persistent rooms and role-based digital employees.

Verified concepts include company onboarding/context, durable rooms and turns,
organization-scoped employee identities, memory-grounded discussion, review,
debate, simulation, synthesis, optional specialist workflows, streaming with a
fallback path, and role gates for privileged capabilities.

“Self-learning” means governed learning from retained, tenant-scoped memory and
explicit cognition/workflow processes. Do not market it as unrestricted
autonomous self-modification without a designed, tested, auditable contract.
See [`docs/HYPERAGENTS_README.md`](../docs/HYPERAGENTS_README.md).

## TARA: The Voice

TARA is the voice interface and voice-agent runtime. It includes
[`TaraConfig.jsx`](../frontend/Da-vinci/src/components/hivemind/app/pages/TaraConfig.jsx)
and server-side voice services, including the Deepgram sidecar. TARA must use
the same organization, role, entitlement, connector, and memory boundaries as
the rest of the platform; voice is never a bypass.

## Audience and Storage

| Audience | Default memory/storage mode | Commercial model |
| --- | --- | --- |
| Personal / B2C | `.amr` personal memory plane | Free, Pro, and Scale plans with backend-enforced limits. |
| Managed enterprise / B2B | Central PostgreSQL + Qdrant hybrid plane | Onboarding phase, then organization-specific runway/subscription terms. |
| Self-hosted enterprise / BYOD | Customer Box PostgreSQL + Qdrant or supported `.amr` | Central control/identity/billing with customer-owned memory data. |

Plan, usage, and feature gates are read from backend ground truth. Enterprise
must not be shown generic personal upgrade plans.
