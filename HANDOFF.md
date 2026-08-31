# Meeting Notes v2 implementation handoff

## Repository state

- Worktree: `C:\Users\AMAR\Documents\ChatGPT\HIVEMIND-meeting-v2`
- Branch: `codex/meeting-lifecycle-v2`
- Pushed backend implementation: `ced23852`
- Pushed journal commit: `ae05531f`
- Frontend worktree branch: `codex/meeting-lifecycle-v2-ui`
- Pushed frontend commit: `b3b63e12369cbb52aa4642eceb2c10da9f5a4ee2`
- Production was not touched.
- Cloudflare resources and Flagship were not mutated.

## Completed and verified

1. Additive Meeting Notes v2 schema, policy/notice/participant/authorization
   records, checkpoints, artifact receipts, outbox, restrictions, DSAR and
   deletion receipts.
2. Fail-closed, latched `meeting_lifecycle_v2` modes:
   `off|shadow|consent|workflow|full`.
3. Gateway-required v2 processing with Gateway payload logging and caching
   suppressed.
4. EU-jurisdiction local R2, identifier-only audio/email Queues and deterministic
   finalization Workflow.
5. Participant invitation-fragment exchange, OTP, append-only decision receipt,
   withdrawal restriction, late-participant pause and authorization snapshots.
6. Transactional invitation, OTP, confirmation, decline, withdrawal and ready
   emails through the canonical email/platform-notification path.
7. Public authorization page, privacy policy editor and recorder integration.
8. BYOD/hybrid v2 fails closed instead of silently using central storage.

### Pasted verification output

```text
> npx prisma validate
Prisma schema loaded from prisma\schema.prisma
The schema at prisma\schema.prisma is valid

> node --test tests/unit/meeting*.test.js
tests 38
pass 38
fail 0

> npm run check  # workers/meeting-lifecycle
Generating project types...
Types written to worker-configuration.d.ts
TypeScript exit 0

> npm test  # workers/meeting-lifecycle
Test Files  1 passed (1)
Tests  6 passed (6)

> npm run dry-run
env.MEETING_WORKFLOW (MeetingFinalizationWorkflow) Workflow
env.AUDIO_QUEUE (hivemind-meeting-audio-local) Queue
env.EMAIL_QUEUE (hivemind-meeting-email-local) Queue
env.AUDIO (hivemind-meeting-audio-local-eu (eu)) R2 Bucket
env.FLAGS (...) Flagship
--dry-run: exiting now.

> npm run build  # frontend/Da-vinci
Compiled successfully.
```

## Current step

Build equivalent functional Meeting Notes v2 endpoints in the embedded/BYOD
tenant agent and route Core's policy, session, authorization, checkpoint,
artifact and rights operations through those endpoints. The additive tenant
schema is already in `core/src/vector/mneme/embedded-agent.mjs`; only functional
v2 parity is missing. Core's deliberate fail-closed guard is at
`core/src/server.js` near the meeting session admission block containing
`remote_meeting_v2_agent_upgrade_required`.

## Unmet acceptance criteria

1. BYOD/hybrid agent functional parity for policy, authorization, durable
   checkpoints, artifact receipts, publication receipts and DSAR state.
2. Durable rights executor traversing audio, transcript segments, meeting,
   insights, canonical documents/evidence, memories, entity/claim/relationship
   projections, vectors, notifications and Gateway log identifiers. Current
   `erase` immediately restricts and creates a pending DSAR only.
3. Reminder, recovered-processing and DSAR-status notification triggers (the
   templates and durable dispatch infrastructure exist).
4. Isolated live PostgreSQL migration test and complete local
   Worker/Queue/Workflow/R2/email runtime test with termination and replay.
5. Managed, embedded, hybrid and BYOD semantic-count/citation parity.
6. Integration into `singulance-local` and shared preview rebuild. The permanent
   worktree currently has unrelated modifications:

```text
 M core/data/mcp-connectors.json
 M docker-compose.local-stack.yml
```

   Per `docs/LOCAL_INTEGRATION_PROTOCOL.md`, do not clean, stash, overwrite,
   merge, or rebuild there until its owner resolves those edits.
7. Agent Memory record. The required MCP tools were not callable in this
   session; Git, the decision document and engineering journal were updated.

## Decisions

- Ambiguity: allow active v2 for BYOD using central control state, or block it.
  Selected reversible default: block with
  `remote_meeting_v2_agent_upgrade_required`; residency is more important than
  partial functionality.
- Ambiguity: treat an erasure request as immediate broad deletion, or restrict
  first and await an auditable traversal. Selected reversible default: restrict
  processing/publication immediately and leave the request pending until the
  executor can verify every authoritative store.
- Ambiguity: deploy local Cloudflare resources before shared runtime acceptance.
  Selected reversible default: dry-run only. No remote resource mutation.
- Ambiguity: integrate despite unrelated dirty files in the permanent worktree.
  Selected reversible default: do not touch them and do not integrate.

## Exact next action

Implement `/v1/meeting-v2-control` in `core/src/vector/mneme/embedded-agent.mjs`, add typed remote-backend/driver wrappers, and replace the remote v2 fail-closed guard only after policy/session/authorization/checkpoint parity tests pass.
