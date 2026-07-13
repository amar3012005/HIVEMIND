# HIVEMIND Memory Engine Manifest

## Purpose

HIVEMIND is the memory layer of SINGULANCE: a source-grounded, tenant-safe
memory engine that lets an institution retain, inspect, recall, and act on its
own knowledge. It powers the BRAIN (HIVEMIND), Operating System
(HyperAgents), and VOICE (TARA) without letting any of them invent a separate
truth store.

This file is normative. New work must preserve these rules. If a change needs
an exception, document the reason, risk, migration, and rollback before
shipping it.

## Product Promise

Given an authorized question, HIVEMIND must be able to:

- answer fast factual questions from durable current memory;
- explain a decision through linked claims and exact source evidence;
- hydrate relevant source sections from files, meetings, email, chat,
  connectors, or structured records;
- show what changed, when it changed, and what was known at that time;
- surface competing claims rather than silently hiding contradictions;
- work across languages through structured retrieval and canonical identity,
  not English-only keyword heuristics;
- enforce personal, project, team, organization, and enterprise isolation at
  every read, write, expansion, and export boundary.

An answer is incomplete when it cannot state its evidence coverage, source
links, or a meaningful cutoff reason.

## One Truth Per Concern

HIVEMIND does not store the same semantic truth as competing writable copies.

| Concern | Canonical authority | Non-canonical accelerators/views |
| --- | --- | --- |
| Application identity, access, usage, billing, memberships | PostgreSQL | Caches only |
| Managed memory, evidence, relationships, versions | PostgreSQL | Qdrant candidate index |
| Managed semantic candidate generation | Qdrant | Never a truth or authorization authority |
| `.amr` tenant memory | The selected `.amr`/BYOD memory backend | Optional local indexes and exports |
| Graph visualization/export | Read model derived from canonical relationships | Never writable truth |

For managed PostgreSQL plus Qdrant tenants, PostgreSQL is canonical and Qdrant
is rebuildable acceleration. For `.amr` tenants, the selected agent/backend is
canonical for that tenant. Both modes expose the same product contract.

## Storage Modes And Parity

| Mode | Intended use | Required behavior |
| --- | --- | --- |
| Managed hybrid | Enterprise managed hosting | PostgreSQL canonical memory/evidence/graph plus tenant-scoped Qdrant retrieval |
| Personal `.amr` | Personal/private memory | Same ingestion, provenance, lifecycle, recall, and isolation contract |
| BYOD/self-host | Enterprise data on customer infrastructure | Same API contract through the authenticated agent; no central copy of customer memory |

Storage selection may change implementation, latency, and operational ownership.
It must never change authorization, source provenance, version semantics,
relationship semantics, or the meaning of a recall result.

## Ingestion Contract

1. Authenticate and resolve the tenant before accepting bytes or text.
2. Validate size, type, quotas, source ownership, and idempotency.
3. Preserve immutable evidence first: artifact, document, segment, or
   connector-native record.
4. Make evidence available for recall immediately after durable storage.
5. Promote only reusable durable claims asynchronously and selectively.
6. Preserve exact provenance on every promoted claim: source/document/segment
   identifiers, source span where available, and extraction lineage.
7. Resolve canonical entities and create safe graph links asynchronously.
8. Compress or synthesize only as an additive, source-linked derived view.

Raw chunks are evidence, not automatically facts. Ambiguous content stays
evidence. A relationship is an edge, never a memory type.

## Durable Memory Types

- `fact`: stable requirement, KPI, policy, product, or customer claim.
- `decision`: approved choice with actor, scope, status, rationale, and time.
- `preference`: durable user or organization choice.
- `goal`: outcome, commitment, or milestone; tasks remain in the task system.
- `event`: dated occurrence with known participants.
- `lesson`: validated learning from work, experiments, or incidents.
- `summary`: source-local compression retaining its source links.
- `synthesis`: confidence-scored conclusion across multiple sources.
- `conversation`: curated durable state only; raw turns remain evidence.

## Graph And Versioning Contract

- `Updates` replaces a prior claim atomically: create the edge and set the
  predecessor `is_latest=false` in the same transaction.
- `Extends` adds detail and keeps both claims current.
- `Derives` is never created from an ingest-time LLM response. It enters a
  durable asynchronous job and is materialized only after verification with
  confidence at least `0.75`.
- `Contradicts` preserves both claims and makes the conflict visible.
- `PartOf` expresses membership in a document, meeting, project, or parent.
- `Mentions` is a lightweight association and never proof of truth.

All graph operations are tenant-scoped. There are no hard deletes for durable
memory history; retirement uses lifecycle/version fields unless a user invokes
an authorized deletion policy.

## Recall Contract

Recall is memory-first and event-driven. It must not depend on an
English-language regex classifier.

1. Resolve the caller, tenant, role, projects, teams, and allowed scopes.
2. Build a bounded recall plan (`fast`, `explain`, or `full`).
3. Retrieve current durable candidates with tenant, scope, project, lifecycle,
   temporal, and source filters applied before delivery.
4. Use lexical/vector candidates only as candidates; hydrate canonical records
   before they are trusted or rendered.
5. Expand to evidence, graph neighbors, adjacent context, and live connector
   data only when the plan requires it and within its deadline/budget.
