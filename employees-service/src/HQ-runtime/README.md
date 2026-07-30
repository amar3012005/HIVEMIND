# SINGULANCE HQ Runtime: Production Handoff

This document is the canonical implementation handoff for the SINGULANCE HQ
Runtime. Read it before changing Runtime behavior. It exists so a new engineer
or coding agent can begin from the current architecture instead of rediscovering
the system through broad repository searches.

## Product Goal

After onboarding, a customer should feel that a durable company intelligence
has been given a company, memory, authority, and responsibility. Runtime reads
the current company, chooses bounded work, calls versioned skills and tools,
delegates specialist Work Orders, verifies results, records decisions, schedules
the next useful checkpoint, and sleeps without keeping an LLM process alive.

Runtime is not a chatbot pretending to be autonomous. Every visible decision,
dependency, todo, wake, and checkpoint is persisted. Models may reason inside a
bounded operation, but PostgreSQL and deterministic Core code own state,
authorization, idempotency, scheduling, and auditability.

The user experience is:

1. Onboarding creates the company profile, team, HQ room, and initial Runtime.
2. Five seconds after the completed company dashboard appears, a one-time
   invitation offers the new **Runtime** feature.
3. `RUN` opens a preference board for SEO, social campaigns, marketing,
   outreach, client/revenue work, legal and finance, or fundraising.
4. `WAKE ME UP` persists those choices as an HQ instruction and schedules a
   `user_first_activation` wake.
5. The app enters `/hivemind/app/employees/runtime`, which renders the permanent
   Company HQ room as the Runtime console.
6. Runtime speaks through persisted events, loads only the needed skill/tool,
   creates durable todos, delegates bounded work, and reports why it sleeps.

## Non-Negotiable Architecture

The operating cycle is:

`WAKE -> LOAD CONTEXT -> OBSERVE -> DECIDE -> QUEUE -> DELEGATE -> VERIFY -> RECORD -> SCHEDULE -> SLEEP`

- Core is the control plane and source of orchestration truth.
- PostgreSQL is the durable execution state and checkpoint store.
- Company Rooms are specialist executors, not company-wide priority owners.
- HQ is the only layer allowed to change the company-wide Growth Stage.
- Skills are descriptor-first and loaded only for the selected decision.
- Toolkits expose governed capabilities; they do not own tenant identity.
- Organization and user identity are injected server-side.
- External writes continue to honor organization authority and approval policy.
- User-visible activity is built from `HqRuntimeEvent` rows. Never expose hidden
  chain-of-thought and never fabricate frontend-only agent activity.
- Sleeping means no model is running. A durable schedule or material event wakes
  Runtime later.
- Do not introduce a second persistence graph such as LangGraph while this
  native runtime owns checkpoints. A migration to another engine requires one
  authoritative state store, not dual state machines.

## Runtime Behavior Already Built

### Immediate release gate

- The Runtime implementation is currently authored in `/root/hivemind-main`.
  Treat that tree as the only source for build, review, commit, and release.
  `/root/hivemind` is the Compose/run tree and contains only the Runtime policy
  documents; it is not an alternative implementation tree.
- Runtime source, migrations, policy assets, and tests must be committed as one
  reviewed change before another production image is built. A live untracked
  subsystem has no reliable rollback or provenance.
- The `work_result` cycle has a regression test in
  `core/tests/unit/hq-native-engine.test.js`. It must remain in the focused
  Runtime suite: specialist results are the path that closes a delegated todo.

### Company birth and activation

- Onboarding calls `activateHqAfterOnboarding` and creates an idempotent
  `onboarding_complete` schedule.
- The first awakening acknowledges that there was no company to operate before
  onboarding and reads the new company before choosing work.
- The Runtime invitation creates a separate `user_first_activation` wake with
  the user's selected operating priorities.
- Re-onboarding clears old instructions, todos, capability requests, cycles,
  events, schedules, and active HQ Work Orders so one company cannot inherit
  another company's state.

