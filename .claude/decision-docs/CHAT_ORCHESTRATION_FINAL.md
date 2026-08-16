# HIVE-MIND Chat Orchestration — Authoritative Architecture

Status: architecture contract as of 2026-08-16. This supersedes the runtime descriptions in dated chat notes. It describes the intended server behavior; production claims still require an authenticated canary against the deployed SHA.

## Public contract

`POST /api/chat` accepts the existing chat payload plus the additive `use_tools` boolean.

- `use_tools` omitted or `false`: only native HIVE-MIND capabilities are eligible.
- `use_tools: true`: connected external applications become eligible. Native HIVE-MIND recall remains available and may be used in the same plan.
- `use_tools` is an authority boundary, not a prompt suggestion. A planner output cannot enable an external capability when the caller did not opt in.
- Writes never execute merely because a model requested them. They produce a reviewable pending action and require approval.

Both modes return the common chat envelope: response, steps, sources/citations, claims, grounding/confidence, scopes, usage, and trace. Compound turns additionally return execution state, draft IDs, pending actions, and an optional continuation request.

## Shared turn entry

```text
authenticated /api/chat request
  -> resolve tenant, user, project and scope lens
  -> start compact profile preload in parallel
  -> one structured semantic planner call
  -> enforce use_tools authority server-side
  -> choose native or compound execution path
  -> stream stage events
  -> synthesize or return server-owned mutation confirmation
  -> validate, meter and emit final response
```

The structured planner owns intent, operation, canonical retrieval query, entities, temporal controls, requested source, response depth, and—only when enabled—external tool groups and dependency steps. The server validates and bounds every field. The planner does not execute tools.

The default planner is defined by `DEFAULT_CHAT_PLANNER_MODEL` in `core/src/llm/chat-provider.js`. Final-answer selection is server-owned through `core/src/agent/chat-synthesis-policy.js`; current default synthesis is `openai/gpt-oss-20b:nitro`, with any experiment explicitly gated and automatic fallback retained.

## `use_tools: false`

```text
planner
  -> direct answer, native mutation, temporal/aggregate/relation/profile, or recall
  -> for recall: canonical query -> hybrid retrieval -> one unified rerank
  -> intent-sized evidence view: standard 5, detailed 10, comprehensive 15
  -> one grounded synthesis call
  -> claim/citation validation
  -> SSE answer stream + final envelope
```

Rules:

1. External tool schemas are not disclosed and connector operations are downgraded to native recall when `use_tools` is false.
2. The planner's usable canonical query is authoritative. The compatibility query optimizer runs only when canonical output is missing. A distinct recovery rewrite may run once only after genuine zero coverage.
3. Normal insufficiency does not trigger another retrieval, rerank, or synthesis hop. Recall retains a mixed top 15, while intent chooses the one window visible to synthesis.
4. Native writes use their dedicated server path and return a server-owned confirmation. They do not fall through to recall synthesis.
5. A retrieval failure or timeout is not an empty result and must never be rendered as factual absence.

## `use_tools: true`

```text
discover connected providers and authority-filtered capabilities
  -> hosted Composio planner when enabled
  -> existing progressive planner on pre-execution planning failure
  -> validated dependency graph
  -> sequential compound orchestrator
       native HIVE-MIND recall/read steps
       connected-app read steps
       approval-gated connected-app write drafts
       continuation when required input is missing
  -> bounded synthesis over completed receipts and recall results
  -> execution envelope
```

Rules:

1. Tool selection is capability-driven, not a language/keyword table. The planner may choose from any discovered, connected, authority-compatible toolkit.
2. Native HIVE-MIND operations remain native. Composio handles connected-application work; it does not become the canonical memory engine.
3. Steps execute only after their dependencies complete. Failed or blocked dependencies prevent downstream side effects.
4. Reads may execute immediately. Writes create exact review artifacts containing provider, tool slug and complete arguments. Approval executes that recorded action; it does not re-plan it.
5. Missing human input produces a durable continuation token and typed input requests. Completed steps are retained and not repeated on resume.
6. A draft is pending, not completed. Provider receipts are the only proof of an external side effect.
7. The compound synthesis model cannot change tool choice, arguments, approval state, receipts or draft IDs.

## Streaming contract

SSE is presentation of server state, not model chain-of-thought. Stable events include planning, query optimization when needed, tool start/completion, evidence rank/window, approval or input requirement, answer deltas, completion and error. The frontend deduplicates events by stable step identity and stops placeholder/typewriter text when the first answer delta arrives.

## LLM transport contract

Every text-model call participating in chat—planner, compatibility query rewrite, direct response, grounded synthesis, connector/compound subtask selection and compound synthesis—must use the shared chat provider boundary. When Cloudflare AI Gateway is enabled with a Dynamic Route, that boundary sends `model: dynamic/<route>` to the Gateway compatibility endpoint.

- Model/provider policy lives in the Cloudflare Dynamic Route.
- Provider credentials are BYOK aliases; direct keys are never forwarded to Gateway.
- Gateway mode fails closed for chat text. It does not silently make a second paid direct-provider call.
- Gateway cache remains disabled for tenant-bearing chat until a separately reviewed tenant/scope/revision cache key exists.
- If Gateway is not completely configured, the current direct provider route remains unchanged.

Cloudflare references: [Dynamic Route usage](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/usage/), [Gateway authentication](https://developers.cloudflare.com/ai-gateway/configuration/authentication/), and [BYOK aliases](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/).

## Observability and acceptance

Every turn trace must identify planner, optional optimizer, retrieval, rerank, synthesis and repair usage; the selected evidence depth; retrieval/rerank/synthesis pass counts; provider/Gateway route; time to first SSE answer token; and compound receipts without secrets.

Release acceptance covers at least: native recall, evidence-only answer, temporal query, native save, connector read, connector draft, approval execution, recall-to-document-to-message dependencies, missing-input continuation, malformed model output, Gateway failure, and no external side effect when `use_tools` is false.