6. Return source links, contradictions, recall trace, and cutoff metadata.
7. Build a bounded evidence packet for `/chat`, HyperAgents, and TARA.

`fast` favors current facts and low latency. `explain` includes linked evidence
and decisions. `full` may hydrate source windows and graph context, but must
state when latency or token budgets prevent complete hydration.

## Security And Tenant Isolation

- Authorize before querying PostgreSQL, Qdrant, `.amr`, connectors, or BYOD.
- Persisted API keys bind to their recorded organization; request headers do
  not override that binding.
- Project scope is accepted only after membership/role validation.
- Vector payload filtering is defense in depth; PostgreSQL hydration and access
  context remain the final authority.
- Evidence and graph expansion use the same tenant and scope restrictions as
  initial recall.
- Audit logs are append-only. Sensitive actions are attributable and retained.
- Uploads, recall, connectors, and agent endpoints are rate-limited and fail
  closed when their usage ledger or security dependency is unavailable.
- BYOD communication uses authenticated, allowlisted agent endpoints; central
  services never assume that an external box inherits central trust.

## Performance And Reliability

- Acknowledging durable ingestion is more important than synchronous LLM
  extraction, graph inference, or synthesis.
- Long-running enrichment is queued, idempotent, retryable, and observable.
- Qdrant/index outages must not corrupt PostgreSQL truth; recovery is an index
  rebuild, not data reconstruction.
- Recall has explicit deadlines and degrades by returning bounded canonical
  memory rather than hanging.
- Every backend change needs health checks, rollback tags, focused tests, and
  a deployment verification.

## Completed Foundation

The current implementation and deployment work has established:

- document-first ingestion with evidence objects, segment provenance, and
  selective promotion instead of treating every chunk as a fact;
- managed hybrid recall with PostgreSQL canonical hydration, Qdrant candidate
  retrieval, scoped filters, temporal handling, source evidence, and bounded
  recall plans;
- `.amr`/agent routing seams for personal and BYOD tenants without changing the
  public memory contract;
- atomic `Updates`, additive `Extends`, confidence-gated asynchronous
  `Derives`, contradiction visibility, and current-version filtering;
- project and organization isolation in persisted recall and vector search;
- multilingual structured evidence handling and chat recall contracts;
- append-only auditing, request limits, upload limits, SSRF controls, and
  authenticated BYOD routing from the security hardening phases;
- production-safe billing reconciliation that distinguishes enterprise
  onboarding payment state from plan access;
- current production correction: LLM co-mention `Derives` now enqueue a
  verification job rather than writing a graph edge inline.
- deployed bounded recall foundation: explicit `fact`, `explain`, and `full`
  plans have 1.5s, 3s, and 3s retrieval budgets; live expansion requires a
  permitted surface plus a retrieved source anchor or explicit live intent;
  `full` reports `latency_budget` when enrichment cannot complete in time.
- deployed server-owned `RecallPacket` and grounded-claim validator with stable
  citation IDs. It is wired into `/chat` only as a disabled-by-default shadow
  measurement path; existing chat retrieval and answers remain authoritative.

## Required Acceptance Gates

Before any memory-engine feature is declared complete:

1. Prove tenant and project isolation for every changed read/write path.
2. Prove source provenance survives ingest, promotion, recall, and chat.
3. Prove versioning invariants: `Updates`, `Extends`, `Derives`, and
   contradictions.
4. Test managed PostgreSQL plus Qdrant and `.amr`/BYOD behavior against the
   same contract, using isolated disposable fixtures.
5. Test idempotency, retries, timeout behavior, and safe degradation.
6. Verify that Qdrant/index drift cannot create unauthorized or non-canonical
   results.
7. Run targeted tests, inspect the change impact, deploy from a pinned commit,
   and verify health with a preserved rollback image.
8. Record residual risks rather than claiming parity without evidence.

## Known Work Still Required

- Run and retain a non-destructive managed PostgreSQL plus Qdrant end-to-end
  fixture that proves ingest, promotion, vector retrieval, evidence hydration,
  versioning, and chat grounding together.
- Run the equivalent self-host BYOD fixture, including transport failure and
  recovery behavior.
- Add an explicit deadline/remote branch to the `.amr` relationship-list
  endpoint, which was observed to hang during the 2026-07-13 audit.
- Move encrypted PostgreSQL and Qdrant backups off-host and regularly exercise
  the documented restore procedure.
- Complete canonical entity migration with organization-scoped uniqueness,
  additive links, consumer cutover, and safe backfill before enabling broader
  autonomous cognition.
- Run the recall shadow path for an isolated enterprise canary, prove packet
  coverage and citation parity without duplicate connector calls, then switch
  one organization at a time behind the existing rollback flag.

## Supporting Documents

- `docs/MEMORY_COGNITION_LIFECYCLE.md`
- `docs/RECALL_PIPELINE.md`
- `docs/KB_INGESTION_PIPELINE.md`
- `Security-hardening-journal.md`
- `project_status/plans/HYBRID_RECALL_POLICY_JOURNAL.md`
- `project_status/PRIORITY2_MEMORY_ENGINE_PLAN.md`

Last updated: 2026-07-13
