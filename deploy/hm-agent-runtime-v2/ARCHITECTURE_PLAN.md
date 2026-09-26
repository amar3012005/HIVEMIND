# AgentScope + HIVE-MIND architecture and completion plan

This document separates current source behavior from verified release behavior
and future work. “Implemented in source” is not equivalent to “accepted in a
deployed preview.” Check exact image SHA and browser canaries before claiming
runtime acceptance.

## System boundary

```text
Da-vinci frontend (frontend/Da-vinci)
  │ authenticated WorkRun create / user turns / Core SSE subscription
  ▼
HIVE-MIND Core control plane (core/)
  ├─ principal, tenant, policy, approvals
  ├─ WorkRun + durable event/checkpoint records (PostgreSQL)
  ├─ direct-answer vs company-work admission and context projection
  ├─ selected playbook/version and workrun dispatch
  └─ normalized, deduplicated browser-facing event stream
  │ POST /workrun/ and internal event sink
  ▼
AgentScope runtime (deploy/hm-agent-runtime-v2)
  ├─ native AgentScope service, agent/session/chat, Redis storage + message bus
  ├─ isolated/configured workspace and native tools/task/schedule facilities
  ├─ HIVE context, memory, playbook, artifact, and completion tools
  └─ hm_bridge tails AgentScope session SSE → posts events back to Core
  ▼
Da-vinci transcript / task list / tool detail / artifact preview
```

Identity must remain stable across WorkRun, AgentScope session, agent, turn,
workspace, and forwarded event. Core remains authority for durable lifecycle,
tenant/policy decisions, browser stream, and artifact completion. AgentScope
owns execution sessions and framework event generation. Runtime Redis is
AgentScope's operational storage/bus and WorkRun binding index; it does not
replace Core PostgreSQL. HIVEMIND remains semantic company memory, not the
workflow checkpoint database.

The native Cordis/DeepSeek Harness is a separate implementation and codebase.
AgentScope is the WorkRun execution runtime here; it must not silently supplant
native Harness chat or unrelated HM Rooms paths.

## Turn and context flow

1. UI submits a user message to Core; Core persists the message/run event before
   dispatch and returns the durable WorkRun identity.
2. Core resolves caller, company, policy, selected run configuration, and the
   smallest useful context projection. Direct conversational requests should
   avoid company-wide context, playbook loading, and task creation.
3. For company work, Director/router selects a versioned playbook. Runtime
   receives the selected identity/version and a compact scope; it must not
   invent an alternative playbook.
4. AgentScope creates/reuses the bound agent/session/workspace, dispatches chat,
   and emits session events over its native message bus/SSE.
5. `hm_bridge.py` tails SSE and sends normalized event envelopes to Core. Core
   persists/deduplicates them and publishes WorkRun SSE to the browser.
6. UI updates stable turn/tool/task/artifact identities in place. A model turn
   finishing does not imply the durable WorkRun ended. Core's terminal state
   controls composer idle/stop behavior.
7. For deliverables, runtime tools write/register artifacts through HIVE; Core
   validates persisted references and playbook predicates before terminal
   completion. Prose alone is not evidence.

Progressive context target:

| Layer | Load when | Content |
| --- | --- | --- |
| Base | Every turn | System policy, identity/tenant, current user message, minimal run state |
| Recent | Relevant | Recent turn summary, active task state, selected artifacts/references |
| Company | Company task | Compact company brief and only relevant memory results |
| Playbook | Company task after selection | Exact immutable playbook id/version and active stage/check requirements |
| On demand | Needed by current step | Skill instructions, files, web evidence, connected-app records, tool results |
| Compaction | Context budget requires | Structured completed-turn summary, durable task/artifact/source references |

Do not inject every playbook, all company memory, every file, or full transcript
on every turn. Tool-loaded evidence should retain source references and tenant
scope.

## Current source inventory

