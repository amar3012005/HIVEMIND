# HQ Runtime: Mistakes We Must Not Repeat

Date: 2026-08-02
Status: Living engineering guardrail

This document records mistakes observed while building HQ Runtime, Campaign
Intelligence, Growth Baseline, Room delegation, provider execution, and the
Runtime frontend. It is not a substitute for `FINAL-ARCHITECTURE.md` or
`DECISIONS-AND-FAILURES.md`. It explains how we drifted, what the drift looked
like to users, and what must stop a future change before it ships.

The governing principle is simple:

> Never let narration, UI state, or model confidence get ahead of durable truth.

---

## 1. We Built Visible Experiences Before The Lifecycle Was True

**What happened:** We repeatedly improved banners, progress cards, reports,
countdowns, redirects, and approval modals while the underlying operation could
still be incomplete, misrouted, or uncorrelated.

**Why it failed:** The frontend had to infer business state from loose statuses
and prose. That made a polished screen capable of presenting false progress.

**Rule:** Define the persisted lifecycle, evidence, waiting reason, authority
gate, and terminal outcome before building its projection. Every visible status
must identify the table row or append-only event that proves it.

**Stop signal:** A UI requirement introduces a new state word that has no
canonical backend state or deterministic projection.

## 2. We Treated A Report As Proof That Work Happened

**What happened:** Rooms returned convincing reports and labels such as
`done-criterion met` even when no tool ran, no lead was persisted, no provider
receipt existed, or no campaign action was executable.

**Why it failed:** The same model that performed the work was allowed to judge
its own completion from prose.

**Rule:** A Room report is an explanation, never completion evidence. Only
persisted artifacts, source references, provider receipts, correlated events,
and generic predicate verdicts can advance a lifecycle.

**Stop signal:** Any code derives `COMPLETED` from final text, a governance badge,
or the absence of model-reported gaps.

## 3. We Confused A Valid Terminal State With The Requested Outcome

**What happened:** A user asked to send an email. The interpreter selected
prepare mode, drafts were created, the playbook reached `prepared`, and HQ marked
the user request complete without a delivery receipt.

**Why it failed:** Completion checked whether the playbook reached any terminal,
not whether it reached the terminal promised by the original instruction.

**Rule:** Preserve `requested_action` and `requested_terminal_outcome` for the
entire execution. Prepared, approved, delivered, monitoring, replied, declined,
and completed are different outcomes with different evidence.

**Stop signal:** A todo can become complete without comparing its terminal state
and evidence to the original requested outcome.

## 4. We Lost The Original Instruction Inside Generic Stage Prompts

**What happened:** Different Runtime jobs reached Rooms with the same static
message. Exact recipients, phone numbers, geography, subject, user constraints,
and intent disappeared. A direct call request could become generic prospecting.

**Why it failed:** The playbook objective replaced the user's instruction instead
of guiding its execution.

**Rule:** The natural original instruction is the primary Room workload. The
playbook contributes hidden phase guidance, expected artifacts, authority,
prior references, and unmet predicates through a structured envelope.

**Stop signal:** Two materially different instructions produce the same visible
Room request or the execution context no longer contains the original text.

## 5. We Routed By Words And Encoded Special Cases In HQ

**What happened:** Keyword and case-level routing sent outreach to Research,
calls to email playbooks, and new operation types into new HQ branches. Each fix
made HQ more brittle.

**Why it failed:** HQ started learning domain workflows instead of selecting a
compatible Room and immutable playbook.

**Rule:** Director classification returns a compatible `room_id`, `playbook_id`,
version, and compatibility evidence. Domain knowledge belongs in Room skills,
playbooks, and adapters. The generic engine must pass the GreenLeaf Bakery swap
test without code changes.

**Stop signal:** Engine or HQ code checks company, industry, city, channel,
artifact type, or task wording.

## 6. We Turned Intelligent Rooms Into One-Shot Report Generators

