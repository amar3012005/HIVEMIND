# Governed Agent Runtime

`use_tools:true` has one execution authority when the new runtime is admitted:
Core's LangGraph graph. It is feature-gated and does not alter the ordinary
`use_tools:false` path.

```text
browser / Cloudflare Agent (opaque delivery only)
  -> Core authenticated turn admission
    -> LangGraph governed graph
      -> Postgres AgentRun + GovernedAgentEvent + PendingWrite
      -> native Core memory reads
      -> one user-scoped Composio Tool Router session
    -> redacted LangSmith structural trace
  -> Core SSE / Cloudflare opaque lifecycle mirror
```

## Authority boundaries

| Component | Owns | Does not own |
| --- | --- | --- |
| LangGraph in Core | dependency planning, schema admission, HITL interrupts, resume | browser delivery state |
| Postgres | run state, graph event ledger, session binding, approval state, idempotency | model reasoning |
| Composio Meta Tools | session-scoped discovery, connection status, schemas, external execution | tenant policy or approval authority |
| Cloudflare Agent / Workflow | opaque event delivery and recovery cursor | prompts, connector data, execution truth |
| LangSmith | redacted traces, fixture datasets, experiments | runtime or policy decisions |
| Deep Agents benchmark | isolated mock planning comparison | connected production actions |

## Graph contract

The graph is implemented in `src/agent/governed-agent-kernel.js`. Its durable
states are:

```text
received -> context_loaded -> intent_resolved -> capability_discovered
  -> dependency_resolved -> arguments_validated -> tool_executed
  -> awaiting_connection | awaiting_input | awaiting_approval
  -> awaiting_provider_event -> resumed -> completed | failed -> sealed
```

Every transition is appended to `governed_agent_events` before it is mirrored
to the UI. A resumed approval, OAuth result, clarification, or provider event
uses the same graph thread and `AgentRun` ID.

## Progressive context and capabilities

- Conversation context is server-owned and capped at 0–12 prior turns.
- Only the active stage skill is supplied to the model: intent, planning,
  arguments, HITL, or synthesis.
- The planner receives compact capability cards and Composio's recommended
  plan, never an unbounded connector catalog.
- Core memory/profile reads are direct Core capabilities. They are not
  injected through Composio.
- The Composio session is bound to `(org_id, user_id, connection_scope)` in
  `governed_composio_sessions`; each run also stores its exact session ID for
  checkpoint resume.

The connector sequence is fixed by the server:

```text
COMPOSIO_SEARCH_TOOLS
-> COMPOSIO_MANAGE_CONNECTIONS when disconnected
-> COMPOSIO_GET_TOOL_SCHEMAS for the selected capability
-> COMPOSIO_MULTI_EXECUTE_TOOL for a permitted read
-> PendingWrite for every mutation
```

The model proposes only the next semantic action. Core validates the selected
tool, JSON schema, evidence backing, authority, and idempotency before any
execution. A missing provider identifier or named entity triggers one bounded
upstream capability search; only then does the graph ask a business-language
question. It never asks the user for a technical provider ID.

## Human-in-the-loop and provider events

- Connection: the session-bound URL returned by `COMPOSIO_MANAGE_CONNECTIONS`
  pauses and later resumes the same graph.
- Clarification: the UI receives human labels such as "what you would like to
  say" while Core retains the validated schema field key internally.
- Write: every external mutation becomes an editable `PendingWrite`. Approval
  claims it atomically and executes exactly once; reject creates no external
  call.
- Asynchronous provider acknowledgements remain `awaiting_provider_event`.
  A verified provider adapter calls `ingestGovernedProviderEvent`; the event
  ledger deduplicates its `event_id` before any graph resume.

## Feature gate

The new graph is admitted only when both conditions are true:

```text
GOVERNED_LANGGRAPH_RUNTIME=true
Cloudflare durable_chat_agent_v1 variation=full for the authenticated turn
```

All other turns retain the existing durable Composio agent fallback. This is a
reversible compatibility boundary, not a second orchestrator.

## Observability and local gates

LangSmith tracing must be explicitly redacted:

```text
LANGSMITH_TRACING=true
LANGSMITH_HIDE_INPUTS=true
LANGSMITH_HIDE_OUTPUTS=true
LANGSMITH_PROJECT=singulance-governed-agent-canary
```

`scripts/sync-governed-agent-langsmith.mjs` uploads only fixture cases from
`evals/governed-agent-regression.json`; it never uploads connected-account
content. The deterministic evaluators check trajectory, terminal state,
governance, clarification quality, receipt presence, and locale.

Run the local release gate without credentials or external side effects:

```bash
cd core
npm run test:governed-agent-e2e
DATABASE_URL='postgresql://user:password@127.0.0.1:5432/hivemind' npx prisma validate --schema prisma/schema.prisma
```

The gate covers mocked multilingual reads, LinkedIn-style prerequisite
resolution, named-recipient evidence lookup, OAuth interrupt/resume,
draft approval/rejection, provider-event replay deduplication, Cloudflare
metadata-only delivery, and feature-gate behavior. It is intentionally local.
Authenticated connector canaries and rollout/rollback proof remain release
activities; they are not claimed by this document.

## Deep Agents benchmark

`experiments/deep-agent-governed-benchmark/` is disposable and mock-only. It
does not share production secrets, sessions, approvals, or Gmail/LinkedIn
access. Choose an explicit compatible provider/model before running it; its
measurements may inform planning middleware, but it cannot replace the Core
LangGraph runtime without a separate design decision.