| Capability | Source status | Acceptance still needed |
| --- | --- | --- |
| AgentScope service, Redis storage/message bus, SSE | Wired in `app.py`; AgentScope pinned in requirements | Confirm exact preview image and live stream behavior |
| Core auth adapter | `hm_auth.py` supports internal identity and bearer verification; dev auth is gated | Exercise valid/invalid principals against deployed preview; verify tenant isolation |
| WorkRun binding | `POST /workrun/`, lookup, cancel, delete, Redis binding/idempotency in `app.py`/`hm_bridge.py` | Failure/restart/reconnect canaries against exact deployed build |
| Event forwarding | Bridge tails AgentScope SSE and posts WorkRun event envelopes to Core | Prove first deltas visible without refresh, ordering, replay dedupe, and completion |
| Direct vs company-work prompt policy | Prompt in `app.py` distinguishes compact direct answers from playbook/task company work | Behavioral tests for direct answer and representative company task |
| Playbook and task tools | Runtime exposes HIVE playbook/artifact/completion tools; AgentScope native task tools are available | Prove Director-selected version, plan progression, persisted artifacts, predicate verdict |
| Artifact pipeline | Tool code supports artifact operations/registration | Validate persisted artifact appears in Core and Da-vinci Artifacts preview |
| Workspace selection | `workspace_backend.py` supports configured backends | Validate chosen backend isolation, persistence, and multi-node behavior |
| Schedules | AgentScope scheduler/tools can be enabled | HIVE Routine product lifecycle and single-owner semantics are not established by scheduler availability |
| Computer use | Workspace backend options exist; separate E2B work has replay-safety changes | Generic bounded computer contract, semantic verification, takeover/resume, and integrated acceptance remain |
| Telemetry | Runtime/bridge logs and counters exist | Durable per-turn milestone telemetry and attribution still need implementation/acceptance |

This table describes source evidence, not a claim that current preview is healthy.

## Ordered build plan

Do not skip gates or mark a phase complete from generated prose. Persisted ids,
source receipts, predicate verdicts, and browser-visible events are evidence.

### Phase 0 — establish reproducible baseline

- Record source SHA, AgentScope package version, runtime image digest, Core
  version, FE build, environment/route, and current canary output.
- Trace one request through Core dispatch, runtime logs, AgentScope session SSE,
  bridge POST, Core event persistence, Core SSE, and browser rendering.
- Add a simple direct-answer canary and a company-work canary. Keep production
  untouched during preview diagnosis.
- **Gate:** exact image and route known; request reaches expected runtime; one
  event is visible without refresh or blocker is localized to a specific hop.

### Phase 1 — reliable streaming and replay

- Emit and persist milestones: submit, acknowledgement, first status/thinking,
  first tool, first answer delta, completion/failure/cancel.
- Carry stable event id/sequence and WorkRun/session/turn/tool identities across
  the bridge. Deduplicate replay in Core and render updates in existing blocks.
- Ensure frontend uses Core's streaming response without buffering; preserve
  partial chunks and distinguish historical replay from an active turn.
- Make Stop cancel the active turn while leaving reusable WorkRun lifecycle
  semantics intact. Restore composer to Send on terminal turn state.
- **Gate:** repeat simple response; reconnect during thinking and tool call;
  prove no missing/duplicate blocks, immediate first visible event, full final
  answer, and working Stop.

### Phase 2 — generic AgentScope playbook executor

Build in this sequence, consistent with repository AgentScope contract:

1. Versioned immutable playbook registry (JSON and database records).
2. Generic predicate engine with bounded, domain-neutral vocabulary.
3. Generic stage executor with pre-execution checkpoint and plain PostgreSQL
   checkpoints; advance only on predicate verdict.
4. Replace keyword routing with Director-selected `playbook_id` and version.
5. Generic adapters exposing `execute`, `verify`, and `monitor`.
6. GreenLeaf Bakery swap test authored as different playbook data; no engine
   code change allowed.