**What happened:** HQ delegated a broad outcome, a Room completed one convenient
piece, and the operation stopped. Prospecting ended before drafting; sending
ended before reply monitoring; posting ended before measurement.

**Why it failed:** Room intelligence was invoked as an isolated turn rather than
inside a durable lifecycle with checkpoints and continuation.

**Rule:** Rooms remain adaptive within coarse playbook phases. One execution ID
must span discovery, preparation, authority, provider action, monitoring,
follow-up, and terminal outcome. Attempts are audit entries, not new operations.

**Stop signal:** The next phase requires rediscovering the same company, leads,
campaign, or prior Room output.

## 7. We Let HQ Perform Specialist Work

**What happened:** HQ accumulated prospect selection, email semantics, campaign
rules, repair logic, and channel cases while Rooms underperformed.

**Why it failed:** The control plane became a second, weaker domain agent and a
single point of context growth and failure.

**Rule:** HQ observes, prioritizes, selects, governs, and reconciles. Rooms do
specialist work. Playbooks own lifecycle. Adapters touch providers. Core
predicates validate evidence.

**Stop signal:** HQ generates domain deliverables or knows a domain stage list.

## 8. We Added Guardrails That Regenerated Work Instead Of Governing It

**What happened:** Campaign contracts produced dozens of schema errors, then
large repair prompts regenerated whole plans. Token use grew while reliability
fell, and runs stalled at “Building the campaign contract.”

**Why it failed:** Semantic creation and deterministic payload mechanics were
forced into one enormous model-owned schema.

**Rule:** Let Rooms produce a concise, high-quality domain report and small
machine-readable outputs. Compile IDs, mirrors, enums, schedules, provenance,
and approval state deterministically. Governance reports exact missing evidence;
it does not rewrite the whole operation.

**Stop signal:** A small missing field triggers full synthesis, full debate, or a
large repair turn.

## 9. We Spent Tokens Replaying Context And Simulating Organization

**What happened:** Every campaign run reloaded broad company history, ran several
debate turns, synthesized a huge contract, and sometimes repaired it repeatedly.
Room idle periods appeared while one oversized final call worked in private.

**Why it failed:** More agents and context were treated as a proxy for quality.

**Rule:** Load compact Room journals, the latest relevant report, exact artifact
references, and only the skills required by the current phase. Debate only when
material disagreement changes the decision. Models write semantics; code writes
mechanics.

**Stop signal:** A routine phase repeatedly consumes the full Room history or
uses debate without a decision that needs contesting.

## 10. We Allowed One Bad Input To Fail A Whole Batch

**What happened:** One malformed email recipient could stop valid recipients
from receiving drafts or delivery attempts.

**Why it failed:** The batch, rather than each action, was the unit of outcome.

**Rule:** Every input receives a deterministic action key and exactly one
append-only terminal outcome: success receipt, deterministic rejection, or
genuinely uncertain. Valid inputs continue independently.

**Stop signal:** One provider 4xx aborts processing for unrelated inputs.

## 11. We Retried Ambiguous Writes Without A Universal Reconciliation Rule

**What happened:** Network failures, timeouts, deterministic rejections, and
provider uncertainty were sometimes collapsed into one failure path.

**Why it failed:** Blind retry can duplicate external actions; refusing all retry
can strand safe preparation work.

**Rule:** Deterministic rejection is terminal. Ambiguous external writes must be
reconciled against provider state before retry. PREPARE work may be reclaimed
when its write policy forbids side effects. EXECUTE work requires provider-aware
reconciliation or intervention.

**Stop signal:** A catch block simply requeues an external write or marks every
transport error fatal.

## 12. We Had Durable Playbook Runs But Strandable Work Orders

**What happened:** A Room work order could move from `queued` to `running`, lose
the sidecar during dispatch, and remain `running` forever because it had no
lease, heartbeat, reaper, or attributable terminal failure.