### Instructions and todos

- Standing instructions are retained in `hq_instructions`.
- The instruction interpreter creates ordered `hq_todos`.
- Outreach instructions detect an explicit location such as `in Hannover`; if
  omitted, they inherit the retained company profile location.
- New instructions extend the active operating plan. They do not erase valid
  history, completed work, or active Growth Stages.
- The queue finishes bounded work one item at a time and links delegated Work
  Orders back to their source todo.

### Capability dependencies

- A todo can declare required connectors such as `google-maps` and `gmail`.
- Missing access moves only that todo to `WAITING_FOR_CONNECTOR`.
- `hq_capability_requests` stores the provider, reason, and exact connect path.
- The Runtime console presents an inline modal, opens the connector flow, polls
  authoritative organization connector status, and schedules
  `connector_changed` when access becomes available.
- Runtime records `capability_resolved`, restores the todo to `READY`, and
  continues without rebuilding the Growth Plan.

### Governed sleeping

Before sleeping, Runtime states:

- what assigned work is complete or currently owned;
- whether material evidence changed;
- why the current stage needs its observation interval;
- which metrics will be compared;
- the exact next checkpoint; and
- which campaign result, connector failure, specialist result, instruction, or
  material performance event can wake it earlier.

A manual wake without changed evidence emits **No material change detected**
and preserves the existing checkpoint instead of replaying monitor activity as
new work.

### Runtime interface

- The center surface is conversational, similar to the existing Overview chat
  grammar, not a connected-stage dashboard.
- Skill/tool events use compact connected timeline elements.
- Decisions and summaries use readable conversation blocks.
- Input and output token totals appear in the Runtime header.
- The right rail shows durable state, active work, checkpoints, todos, and
  capability dependencies rather than Room participants.
- A persistent composer accepts standing company instructions.
- Runtime is a dedicated top-level item in the HyperAgents sidebar; the same HQ
  room is not duplicated in the Company Rooms list.

## Source Map

### HQ-owned policy assets

- `employees-service/src/HQ-runtime/README.md`
  This handoff and operational ground truth.
- `instructions/director.md`
  Stable decision authority, queue, dependency, and sleep policy.
- `instructions/persona.md`
  Concise awake-intelligence voice. Persona never replaces factual event data.
- `skills/registry.json`
  HQ-only skill descriptors and model policies.
- `skills/baseline-establishment.md`
  Establish or refresh the factual company baseline.
- `skills/company-state-diagnosis.md`
  Read retained state and choose the relevant business condition.
- `skills/evidence-sufficiency.md`
  Decide whether evidence supports action.
- `skills/growth-constraint-diagnosis.md`
  Find the highest-leverage evidenced constraint.
- `skills/growth-stage-planning.md`
  Create one bounded stage with metrics and stop conditions.
- `skills/work-order-delegation.md`
  Produce a measurable specialist result contract.
- `skills/stage-review.md`
  Compare returned evidence with the active decision rule.
- `skills/performance-diagnostics.md`
  Explain measured movement without invented causality.
- `skills/memory-promotion.md`
  Promote verified outcomes into compact company memory.
- `skills/blocker-resolution.md`
  Resolve policy, access, evidence, or execution blockers.
- `skills/primary-outreach.md`
  Location-grounded client acquisition using company evidence, existing leads,
  Maps discovery, and governed Gmail activity.
- `toolkits/registry.json`
  HQ-visible capability descriptors and authority classes.
- `journal/phase-*.md`
  Append-only implementation history. Add one journal entry for every completed
  Runtime phase; do not rewrite old phases.

### Core runtime

- `core/src/hq-runtime/repository.js`
  Runtime creation, onboarding activation, company reset, transitions, events,
  cycles, schedules, and database leases.
- `core/src/hq-runtime/contracts.js`
  State transition rules, authority normalization, result contracts, and event
  type vocabulary.