7. Migrate Outreach playbook and verify parity using persisted artifacts and
   provider receipts.
8. Remove superseded hard-coded domain branches only after parity and swap
   gates pass.

Engine code must not branch on company, industry, language, task keywords,
channel, stage names/counts, or artifact domain. Domain behavior belongs in
versioned playbook data and adapter implementations. PostgreSQL owns workflow
state; HIVE-MIND owns semantic memory.

**Gate:** GreenLeaf swap test and Outreach evidence-backed parity pass; stopped,
waiting-authority, waiting-event, repair, and terminal transitions persist and
resume correctly.

### Phase 3 — Routine product layer

- Add Routine CRUD, pause/resume, run-now, schedule history, and safe edit/delete.
- Select one scheduler owner. AgentScope scheduling and HIVE scheduling must not
  both fire the same Routine.
- Each scheduled fire creates a governed HIVE WorkRun with stable idempotency
  key; WorkRun applies tenant scope, playbook, approval policy, event stream,
  and artifact validation.
- External writes remain policy/approval gated; scheduled execution never
  widens authority.
- **Gate:** duplicate delivery creates one WorkRun; pause prevents fire; run-now
  creates one auditable run; approval-required action waits; history links to
  durable WorkRun and evidence.

### Phase 4 — bounded computer capability

- Convert natural-language objective into a bounded contract: allowed domains,
  read/write authority, action/time/cost limits, and required evidence.
- Expose computer execution as a normal governed tool inside the current
  WorkRun; do not make a second scheduler or lifecycle owner.
- Verify semantic target/result, not merely successful navigation or screenshot.
- Support progress, cancellation, reconnect, human-help state, VNC takeover,
  and safe resume with durable run/checkpoint identity.
- **Gate:** read/research, entity disambiguation, draft-only, blocked external
  write, human takeover, reconnect, idempotent replay, and semantic failure
  canaries pass in isolated accounts/sandboxes.

### Phase 5 — telemetry, artifacts, and UI acceptance

- Persist per-turn stage timings and failure attribution (provider, AgentScope,
  bridge, Core, transport, browser) keyed by durable ids.
- Render ordered task graph above composer with persisted task states; render
  tool calls as expandable blocks showing name, input, output, and status.
- Render artifact cards with stable name/id, preview/open/download where
  supported, and source/evidence links. Keep artifact registry authoritative.
- Match HM Rooms visual system to company sidebar; ensure narrow-width layout,
  right preview default/collapse behavior, scroll-follow, thinking collapse on
  completion, and Send/Stop state reflect turn lifecycle.
- **Gate:** canary verifies tasks, tool details, artifact card/content, exact
  usage values when provider supplies them, terminal state, and telemetry after
  reload/reconnect.

### Phase 6 — production hardening (separate release decision)

- PostgreSQL-backed runtime leases/checkpoints where process-local state is
  insufficient; global pool limits and expiry/reclaim semantics.
- Service authentication/TLS, tenant isolation tests, bounded retries, template
  versioning, cost limits, evidence retention, and incident controls.
- Auditable authority policy for login/MFA, send/publish/delete/payment and
  connected-app writes; isolated test accounts before real-account actions.
- **Gate:** threat model, migrations/rollback, load/restart tests, exact immutable
  image, preview canaries, and separate production release approval.

## Non-goals and invariants

- AgentScope is not a replacement for HIVE Core policy/workflow persistence or
  native DeepSeek Harness chat.
- Browser does not connect directly to AgentScope Redis or internal SSE.
- Do not claim “streaming works” from a 200 response, container health, or
  completed transcript after refresh. Measure first visible delta.
- Do not claim company plan completion from a final assistant message. Require
  persisted tasks/artifacts and playbook predicate verdicts.
- Do not run preview changes on production hosts or alter production artifacts
  as part of local development.
