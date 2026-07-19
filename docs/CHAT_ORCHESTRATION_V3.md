# HIVEMIND Chat Orchestration V3

## Goal

Every HIVEMIND chat surface uses one schema-governed, tenant-safe orchestration
contract. A fast model parses semantic intent in any language, while server-owned policy decides
scope, retrieval, completeness, tool authorization, side effects, citations,
and memory writes.

## One request contract

```text
ChatTurnRequest
  principal: user_id + org_id (session-derived, never body-derived)
  project: optional requested project_id
  message + language + bounded history
  optional exact source selector and temporal selector
  response transport: JSON or SSE projection of the same turn result
```

Before planning, Core creates an immutable `AuthorizedChatContext` containing
the principal, authorized projects/teams, effective project scope, source
eligibility policy, connector grants, one deadline, and one idempotency key.
An inaccessible project fails before recall, working-set taps, connectors, or
saves.

## Intent decision

The fast model produces one required `route_chat_turn` tool call from the user
message, selected language, the last six normalized turns, and a bounded
server-owned capability catalog. JSON-schema validation returns a closed operation enum:

```text
direct | recall | source_read | aggregate | connector_read |
connector_write | save | update | delete | rename_assistant
```

The decision also carries canonical entity candidates, an exact source
selector, temporal constraints, required coverage, connector groups, project
selector/continuation, same-language acknowledgement, and side-effect policy.
There are no English keyword, imperative, greeting, connector, filename, date,
or project-prompt fallbacks. Invalid output or parser timeout degrades only to
scoped read-only recall of the unchanged request and can never become a write.

## Event-driven state machine

```text
turn_accepted
  -> intent_decided
  -> scope_bound
  -> retrieval_planned
  -> tool_selected
  -> tool_started
  -> tool_completed | tool_failed
  -> coverage_assessed
  -> approval_required | memory_candidate_proposed (optional)
  -> answer_validated
  -> turn_completed
```

Events have a schema version, trace ID, monotonic sequence, deadline,
idempotency key, and sanitized audit payload. SSE is only a projection of this
event stream. JSON and SSE must end with the same `ChatTurnResult`.

## Context hops

1. Metadata admission: tenant, user visibility, authorized project/team,
   current-version, exact source, entity IDs, and temporal bounds.
2. Fast recall: hybrid memory/evidence retrieval over admitted rows.
3. One typed escalation: source hydration, temporal expansion, or graph
   traversal only when coverage proves it is needed.
4. Connector read: select only from the request's authorized AgentScope-style toolkit catalog,
   using registered group/skill names, real tool descriptions, schemas, and
   read-only annotations.
5. Answer validation: server-owned citations and claim eligibility.

All hops share one absolute deadline and cancellation signal. A timed-out hop
may return partial grounded context with an explicit cutoff; it may not keep a
side effect running in the background.

## Exact source questions

A named filename is a hard selector, never a ranking hint. Resolve it inside
the authorized project/source set, hydrate query-centered segments, and fail
closed if unresolved. `full` is caller-explicit and bounded; normal file
questions use `explain`. Evidence from another document may not rescue a
failed exact-source request.

## Aggregates and counts

`aggregate` is not top-K recall. It executes a bounded, deterministic query
over the document/entity tables, deduplicates by canonical entity ID, and
returns:

```json
{
  "value": 6,
  "entity_kind": "product",
  "parent_entity": "Solvis",
  "coverage": { "complete": true, "cutoff": false },
  "member_ids": ["..."]
}
```

If completeness is not proven, chat must say that the exact count is unknown;
it must never count the first five semantic matches.

## Connector actions

Toolkit construction is scoped by `(user_id, org_id, project_id)` and exposes
only connected, authorized groups. Native HIVEMIND tools and connector tools
share the same `core/src/agent/connector-toolkits/` registration contract:
name, description, JSON schema, group, read-only, concurrency-safe, external,
and middleware. Capability summaries are cached before parsing; MCP clients
and real tool schemas are hydrated only for selected groups. Reads run a
bounded read-only search-to-read loop and may contribute live evidence. Writes
create a draft bound to org, connector/account, project, tool schema version,
argument digest, expiry, and idempotency key. Approval revalidates every
binding and atomically permits exactly one external execution.

## Memory writes and project classification

Questions never auto-save. Explicit durable facts create a provenance-bearing
candidate. An explicit authorized project wins; otherwise one name-and-
description classifier returns `auto`, `ask`, or `personal`. Ambiguity asks the
user and saves nothing. The canonical ingest coordinator applies tenant scope,
deduplication, and `UPDATES`/`EXTENDS`/`DERIVES` invariants; enrichment and
derivation remain asynchronous.

## Migration gates

1. Land the versioned intent and event contracts behind shadow telemetry.
2. Close project/source/memory-ID and connector approval isolation gaps.
3. Add the exact aggregate executor and catalog-driven connector reads.
4. Make one V3 orchestrator canonical for JSON and SSE; remove error-driven
   legacy fallthrough.
5. Run tenant/project/source/connector/count acceptance fixtures.
6. Promote only after production proves the same orchestration version and
   result contract for every user surface.
