# Capability contracts

## Memory platform

`HIVE-MIND Core` owns ingestion, evidence, memories, canonical entities, recall,
scope policy, and hosted MCP tools. The browser never chooses a tenant, user,
project, or provider account. A memory/evidence record has a durable owner,
visibility scope, provenance, and lifecycle state.

Read scope is a server-authorized union or filter:

- **Full scope:** records visible through authorized personal, organization, and
  project scopes.
- **Personal / Organization / Project:** a narrower authorized filter.

Write scope is never “Full scope.” A save requires one concrete Personal,
Organization, or authorized Project destination at the approval boundary.

## Identity platform

`HIVE-MIND Core` owns identity, organizations, membership, projects, plan,
usage, limits, and admission tickets. The Worker forwards authenticated context;
the runner consumes a signed, bounded ticket. UI claims are presentation only.

## Native Harness platform

The runner owns conversation presentation and resolves a Cordis profile. Each
mode is a profile composition:

- `hivemind-chat`: company-memory and connected-app behavior.
- `hyperagents`: operating-system behavior using the same native runner, with a
  distinct profile/plugin composition.

A capability is implemented as a scoped plugin, service, typed `ctx.tools` tool,
or typed session event/projection. Do not encode durable state in prompt text,
browser storage, a temporary spill file, or module-global memory.

## Connected apps

Composio owns provider discovery, account connection, selected tool schemas, and
provider execution. HIVE owns the authenticated user/session bridge, approval
state, durable receipt envelope, and bounded model projection.

```text
authenticated HIVE user
→ active connected account(s)
→ Composio session
→ selected tool contract
→ provider execution once
→ encrypted, scoped durable receipt
→ requested-field projection
```

No raw provider payload, local `file:` locator, broad schema catalog, or
completed workflow becomes automatic context in a later turn.

## HyperAgents and Tara

HyperAgents own workflow/playbook execution; they may call HIVE memory and
connected-app capabilities through typed contracts. Tara owns voice lifecycle;
speech providers are adapters. Neither duplicates Core authorization, HIVE
memory semantics, or Harness session ownership.