- `core/src/hq-runtime/context.js`
  Compact company, baseline, Growth Plan, stage, journal, pending work, and live
  trigger context. This intentionally exposes the retained company object for
  location-aware instruction interpretation.
- `core/src/hq-runtime/instruction-loop.js`
  Instruction interpretation, todo creation, connector discovery, capability
  requests, and connector-resolution reconciliation.
- `core/src/hq-runtime/native-engine.js`
  Deterministic operating cycle and user-visible event production.
- `core/src/hq-runtime/schedule-store.js`
  Durable due-work leasing.
- `core/src/hq-runtime/scheduler.js`
  Lightweight event loop that claims due schedules; no always-running LLM.
- `core/src/hq-runtime/skill-registry.js`
  Loads HQ descriptors and skill bodies from `HQ_RUNTIME_ASSET_DIR`.
- `core/src/hq-runtime/work-dispatcher.js`
  Dispatches bounded Work Orders and records terminal specialist results.
- `core/src/hq-runtime/routes.js`
  Tenant-scoped Runtime APIs, event stream, launch, instructions, work state,
  capability recheck, pause/resume, and resources.
- `core/src/control-plane-server.js`
  Mounts Runtime routes and activates/resets Runtime during onboarding.

### Durable data

- `core/prisma/schema.prisma`
  Models include `HqRuntime`, `HqCycle`, `HqRuntimeEvent`, `HqSchedule`,
  `HqInstruction`, `HqTodo`, `HqCapabilityRequest`, and links from Work Orders.
- `core/prisma/migrations/20260730233000_hq_instruction_loop/migration.sql`
  Idempotent manual SQL for instructions, todos, and capability requests.
- Earlier HQ migrations in `core/prisma/migrations/` own the base runtime,
  cycles, event stream, and Work Order linkage.

### Frontend

- `frontend/Da-vinci/src/components/hivemind/app/pages/HyperAgents.jsx`
  URL/view-mode routing, Runtime sidebar item, permanent HQ Room selection, and
  `/employees/runtime` rendering.
- `frontend/Da-vinci/src/components/hivemind/app/hyperagents/CompanyDashboard.jsx`
  Five-second one-time Runtime invitation, focus board, `WAKE ME UP`, and launch
  handoff.
- `frontend/Da-vinci/src/components/hivemind/app/hyperagents/HqRuntimeConsole.jsx`
  Conversation stream, tokens, standing-instruction composer, controls, right
  rail, capability modal, connector polling, and automatic recheck.
- `frontend/Da-vinci/src/components/hivemind/app/shared/api-client.js`
  Browser client for `/v1/hq/*` endpoints.
- `frontend/Da-vinci/src/components/hivemind/app/pages/Connectors.jsx`
  Consumes `?connect=<provider>`, starts native Google OAuth directly, and
  focuses popup-based providers for one-click continuation.
- `frontend/Da-vinci/src/components/hivemind/app/HiveMindApp.jsx`
  The `employees/*` wildcard owns My Company, Runtime, Rooms, Leads, Campaigns,
  and roster routes.

### Tests and visual evidence

- `core/tests/unit/hq-instruction-loop.test.js`
  Explicit and inherited location plus connector requirements.
- `core/tests/unit/hq-repository-lifecycle.test.js`
  Onboarding activation and company replacement cleanup.
- Other `core/tests/unit/hq-*.test.js`
  Transitions, contracts, schedule leases, registry, dispatch, and replay
  protection.
- `/root/hivemind/artifacts/hq-conversation-visual-canary.cjs`
  Authenticated API-fixture visual canary for desktop/mobile Runtime UI.
- `/root/hivemind/artifacts/hq-instruction-loop-desktop.png`
- `/root/hivemind/artifacts/hq-instruction-loop-mobile.png`

## HTTP API

All routes require tenant-scoped authenticated privileged access.