**Why it failed:** Durability was implemented for playbook runs but assumed for
the delegation layer.

**Rule:** Every claimable unit needs an owner, lease expiry, renewal heartbeat,
bounded attempt count, safe reclaim semantics, and an attributable stop.

**Stop signal:** A `running` record can exist without a live owner or future
scheduler transition.

## 13. We Used One Long Silent Timeout

**What happened:** Room dispatch could sit behind a blind ten-minute abort. The
user saw no persisted liveness checkpoint, and partial work was discarded or
misclassified.

**Why it failed:** A single deadline tried to represent progress, liveness,
provider ambiguity, and failure.

**Rule:** Use a playbook-configured soft checkpoint and hard deadline. The soft
checkpoint records real persisted attempt state; the hard deadline releases or
blocks according to side-effect authority. A terminal signal that may never
arrive always needs a bounded fallback.

**Stop signal:** `WAITING_EVENT` has no deadline, or an outbound request has only
one large magic timeout.

## 14. We Let Waiting Look Like Running, Blocking, Or Sleeping

**What happened:** Reply monitoring looked like unfinished prospecting, missing
connectors looked like failure, and HQ slept for seven days while independent
work was ready.

**Why it failed:** Generic statuses erased the semantic reason for waiting.

**Rule:** Persist and project typed waits: authority, connector, provider event,
deadline, evidence, owner, provider uncertainty, or no compatible playbook.
Waiting work remains owned while independent safe work can advance. Sleep only
when no executable work remains, and state the exact wake condition.

**Stop signal:** The UI says only `RUNNING`, `BLOCKED`, or `MONITORING` without a
correlation, owner, deadline, or required event.

## 15. We Treated Missing Connectors As Failed Work

**What happened:** Campaign planning failed because Instagram, LinkedIn, or X was
not connected, even when the Campaign Contract could be prepared safely first.

**Why it failed:** Planning capability and execution capability were conflated.

**Rule:** Let Rooms prepare artifacts with available evidence. Before the exact
external stage, probe the selected channel capabilities. Persist a capability
request, keep the same execution in `WAITING_FOR_CONNECTOR`, and resume it after
connection. Do not rebuild the campaign or create a new todo.

**Stop signal:** A missing execution connector destroys already valid planning
artifacts or marks the whole operation failed.

## 16. We Asked Users To Connect Internal Or White-Label Providers

**What happened:** Runtime exposed implementation vendors such as Zernio as if
they were customer products, and Google Maps was treated as a tenant connector
even though it was platform-managed.

**Why it failed:** Provider implementation and user-facing capability were not
separated.

**Rule:** The UI requests user-owned capabilities by public product/channel name.
Platform-managed capabilities are resolved server-side and never ask users for
keys. Internal adapter identity remains behind the capability boundary.

**Stop signal:** A customer-facing modal exposes an internal vendor, shared API
key, adapter ID, or infrastructure topology.

## 17. We Trusted One Negative Capability Probe

**What happened:** Transient connector or provider failures could look identical
to missing access and park work unnecessarily.

**Why it failed:** Probe results lacked last-known-good state, error taxonomy,
and consecutive-negative tolerance.

**Rule:** Distinguish not configured, revoked, deterministic denial, timeout, and
provider 5xx. Never demote access from one transient failure. Cache confirmed
capability state for a bounded period and record why a candidate was skipped.

**Stop signal:** A single timeout creates a “Connect” request.

## 18. We Bound Authority Too Late Or Too Broadly

**What happened:** The first Growth Sprint popup appeared after work had already
started; Manual/Auto sometimes disappeared or persisted incorrectly; approval
could be mistaken for permission over future mutable work.

**Why it failed:** Organization policy, pre-action policy choice, and exact batch
authority were mixed together.

**Rule:** Ask for Manual/Auto before the first governed work starts. The choice
sets category policy but launches nothing. Later, authority binds only the exact
immutable artifact hash at the playbook gate. Artifact edits revoke the grant.

