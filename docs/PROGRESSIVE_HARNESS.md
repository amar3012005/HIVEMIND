# Progressive connected-tool harness

This is an update to the existing durable Composio runtime, not a second execution platform. The baseline is GitHub `origin/singulance-main` at `2f8757af25257ab9f54306de28beb2b784e36be8`. The SSH remote's same-named branch was stale and is not the release base.

## Admission and compatibility

New runs use `progressive-v1` only when the existing durable-agent gate is enabled, the request has `use_tools: true`, `USE_TOOLS_PROGRESSIVE_HARNESS=true`, and the authenticated organization appears explicitly in comma-separated `USE_TOOLS_PROGRESSIVE_HARNESS_ORGS`. Missing configuration and wildcard-only allowlists do not enable it. The selected harness is persisted on the run; changing the flag affects new admission, not the semantics of an interrupted run.

Ordinary `use_tools:false` keeps its existing route. Flag-off connected chat retains its old planner and runtime. Enabled chat enters after scope authorization, before the legacy capability catalog and intent planner, avoiding duplicate planning context.

## Responsibilities

| File | Responsibility |
| --- | --- |
| `core/src/agent/progressive-harness.js` | Semantic multilingual intent, bounded valid JSON observations, one next action, evidence-based Markdown synthesis instructions |
| `core/src/agent/durable-composio-agent.js` | Persistent execution, discovery, schema validation, connection/field pauses, native reads, approval drafts and receipts |
| `core/src/agent/progressive-draft-contract.js` | Schema-validated edits and clean provider arguments at canonical approval |
| `core/src/agent/progressive-approval-events.js` | Idempotent projection of canonical approval/provider receipts into run state |
| `core/src/agent/react-agent-v2.js` | Gated admission and final response envelope |
| `core/src/server.js` | Authenticated continuation, retained thread/language/run identity, SSE completion |
| `core/src/connectors/composio/composio-service.js` | Tenant session, English search boundary, schema retrieval and session execution |
| `core/src/agent/v2/durable-turn-store.js` | Existing durable transport event/checkpoint storage and replay |
| Frontend `MarkdownMessage.jsx` and chat surfaces | Safe CommonMark/GFM presentation selected by `harness_version`, preserving existing approval UI |

The model proposes actions; it does not authorize tools. Only discovered capabilities are eligible. Unknown/mutating capabilities cannot run as reads. Writes create canonical `PendingWrite` artifacts, never execute the provider mutation in this loop. Approval and provider execution remain owned by the existing approval system.

User language does not select a code path. The intent record separates response language, requested outcomes, toolkits and explicit facts. Only the Composio search boundary uses structured English. Native memory and external receipts have independent synthesis budgets. Observations are projected before JSON serialization, not sliced into invalid JSON.

Each requested outcome has a stable ID and read/draft/memory type. A successful action receipt covers at most one declared outcome. The host rejects premature completion and continues through multiple requested drafts. A Postgres compare-and-swap lease prevents concurrent workers from claiming the same run. Checkpoints merge concurrent canonical approval receipts rather than overwriting them.

Progressive draft editing is schema-driven, including typed numbers, booleans and nested JSON. Private harness/schema metadata cannot be edited or passed to providers. Approval validates the stored arguments again and compares the argument hash when claiming the draft, preventing an edit/approve race from executing stale values. Terminal sent/failed/cancelled/expired events project into the same run; duplicate projection does not re-execute the tool. Reading canonical draft receipts also repairs missed projections.

This change reuses existing persisted runs, continuations and transport events. It does not introduce a second LangGraph approval authority or a new provider-webhook scheduler. A completed chat response is distinct from a pending external action; an approval draft is not a sent action.

## Verification and rollout

The progressive harness uses `openai/gpt-oss-20b:nitro` with low reasoning effort for intent, action planning, semantic argument review and schema argument generation. Deterministic schema, authority and receipt checks remain in Core. This is one model policy for the governed turn, rather than a provider-specific special case or a separate agent runtime.

Run the focused helper, runtime, continuation and PostgreSQL integration suites before promotion. The PostgreSQL test uses isolated local state and injected providers; it is not proof of a live Composio action. Frontend verification includes semantic Markdown/security tests and the canonical Cloudflare production build.

The baseline full unit suite currently has 56 failures. Compare named failures at the exact base rather than claiming the entire suite passes. Existing baseline source omissions include `core/src/search/hybrid.js` and `three-tier-retrieval.js`.

Release order: push the tested frontend commit, land frontend `main`, update the parent gitlink, push and land the complete backend commit on GitHub `singulance-main`. Deploy only Core via the inspected canonical runner, then deploy the clean matching frontend via `npm run deploy:cloudflare`. Keep new admission disabled initially. Record immutable backend SHA/image and Cloudflare Worker version before and after promotion.

Enabled acceptance must cover an explicitly allowlisted tenant, a nonallowlisted tenant, `use_tools:false`, multilingual multi-read evidence, missing-field continuation, a pending draft, and retry/replay. Do not send or publish customer content as a test. Check authenticated responses, persisted run state and the served lazy frontend chunk, not only `/health`.

Core receives the new variables through the existing `/root/hivemind/.env` env-file. Back up configuration before an allowlisted canary and recreate only Core. Disabling admission does not cancel already latched runs. Runtime rollback must use the recorded immutable previous SHA through the canonical release runner; the current quick-deploy script rejects the old `--rollback` shortcut. Frontend rollback uses the recorded previous Worker version.

## Documentation consulted

- [Composio search](https://docs.composio.dev/toolkits/meta-tools/search_tools): scoped atomic English queries and workflow session continuity.
- [Cloudflare harness recovery](https://developers.cloudflare.com/agents/harnesses/think/recovery/): bounded recovery and proactive context management.
- [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence): distinguish persisted thread checkpoints from long-term memory; in-memory checkpoints do not survive restart.

These references informed the boundaries; neither SDK is newly installed by this change.

## Local candidate evidence (2026-09-05)

- Focused backend suites: 111 passing tests, including native HTTP Request validation across default planning, argument, localization and synthesis calls.
- Full backend unit suite: 1444 passing, 56 failing; all failing names match the untouched `2f8757af` baseline.
- Real local PostgreSQL/Prisma canary: pause/recreate/resume, tenant isolation, concurrency, one idempotent draft, sent/cancelled/failed approval projection and duplicate receipt protection passed. Four isolated runs, three drafts and one fixture provider read; disposable schema removed.
- Frontend candidate: `f53326325005d154901e244b52fb522400c51ba9`; semantic Markdown and mounted schema Edit/Save tests pass; `npm run build:cloudflare` passes.
- Local fixtures do not prove live provider behavior or production rollout. Those require separate immutable release evidence.

See [release acceptance](./PROGRESSIVE_HARNESS_ACCEPTANCE.md) for live evidence and remaining rollout limits.