- `GET /v1/hq/runtime`: runtime state and aggregate input/output tokens.
- `POST /v1/hq/activate`: activate an existing objective.
- `POST /v1/hq/launch`: persist invitation preferences and schedule the first
  user activation.
- `POST /v1/hq/pause`: stop new cycles while preserving state.
- `POST /v1/hq/resume`: resume from the durable checkpoint.
- `POST /v1/hq/wake`: manual event-driven wake.
- `POST /v1/hq/objective`: update the global Runtime objective.
- `GET /v1/hq/events`: persisted event history.
- `GET /v1/hq/events/stream`: SSE delivery of persisted events.
- `GET /v1/hq/work`: Work Orders, schedules, todos, capability requests, and
  instructions.
- `POST /v1/hq/instructions`: add a standing instruction and wake Runtime.
- `POST /v1/hq/capabilities/recheck`: re-evaluate connector dependencies.
- `GET /v1/hq/resources`: baseline, Growth Plan, and Growth Journal references.

Do not place OAuth credentials, provider access tokens, tenant IDs supplied by
models, or hidden reasoning in these responses.

## Adding A Runtime Feature

1. Decide whether the feature is a deterministic Core transition, a skill, a
   toolkit, or a specialist Work Order. Do not put all behavior in a prompt.
2. Add the smallest descriptor to the HQ registry. Do not load every skill into
   every wake.
3. Add durable state only when the decision must survive a restart.
4. Add additive, idempotent SQL and matching Prisma models.
5. Keep tenant identity server-injected.
6. Add an explicit event type and user-safe event copy when the action must be
   visible.
7. For missing access, create a capability request and pause only the dependent
   todo.
8. For external consequences, enforce the existing authority/approval policy.
9. Add unit coverage for transitions, idempotency, tenant boundaries, and
   interruption/resumption.
10. Build and visually inspect desktop and mobile production bundles.
11. Append a journal phase with the behavioral contract and deployment image.

## Local Verification

Generate Prisma client from the Core directory when the schema changes. Do not
run `prisma migrate deploy` in production.

Run the focused Runtime suite with HQ policy assets mounted:

```bash
docker run --rm \
  -e HQ_RUNTIME_ASSET_DIR=/assets \
  -v /root/hivemind-main/core:/app \
  -v /root/hivemind-main/employees-service/src/HQ-runtime:/assets:ro \
  -w /app node:20-slim \
  sh -lc 'node --test tests/unit/hq-*.test.js tests/unit/growth-plan-toolkit.test.js'
```

Build the actual product frontend, not a marketing frontend:

```bash
docker build \
  -t hivemind/fe:prod-YYYYMMDD-runtime-description \
  -f frontend/Da-vinci/Dockerfile \
  frontend/Da-vinci
```

Build Core and employee images from `/root/hivemind-main` using their existing
Dockerfiles. Treat dependency warnings as findings and distinguish existing
warnings from regressions.

Run the Playwright canary against the production bundle:

```bash
docker cp /root/hivemind/artifacts/hq-conversation-visual-canary.cjs \
  hm-playwright:/app/hq-conversation-visual-canary.cjs
docker exec hm-playwright mkdir -p /artifacts
docker exec hm-playwright node /app/hq-conversation-visual-canary.cjs
```

Copy screenshots back and inspect them with vision. Passing assertions alone is
not visual acceptance. Verify modal fit, readable hierarchy, sticky composer,
right rail, no overlap, and no horizontal overflow at desktop and mobile sizes.

## Production Build And Deployment

### Ground truth

- Canonical source: `/root/hivemind-main`
- Compose working directory: `/root/hivemind`
- Environment file: `/root/hivemind/.env`
- Product frontend container: `hivemind-next-frontend-1`
- Runtime overlay: `/root/hivemind/release-overlays/hq-runtime-v1/compose.override.yml`
- Frontend Compose file: `/root/hivemind/infra/docker-compose.frontend.yml`
- Main production Compose file:
  `/root/hivemind/infra/docker-compose.hetzner.yml`