**Stop signal:** A policy selection itself performs an external action, or a
grant survives an artifact change.

## 19. We Presented Missing Measurements As Zero

**What happened:** Baseline reports sometimes showed zero followers, impressions,
or website pages when the source was unavailable rather than measured at zero.

**Why it failed:** Collection absence and observed business state shared the same
numeric representation.

**Rule:** Preserve `observed`, `unavailable`, `not_connected`, `unsupported`, and
`zero` as distinct evidence states. Growth planning may use explicit unknowns;
it must not optimize against invented zeros.

**Stop signal:** A metric has a number without source, observation window, and
collection status.

## 20. We Made Deterministic Narration Feel Like Fake Intelligence

**What happened:** Runtime emitted repeated “waking,” “reading,” and “sleeping”
copy in a burst after a loader. Dummy agent bubbles and canned consciousness
language claimed activity that was not visible as it happened.

**Why it failed:** Theatre was used to cover transport and orchestration latency.

**Rule:** Stream persisted events once, in sequence. Immediate acknowledgement is
good only when it records a real accepted trigger. User-safe decision narration
may explain evidence and action, but never reveal private chain-of-thought or
fabricate tool progress.

**Stop signal:** Copy can be emitted without a corresponding accepted trigger,
attempt, tool call, artifact, verdict, or schedule row.

## 21. We Replayed History Instead Of Resuming State

**What happened:** Refreshing Runtime streamed old events again, long loaders
ended in a sudden flush, and retries looked like new user requests.

**Why it failed:** Hydration, live append, and execution identity were not cleanly
separated.

**Rule:** Hydrate canonical snapshot plus bounded history once. Then append only
unseen event sequences through SSE. Group attempts and Room turns under the same
execution and stage.

**Stop signal:** Refresh changes business state, duplicates transcript entries,
or creates a new execution for an existing correlated event.

## 22. We Let Browser Integration Bugs Masquerade As Runtime Failures

**What happened:** `/v1/hq/work` was healthy, but browser CORS rejected a
`Cache-Control` preflight. Polling failures then looked like a broken backend.

**Why it failed:** API verification stopped at container health or curl rather
than the signed-in browser path.

**Rule:** CORS, cookies, cache behavior, SSE, and browser-visible errors are part
of the API contract. Verify signed-in production behavior with Playwright and
inspect failed requests and console errors.

**Stop signal:** A release is called healthy without exercising the authenticated
frontend origin.

## 23. We Blocked The User On Slow Secondary Work

**What happened:** Campaign Contract preparation waited for image generation, and
large synthesis calls left the Room apparently idle.

**Why it failed:** Slow independent work sat on the critical path to review.

**Rule:** Return the verified plan and dashboard as soon as their acceptance
criteria pass. Generate images and other slow artifacts as visible checkpointed
follow-on stages. Do not claim launch readiness until required artifacts finish.

**Stop signal:** A reviewable semantic artifact waits on an independent provider
job that can safely continue afterward.

## 24. We Expanded To Every Domain Before Proving One Full Loop

**What happened:** Campaign, SEO, outreach, legal, finance, fundraising, social,
and other Rooms gained architecture while the first outreach lifecycle still had
completion, correlation, and recovery holes.

**Why it failed:** Breadth hid foundational failures and multiplied incompatible
partial patterns.

**Rule:** Prove one complete lifecycle adversarially before generalizing the
engine: prepare, persist, approve, execute, monitor, resume, follow up, complete,
restart, and recover from worker loss.

**Stop signal:** A new domain is proposed while the proving workflow cannot pass
provider, timeout, restart, and no-response branches.

## 25. We Allowed Competing Lifecycle Authorities To Exist

**What happened:** Legacy email lifecycle code, generic playbooks, HQ branches,
Room governance, and an unused LangGraph subsystem could each appear capable of
advancing work.

