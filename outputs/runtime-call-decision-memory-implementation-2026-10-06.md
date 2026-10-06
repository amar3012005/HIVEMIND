# Runtime decision memory and Start Call

## Implemented in source

- `user_agenda`: dated, user-confirmed goals, priorities and constraints.
- `uncertainty`: evidence-backed questions, decision impact, priority and resolution state.
- Two Runtime-only scoped tools, `runtime_user_agenda` and `runtime_uncertainties`, support saving and query-free filtered retrieval through the existing private operating-memory store.
- Backend access requires active membership, signed Runtime actor claims and persisted root HQ session ownership. Ordinary memory recall excludes the new kinds. Records and revisions remain organization- and user-scoped.
- Agenda saves cite actual direct user events or saved same-room calls containing user speech. Provenance does not itself verify the meaning of every claim; Runtime instructions require explicit user confirmation.
- Updates retain immutable dated history. Supersession uses exact receipt IDs; transactions and a unique successor index reject stale branches.
- Start Call retrieves open uncertainties first and current confirmed agenda records next, before voice admission. Retrieved records are compacted independently of old transcripts. Unavailable reads fail admission rather than pretending there are no questions.
- The Runtime prompt prioritizes relevant unresolved decisions, asks one question at a time and preserves user redirection.
- Both voice provider paths queue the existing native follow-up after saving a Runtime call. It reconciles actual answers, preserves unanswered/interrupted topics and checks save receipts.
- Employee voice behavior remains employee-specific. No new schedule, agent loop or company-memory publication is introduced.

## Source locations

Core worktree: `/private/tmp/hivemind-runtime-call-memory-20261006`

- `core/src/hyperagents/operating-memory.js`
- `core/src/routes/harness-chat.js`
- `core/prisma/migrations/20261006190000_runtime_decision_memory/migration.sql`

Harness worktree: `/private/tmp/harness-runtime-call-memory-20261006`

- `packages/hivemind/runtime/src/runtime-decision-memory.ts`
- `packages/hivemind/runtime/src/index.ts`
- `packages/hivemind/web-runner/src/live-voice.ts`
- `packages/hivemind/web-runner/src/runtime-voice.ts`
- `packages/preset/agent-presets/presets/hivemind-hq/agent.cordis.yml`
- Runtime and web-runner READMEs.

## Validation and release boundary

Core JavaScript syntax checks and whitespace checks passed. The Runtime and web-runner TypeScript project builds passed. No behavioral tests or production calls were run for this change.

This feature is not deployed. Activation requires the additive database constraint/index migration, the updated authenticated Core/Control API, then a compatible runner release. Production verification must cover employee access rejection, a delayed call with changed priorities, actual answer reconciliation, interruption/replay, and unavailable memory. No historical agenda or uncertainty records are fabricated or backfilled.