Never build production from `/root/hivemind-next`.

### Image policy

Use immutable descriptive production tags. The Compose files must point to the
exact current tag. Keep only two operational generations per affected service:

- current: the image pinned by Compose;
- stable rollback: the last production-verified image.

If an external workflow requires a `:latest` alias, assign it only after the
immutable image passes tests and visual verification:

```bash
docker tag hivemind/control-plane:prod-YYYYMMDD-runtime-description hivemind/control-plane:latest
docker tag hivemind/employees:prod-YYYYMMDD-runtime-description hivemind/employees:latest
docker tag hivemind/fe:prod-YYYYMMDD-runtime-description hivemind/fe:latest
```

Production Compose should remain pinned to immutable tags, not `:latest`, so a
rollback is deterministic.

### Database

1. Take a schema backup.
2. Review the SQL migration.
3. Apply the named SQL manually against `hm-postgres`.
4. Verify expected tables/indexes with `to_regclass` or catalog queries.
5. Never run `prisma migrate deploy` on this production stack.

### Bounded deployment

Update only the affected image tags in the Runtime overlay/frontend Compose
file. Dry-run named services first:

```bash
docker compose --dry-run \
  --env-file /root/hivemind/.env \
  -f /root/hivemind/infra/docker-compose.hetzner.yml \
  -f /root/hivemind/release-overlays/hq-runtime-v1/compose.override.yml \
  up -d --no-deps control-plane employees
```

Then deploy the same named services without `--dry-run`. Deploy the product
frontend separately:

```bash
docker compose --dry-run \
  --env-file /root/hivemind/.env \
  -f /root/hivemind/infra/docker-compose.frontend.yml \
  up -d --no-deps frontend
```

Never run bare `docker compose up`, `docker compose down`, destructive Git
commands, or broad container recreation.

### Production acceptance

- `hm-control` and `hm-employees` are healthy.
- `hivemind-next-frontend-1` runs the intended immutable image.
- Unauthenticated `/v1/hq/runtime` and Runtime writes return `401`, proving the
  route exists and is auth-gated.
- Recent logs contain no Runtime request, scheduler, Prisma, or frontend errors.
- Signed-in Runtime streams persisted events.
- Desktop and mobile Playwright canaries pass and screenshots are inspected.
- A real test organization can add an instruction, pause for a connector,
  connect it, resume the same todo, and produce a meaningful sleep explanation.

## Protected Scope And Things Not To Do

- Do not overwrite unrelated dirty-worktree changes.
- Do not touch Deepgram, TARA Grok, `/voice2`, or their containers while working
  on HQ Runtime unless the task explicitly requires it.
- Do not treat `hm-fe` as the product frontend ground truth.
- Do not create a second HQ room for Runtime; Runtime is the permanent Company
  HQ room rendered through a dedicated route.
- Do not use generic HyperAgents gather/debate/report orchestration for every HQ
  wake. HQ uses deterministic routing and bounded specialist delegation.
- Do not replay full Room history into every cycle. Use durable Runtime state,
  compact journals, current baseline, latest relevant plan, and result packets.
- Do not fabricate progress, connector status, analytics, or agent messages.
- Do not let an LLM choose tenant identity, bypass approval, mutate budgets, or
  silently perform an external write.
- Do not keep a model process running while Runtime is sleeping.
- Do not repair a missing semantic result by regenerating an entire plan. Return
  a bounded failure/result packet and let HQ choose the next action.

## Current Known Build Warning

The employee image currently reports an existing dependency conflict: the
installed `litellm` version requests newer `httpx` and `openai` packages than
the employee package pins. This was not introduced by Runtime, but it should be
resolved deliberately in a dedicated dependency change rather than hidden in an
unrelated feature deployment.