**Why it failed:** Overlap creates ambiguous ownership and makes fixes route back
to older paths under pressure.

**Rule:** The selected versioned playbook and generic executor are the sole
lifecycle authority. Legacy paths become read-only history and are removed from
new routing. LangGraph may implement a Room phase or checkpoint backend only if
it preserves the same execution contract.

**Stop signal:** Two services can independently mark the same business operation
complete or create successor work.

## 26. We Patched Cases Instead Of Enforcing Generality

**What happened:** Fixes targeted Berlin prospects, cold email, Instagram, X,
campaign actions, or one company. The next operation exposed the same structural
failure under a new noun.

**Why it failed:** Concrete product pressure overrode the domain-agnostic engine
contract.

**Rule:** Engine behavior is driven by versioned playbook data, generic
predicates, capability interfaces, and persisted context. A bakery order and an
outreach conversation must use the same executor without renaming hidden email
assumptions.

**Stop signal:** A proposed engine edit names a company, city, channel, campaign,
prospect, lead, email, call, post, or domain artifact.

## 27. We Used Deployment Success As Product Proof

**What happened:** Healthy containers, successful builds, and passing static
checks were sometimes reported as proof even when the user still saw stale UI,
missing buttons, CORS errors, or broken realtime behavior.

**Why it failed:** Infrastructure evidence was substituted for user-visible
acceptance.

**Rule:** Build and health checks prove deployability. Signed-in behavioral
canaries prove product behavior. Visual requirements require Playwright and image
inspection at relevant viewports.

**Stop signal:** The acceptance claim contains image tags and health endpoints but
no observation of the requested user flow.

## 28. We Lost Reproducibility During Parallel Development

**What happened:** Dirty trees, parallel sessions, divergent branches, manually
started containers, and mutable tags made production newer than trunk or
different from any commit. A “cleanup” merge risked overwriting the only live
copy of work.

**Why it failed:** Release lineage and collaborative file ownership were not
treated as runtime safety concerns.

**Rule:** Build from `/root/hivemind-main`; use `/root/hivemind` for Compose.
Inspect dirty files and parallel ownership before editing. Stage explicit paths,
use a release lock, immutable tags, one `stable` rollback image, one `current`
image, named-service `--no-deps` deployments, and never merge unrelated histories
to make the repository look tidy.

**Stop signal:** Production cannot be mapped to an immutable source state and
image digest, or a deployment would copy whole directories across worktrees.

## 29. We Trusted Documentation Or Analogies Without Verifying Their Limits

**What happened:** External systems such as Clicky could be described as robust
autonomous task operators even though the archived repository is a small,
stateless voice companion with minimal tests and no durable workflow engine.

**Why it failed:** Product impressions, a newer binary, and documented source
were treated as the same evidence.

**Rule:** Copy verified engineering patterns, not mythology. From Clicky, the
useful patterns are a clear state machine, shared transport sessions, bounded
finalization, configured-provider fallback, permission false-negative tolerance,
fast honest feedback, and a thin secret-injecting proxy. Its documented code is
not evidence for durable orchestration, governance, idempotency, or autonomous
company operation.

**Stop signal:** An architectural recommendation cites what a product appears to
do without mapping it to inspected source and its documented limitations.

## 30. We Planned Fixes Against A Stale Tree

**What happened:** Several Clicky gap findings were confirmed against
`origin/singulance-main`, while production behavior and handoff documents matched
a newer dirty/ahead tree.

**Why it failed:** A correct diagnosis against old code can become a harmful patch
against moved code.

**Rule:** Phase zero of every hardening effort is tree and production
reconciliation. Reproduce the gap on the ahead source and live image before
editing. Preserve already-fixed behavior and parallel work.

**Stop signal:** The cited function, fixture version, image hash, or line region
does not match the running service.

---

## Clicky Lessons Worth Adopting

These are patterns, not an architecture replacement:

