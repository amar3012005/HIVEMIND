# Durable GDPR-Ready Meeting Notes v2

## Status

Local implementation candidate on `codex/meeting-lifecycle-v2`. The feature is
additive and defaults to `off`. It has not been integrated into
`singulance-local`, deployed to Cloudflare, migrated into a shared database, or
released to production.

This is a technical enforcement design, not a legal certification. A controller
must approve the lawful basis, notice, recording jurisdiction, processor list,
retention, RoPA and DPIA before an active policy can admit a v2 session.

## Feature boundary

Flagship flag `meeting_lifecycle_v2` has five latched modes:

- `off`: byte-compatible legacy admission.
- `shadow`: policy evaluation only; no v2 persistence.
- `consent`: participant authorization with authorized legacy processing.
- `workflow`: authorization plus durable audio/finalization; publication off.
- `full`: authorized canonical publication after reconciliation.

Admission also requires `MEETING_LIFECYCLE_V2_ENABLED=true`,
`CLOUDFLARE_AI_GATEWAY_ENABLED=true`, and
`MEETING_AI_GATEWAY_REQUIRED=true`. Failure is closed. BYOD/hybrid tenants are
explicitly rejected in any active v2 mode until their tenant agent advertises
and implements the v2 lifecycle; Core never redirects their content into
central storage.

## Authority and data movement

- PostgreSQL owns policy, participant, authorization, checkpoint, outbox,
  restriction and deletion-receipt state.
- EU-jurisdiction R2 owns temporary managed audio in `workflow` and `full`.
- Queue and Workflow messages contain opaque IDs and version/mode metadata only.
- The Workflow uses `meeting-{session_id}-v2`, resumes from verified PostgreSQL
  checkpoints, publishes only in latched `full`, reconciles, deletes raw audio,
  and records deletion receipts.
- AI traffic is Gateway-only for v2. Payload logging and caching are explicitly
  disabled. Provider fallback remains behind the same Gateway.
- Voiceprints, speaker identification, emotion inference and biometric calls
  are outside the v2 lifecycle.

## Authorization lifecycle

The organizer supplies participant email addresses before browser capture.
Every required participant receives a notice link whose secret is in the URL
fragment, exchanges it for a short-lived email OTP, and records an append-only
accepted or declined receipt. Recording starts only from authoritative
`READY_TO_RECORD`. Adding a participant pauses an active recording and invalidates
the authorization snapshot until the new participant decides. Recording,
transcription and optional canonical-memory publication are separate purposes.

Invitation, OTP, confirmation, decline, withdrawal and ready notifications use
one PostgreSQL outbox -> Cloudflare Email Queue -> canonical email and platform
notification path. Queue messages contain only IDs. OTP is encrypted at rest
and removed from the completed outbox payload. Delivery is never authorization.

## Public compatibility

Existing meeting routes and legacy semantics remain present. V2 adds optional
status fields and the following routes:

- `GET/PUT /api/meeting-policies/current`
- `POST /api/meetings/sessions`
- `POST /api/meetings/sessions/:id/participants`
- `POST /api/meetings/sessions/:id/invitations`
- `GET /api/meetings/sessions/:id/authorizations`
- `POST /api/meetings/sessions/:id/start|pause|finalize|cancel|restrict|erase`
- `/v1/public/meeting-authorizations/*` for exchange, OTP, decision and withdrawal

The public page has route-specific `no-store`, `no-referrer`, CSP,
`frame-ancestors 'none'`, and no third-party script permission.

## Local resources

- Worker: `hivemind-meeting-lifecycle-local`
- Workflow: `hivemind-meeting-finalization-local`
- Queues: `hivemind-meeting-audio-local`, `hivemind-meeting-email-local`
- DLQs: matching `-dlq-local` resources
- R2: `hivemind-meeting-audio-local-eu` with `jurisdiction: "eu"`
- Wrangler persistence: `P:\HIVEMIND\wrangler\meeting-lifecycle`

No secret is committed. `MEETING_LIFECYCLE_SECRET` and
`CLOUDFLARE_MEETING_LIFECYCLE_SECRET` must hold the same generated service
secret in Worker and Core respectively. `MEETING_INVITATION_ENCRYPTION_KEY`
must be independently generated and at least 32 characters.

## Verified in the session worktree

- Prisma schema validation.
- Core syntax and 38 focused meeting tests.
- Worker TypeScript check and 6 contract tests.
- Wrangler generated binding types and local dry-run with Workflow, Queues,
  Flagship and EU R2 bindings.
- Optimized Da-vinci production build.

## Required before local acceptance

1. Implement equivalent v2 policy/authorization/checkpoint/artifact/right APIs
   in the tenant agent, then remove the deliberate BYOD fail-closed response.
2. Complete the durable rights executor that traverses meeting artifacts,
   canonical documents/memories/entities/claims/relationships/vectors and
   produces verified deletion or restriction receipts. The current `erase`
   route only restricts immediately and creates a pending request.
3. Exercise the migration and full lifecycle against an isolated PostgreSQL,
   R2/Queue/Workflow local runtime and mail sandbox, including termination and
   replay at every stage.
4. Complete controller legal/privacy configuration and verify that every model
   and subprocessor used by the canonical publication path is approved.
5. Integrate only through a clean permanent `HIVEMIND-local-main`, rebuild the
   shared preview there, and record runtime evidence before updating
   `singulance-local`.

## Local full-mode activation — 2026-08-31

The operator explicitly enabled the candidate for every local identity. The
Flagship default remains `off`; one targeting rule serves `full` only when
`environment=local`. Production and contexts without the local attribute still
resolve to `off`.

The isolated local Worker, Workflow, audio/email Queues and DLQs, EU R2 bucket,
and Worker service secret are provisioned. Live Worker `/mode` evaluation
returned `full`. The shared local Core container was not recreated because the
permanent integration worktree contained unrelated uncommitted work. Therefore
this is a Cloudflare-local activation and configured next-start default, not a
claim that the current shared browser stack has already loaded the new Core
code or environment.
