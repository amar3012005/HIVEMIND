# Native Chat Orchestrator V2 (`use_tools:false`)

## Status

V2 is a feature-flagged candidate. It is disabled unless `CHAT_ORCHESTRATOR_V2_ENABLED=true` and is never eligible when `use_tools:true`.

## Purpose

V2 replaces the native turn's routing stage with one typed semantic plan while retaining the proven canonical recall, temporal tools, profile store, memory-write admission, evidence assembly, citation mapping, synthesis, SSE, and authorization boundaries.

```text
deterministic turn context
  -> compact native capability catalog
  -> semantic planner (one required tool call)
  -> binary plan validation (valid / repairable / invalid)
  -> deterministic authority compiler
  -> existing bounded native executor
  -> existing evidence assembly
  -> existing grounded synthesis
```

LangGraph expresses the typed planner/validator/compiler trajectory. Ordinary turns are not checkpointed: there is no benefit in persisting a three-node read-only planning graph. Durable checkpoints remain appropriate only for a future workflow that pauses across requests.

## Native capability families

- `profile`: current user/organization profile reads and caller-scoped profile updates.
- `memory_write`: canonical memory saves; omitted scope stays omitted and triggers the existing chooser.
- `workspace_read`: recall, named-source read, event range, snapshot, diff, timeline, relations, exact entity aggregation, and authorized projects.
- `direct`: only context-free conversation or transformations fully supplied by the turn.

The planner does not see connector schemas. It cannot select Composio or compound execution.

## Retrieval contract

The planner produces one compact canonical query, exact entity anchors, optional source identity, temporal semantics, and the requested answer shape. It does not fan out retrieval. The existing recall engine remains responsible for parallel hybrid memory/evidence retrieval, fusion and one unified rerank.

The structured output is `NativeTurnPlanV2`: schema version, capability family, exact operation, response contract, resolved references, source selection, temporal semantics, exactly one dependency-free native step, and completion/approval state. Tool names supplied by the model are advisory; the compiler repairs them to the server-owned operation map or rejects semantic invalidity.

## Safety and rollout

`POST /v2/chat` is the isolated authenticated acceptance surface. It forces the
V2 native planner for that request, rejects `use_tools:true`, and otherwise
shares `/api/chat` authentication, tenant admission, quota checks, execution,
synthesis, response shape, and SSE behavior. `/api/chat` remains unchanged.

The executable 50-case gate supports three levels:

```bash
cd core
npm run eval:chat-v2 -- --validate-only
OPENROUTER_API_KEY=... npm run eval:chat-v2
HIVEMIND_V2_BASE_URL=https://core.singulancelabs.com HIVEMIND_API_KEY=... npm run eval:chat-v2 -- --http
```

The first validates the corpus, the second evaluates the real semantic planner,
and the third proves the full deployed `/v2/chat` lifecycle and V2 trace.

- Primary planner: `google/gemini-2.5-flash-lite` through the shared Cloudflare-backed chat provider.
- Fallback planner: `openai/gpt-oss-20b:nitro`, used only when the primary call fails.
- A V2 planning or validation failure may fall back to the existing progressive planner only before any execution or write.
- `use_tools:true` remains on the current Composio/compound path.
- `CHAT_ORCHESTRATOR_V2_SHADOW=true` evaluates V2 without serving it.
- `CHAT_ORCHESTRATOR_V2_CANARY_PERCENT=0..100` assigns a stable user bucket.
- `CHAT_ORCHESTRATOR_V2_ENABLED=true` serves V2 for every eligible native turn.
- Compare operation, query, entities, time/source fields, exact call count, tool calls, evidence, answer validity and latency.

## Architecture conformance

| Required boundary | V2 implementation |
|---|---|
| TurnContextBuilder | Deterministically bounds history, compact profile, clock/timezone and authorized projects. |
| Native catalog | Four always-visible capability families with use/avoid, authority and side-effect metadata. |
| Tool discovery | Deliberately absent for native chat; reserved for large `use_tools:true` connector/MCP catalogs. |
| Semantic planner | One required structured tool call; stable prompt is approximately 1,094 tokens. |
| Validator/compiler | Binary valid/repairable/invalid outcome; tool mapping, depth and authority are server-owned. |
| Bounded executor | Exactly one native operation compiled into the proven current executor. |
| Evidence/synthesis | Existing deterministic evidence bus and exactly one grounded synthesis path are reused. |
| Checkpoints | No persistence for ordinary native turns; reserved for future approval/user-input/cross-request workflows. |

## Explicit phase-one limits

`hivemind_query_table` exists in the tool registry but is not represented by the current canonical intent executor. V2 does not advertise it until the executor contract supports exact table reads end to end. Connector tool discovery and multi-step external workflows remain outside this native graph.