1. **One explicit state owner.** Keep the playbook executor authoritative and
   make every projected state unambiguous.
2. **Bound every terminal wait.** Use soft progress checkpoints and a hard
   fallback deadline; never wait forever for an event that may not arrive.
3. **Reuse transport sessions.** One long-lived connection pool per host is safer
   and faster than throwaway clients.
4. **Resolve capabilities through ordered providers.** Probe configuration and
   degrade deliberately, while preserving authority and artifact hashes.
5. **Tolerate transient false negatives.** A timeout or 5xx does not prove a
   connector was removed.
6. **Acknowledge immediately but honestly.** Persist the accepted trigger before
   expensive context load; never invent progress.
7. **Keep the provider boundary thin.** Secrets and tenant identity remain
   server-side; clients and models do not supply them.
8. **Test the state transitions users depend on.** Clicky's strongest tests guard
   permission-routing edge cases; our strongest tests must guard leases,
   authority, waits, correlation, and restart recovery.

## Clicky Lessons We Must Not Copy

1. In-memory conversation state as workflow memory.
2. One model call as evidence that a multi-step business operation completed.
3. A single process state enum as the durable company operating model.
4. Minimal permission tests as sufficient coverage for provider writes.
5. Stateless proxy simplicity where tenant-scoped execution records are required.
6. Character/persona theatre as a substitute for accountable events.

---

## Mandatory Pre-Implementation Review

Before changing HQ Runtime, answer all of these in the task journal:

1. What exact user-visible failure are we fixing?
2. Which persisted record currently owns that state?
3. Is the diagnosis reproduced on the ahead source and running image?
4. Does the change preserve HQ, playbook, Room, adapter, PostgreSQL, and HIVEMIND
   ownership boundaries?
5. Can it be expressed in playbook data, a generic predicate, or an adapter
   before changing the engine?
6. What is the idempotency key and ambiguity policy for every external write?
7. What happens on worker death, timeout, connector loss, provider 4xx, provider
   5xx, no response, restart, and duplicate event?
8. What exact authority is required, and what artifact hash does it bind?
9. What deadline or event releases every waiting state?
10. Which production canary proves the behavior from the signed-in user's view?
11. Which files are concurrently dirty, and who owns them?
12. What immutable image and stable rollback tag will represent the release?

If any answer is missing, the implementation is not ready. Do not compensate
with more narration, another status label, a larger prompt, or a case-specific
branch.

---

## Relationship To The Clicky Hardening Plan

`HQ-CLICKY-HARDENING-PLAN.md` is directionally correct, with six cautions:

1. Phase 0 is mandatory because several gaps were initially inspected on an
   older tree. No later phase may assume those gaps still exist unchanged.
2. Lease recovery must distinguish PREPARE from EXECUTE. Reclaiming ambiguous
   external writes blindly would create duplicates.
3. Soft deadlines should be playbook-configurable with bounded engine defaults,
   not another universal magic number.
4. Provider fallback changes the immutable action batch. It must produce a new
   artifact hash and pass the applicable authority gate again.
5. Bare Node `fetch` does not by itself prove that every request creates a new
   connection. Measure current Undici dispatcher reuse, idle latency, and reset
   behavior before replacing transport plumbing. The gap is currently explicit
   control and observability, not yet proven absence of pooling.
6. Last-known-good capability state may prevent transient planning and UI false
   negatives, but it must never authorize an external write. The selected
   provider and tenant grant require a live check at the immutable action gate.

Recommended order remains:

```text
reconcile and measure
  -> work-order leases and bounded waits
  -> single-authority guard
  -> honest acknowledgement and typed waits
  -> shared transport and failure taxonomy
  -> capability fallback with exact-gate reauthorization
  -> measured token reduction
```

The objective is not to make Runtime more deterministic or more theatrical. It
is to make adaptive Room intelligence operate inside a lifecycle that cannot
lose work, invent completion, duplicate side effects, or wait forever.
