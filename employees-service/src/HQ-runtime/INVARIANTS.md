# HQ Runtime Invariant Closure

This is the production architecture contract. A change is incomplete when it
works for one request but weakens any invariant below.

## One Operating Loop

```text
persisted event or instruction
  -> HQ observes and prioritizes
  -> Director selects an exact active playbook version
  -> playbook checkpoints before its current stage
  -> Room performs adaptive specialist work, or adapter performs one bounded operation
  -> artifacts are persisted append-only
  -> predicates and provider verification accept or reject the stage
  -> playbook advances, waits, repairs, requests authority, or intervenes
  -> HQ projects the durable result and chooses company priority
```

HQ is the event-driven control plane. It does not research prospects, compose
campaigns, write specialist reports, or call providers. Rooms are adaptive
operators. They do not declare themselves complete. Playbooks are immutable
lifecycle data. PostgreSQL is execution truth; HIVEMIND is semantic company
memory.

The production scheduler uses `runtime-playbooks/service.js` and the generic
PostgreSQL stage executor. The old HQ LangGraph email and Room-operator sources
are inert historical code and may not be wired into routes, scheduler, or server
startup. Historical database records remain readable; new work never enters
that path.

## Room Boundaries

- Human Work Rooms receive human requests. Their Director may answer directly,
  gather evidence, deliberate, produce an internal artifact, or propose a
  Runtime handoff. Their adaptive goalkeeper is locally bounded.
- Company Rooms receive private Runtime envelopes. The visible instruction is
  concise and natural; lifecycle guidance, inputs, checks, authority and schemas
  remain in `execution_context`.
- Company Room executions declare `retry_policy.owner = playbook`. Employees
  performs no outer Room replay for them. A bounded local artifact repair may
  fix the current synthesis, but only Core increments the durable stage attempt.
- Human and Runtime turns may share the Director implementation, but never
  lifecycle ownership or completion semantics.

## Contract Symmetry

For every stage, `completion_checks` are the single source from which Core
derives producer-visible artifact requirements and schemas. Every expected key
and every predicate selector must be present in both `runtime-stage.v1` and
`room-phase.v2`, including multi-artifact stages.

A derivation error fails dispatch. It must never silently remove the producer
contract. Typed strict output is an optimization for registered shapes, not a
precondition for correctness. Unregistered and multi-artifact stages still
receive names, required fields, counts, source requirements, and exact checks.

Completion requires all applicable evidence:

- persisted artifact identifiers;
- source references for source-backed claims;
- predicate acceptance;
- adapter verification and provider receipts for external effects;
- a requested terminal state compatible with the original outcome;
- exact immutable authority when the stage changes external state.

Prose, a Room report, a successful model response, or a terminal playbook state
alone is not completion.

## Retry And Failure Ownership

Only the playbook executor owns semantic retries. It persists stage attempts,
carries prior artifacts into repair, stops at `max_attempts`, and parks a failed
run in `NEEDS_INTERVENTION`. Ordinary scheduler re-entry cannot run a parked
stage again. Infrastructure uncertainty is reconciled against durable Room or
provider state before retry; deterministic rejection is not uncertainty.

Room leases, heartbeats and idempotent turn keys prevent duplicate execution.
The same run ID spans Room attempts, adapter actions, authority, monitoring,
follow-up and terminal outcome.

## Capability Is Not Authority

Planning may use any deployment-enabled capability and may prepare internal
artifacts without granting an external effect. Connection, provider execution,
and organization allowlists are separate facts.

Latest active playbook versions must bind every delivery or launch stage to:

- an opaque `authority_policy_key`;
- an exact `authority_gate`;
- `authority_binding: stage_inputs`.

Manual waits for the exact batch. Auto can grant only the current immutable
input hash under organization policy. Any target, artifact, provider effect, or
policy input change invalidates the grant. Planning flags and internal autonomy
must never double as permission to send, publish, call, or spend.

## Release Truth

`singulance-main` on the authoritative GitHub remote is the only deployable
lineage. `/root/hivemind-main` is collaboration source; `/root/hivemind` is the
Compose and environment tree. Builds use a clean detached worktree at
`/root/releases/builds/<full-sha>`. Generated manifests and Compose overrides
live under `/root/releases/manifests/`, never inside the immutable source tree.

All release entry points converge on `scripts/release-canonical.sh`, which uses
one host-wide lock, named `--no-deps` recreation, immutable SHA images, one
stable rollback, and OCI source labels. `scripts/verify-deployed.sh` verifies:

- health or running state;
- exact full source revision label;
- runtime source hashes inside Core, Control and Employees;
- the complete playbook fixture catalog hash inside Core and Control.

A healthy endpoint without source identity is not a successful release. A test
without a signed-in behavior canary is not proof of user-visible completion.

## Required Regression Gates

- GreenLeaf Bakery swap test runs without engine changes.
- A failing Runtime stage creates no more Room executions than `max_attempts`.
- Company Room outer goalkeeper rounds remain one; Human Work Rooms retain their
  independent bounded policy.
- Every fixture stage derives and delivers contracts for all keys/selectors.
- Latest delivery and launch stages require exact-input authority.
- Production HQ modules import no competing lifecycle service.
- Canonical release dry run, service builds, deployed verifier, and production
  canaries pass before acceptance.

## Mistakes We Do Not Repeat

1. Encoding a request example in HQ or executor code instead of playbook data.
2. Letting both the Room and playbook retry the same semantic failure.
3. Asking a producer for prose and validating an undisclosed machine shape.
4. Treating a polished report or generic terminal state as requested-outcome proof.
5. Using connector availability, pilot allowlists, or internal autonomy as external authority.
6. Keeping a legacy lifecycle wired as a fallback after its replacement ships.
7. Deploying from a dirty/shared tree, local `origin`, mutable tag, or a second release script.
8. Calling health checks proof while the running image lacks revision and source verification.
9. Fixing one campaign, email, company, language, or Room instead of enforcing the invariant across every fixture and envelope.
