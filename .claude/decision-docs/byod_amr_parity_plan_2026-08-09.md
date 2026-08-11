# BYOD agent parity — Phase 12, at last given a real plan

`byod/agent/server.mjs`'s own header has said this since it was written:

> PHASE 1 build: pure Postgres + Qdrant (no .amr) ... (Phase 12 swaps PG+Qdrant internals for
> .amr behind this same contract — the engine never changes.)

Nobody has done Phase 12. Discovered while diagnosing a real customer's (SINGULANCE's own
`byod_amr` org) evidence-recall report today: the agent this org runs is on **pure Phase 1**
architecture — not "missing the last few B-phases," missing **all of them**. Every `.amr`-native
piece built this session and last (Phase A backup/compaction, B4 evidence-into-shard + access
gate, B5 graph, B6 in-shard lexical, B7 entities + tag path, the document layer, provenance as
`Derives` edges, the edge-dedup unique constraint) exists only in `embedded-agent.mjs`. The
standalone remote agent — the thing every self-hosted customer actually runs — never got any of
it.

**The favorable fact that makes this tractable**: the design was right from day one. The contract
(`/v1/write`, `/v1/recall`, `/v1/kb-recall`, …) is the abstraction boundary, and the engine already
only speaks that contract — `driver.js`/`remote-backend.js` don't know or care what's behind it.
Phase 12 is contained to rewriting `byod/agent/server.mjs`'s internals, a data-migration tool, and
a rollout story. **It does not touch the engine.**

---

## 0. What's confirmed, not assumed

Verified today, not inferred from the header comment:

- `/v1/write` (memories) inserts into a plain Postgres `memories` table. No `.amr`, no `MnemeStore`,
  anywhere in the file.
- `byod/agent/Dockerfile` / `package.json`: zero references to `singulance-amr` or a native binding.
- `/v1/kb-recall` has NO over-fetch (`limit: Number(b.limit) || 20` used directly as the Qdrant
  fetch size, access-filtered *after*) — the same silent-under-return shape fixed in
  `embedded-agent.mjs` (`ff7dc7ef`), still present here, unfixed.
- `/v1/kb-recall` does NOT have the `j`-scope `ReferenceError` — checked specifically, since that
  was today's P0 in the embedded path. This file's version never had that bug; a different,
  correct structure was used.
- `appendDocumentAccess` here is a byte-for-byte independent copy of the embedded version — a
  third copy of the same access rule (`doc-access.mjs` was written as a *fourth*, pure, tested
  copy for the differential harness). Three implementations of one security-critical predicate,
  none sharing a source of truth.
- `access` reaches `kb-lexical` via `filter.access` (matching `embedded-agent.mjs`'s convention,
  not an accident local to this file) — now made explicit/dual-shaped in both, per the fix
  shipped alongside this plan.

## 1. Gap inventory (embedded-agent.mjs → byod/agent/server.mjs)

| Capability | embedded-agent.mjs | byod/agent/server.mjs |
|---|---|---|
| Memory storage | `.amr` shard | Postgres table |
| Memory lexical | shard + SQL mirror | Postgres FTS only |
| Evidence storage | `.amr` shard (layer 1) + Postgres + Qdrant | Postgres + Qdrant only |
| Evidence over-fetch (pool before filter) | yes (`MNEME_KB_RECALL_POOL_MAX`) | **no** |
| Documents-as-records (layer 3, `ingest_mode` column) | yes | **no** |
| Entities (layer 4, `Mentions` edges) | yes | **no** |
| Provenance (`Derives` edges) | yes | **no** |
| `by-tags` route (entity-hop0) | yes | **no** |
| Metadata-layer recall exclusion (`isNonRecallable`) | yes, 3 sites + write guard | N/A — no shard, no layers |
| Relationship edge dedup (unique constraint) | yes | N/A — no `.amr`, so no edge table shape to dedup |
| Backup / compaction (Phase A) | yes | **no** — a dead customer box loses everything, permanently |
| Contextual embedding at chunk time | **N/A — happens in `document-first-ingestion.js`, before either agent is called. Already universal.** | same |

The last row matters: not everything is a gap. Anything decided in *our* code before the HTTP
call reaches an agent (chunking, contextual-embed prefix, `ingestMode` short-circuit) is already
uniform across every storage mode. Only what an agent must *itself* implement is missing here.

## 2. Why this is riskier than the embedded-agent work, and slower on purpose

Three properties make Phase 12 categorically different from yesterday's and today's work:

1. **Customer-controlled upgrade cadence.** `remoteKbLexical`'s own comment: *"the running agent
   had no `/v1/kb-lexical` endpoint at all for 9 days"* — because SOMEONE has to redeploy the
   customer's box, and that isn't us. A rewrite here does not take effect for a given customer
   until they pull it. Every change must work correctly against BOTH old and new agent versions
   running simultaneously across the fleet — this is why today's access-contract fix sends
   `access` at two levels rather than picking one.
2. **Their data plane, their box.** A migration bug here doesn't corrupt a shard we can restore
   from our own snapshot cadence — it risks a specific enterprise customer's memory. The backup/
   compaction gap (Phase A never ported) means TODAY, before any of this work starts, a crashed
   BYOD box has no recovery path at all. That is the one item in this plan that should not wait
   for the rest.
3. **Unknown deployment diversity.** We don't control what OS/arch a self-hosted customer runs.
   The native `.amr` binding needs multi-platform prebuilds (the same problem ICARUS's own CI
   solves for `singulance-amr`'s npm package) shipped INSIDE `byod/agent/Dockerfile`, not built
   from source on a customer's box — a source build introduces a whole new class of "works on our
   machine" failure a remote operator cannot debug.

## 3. Phased plan

Each phase ships independently and is safe to leave running indefinitely if the next phase stalls
— no phase depends on customers upgrading past it before it's individually correct.

### Phase 12.0 — Stop the bleeding (no architecture change, do first, do fast)
Same-shape fixes as `embedded-agent.mjs` already has, ported without touching the Postgres+Qdrant
architecture at all:
- Evidence over-fetch pool (mirror `ff7dc7ef`'s change): draw 4×limit, filter, trim.
- Snapshot backup for this agent's OWN Postgres+Qdrant (pg_dump + Qdrant snapshot API on a cron,
  written to a customer-controlled path) — this is the Phase-A equivalent for a non-`.amr` store.
  A customer's data having NO backup path is the single highest-severity item in this whole plan
  and should not wait on anything below.
- Collapse the THREE independent copies of `appendDocumentAccess` (embedded, byod, doc-access.mjs)
  into one shared, binding-free module all three import. This is the same lesson as today's leak
  and today's duplicate-edge bug: an invariant maintained at N copies drifts at copy N+1. One of
  the three already nearly did (kb-lexical's access shape).

### Phase 12.1 — Native binding in the customer image
Add `singulance-amr` (prebuilt per-platform, same artifacts ICARUS's CI already produces) to
`byod/agent/Dockerfile`. Ship it DORMANT — imported, health-checked, never on the read/write path
yet. Verifies the binding loads on real customer infrastructure before anything depends on it.

### Phase 12.2 — Dual-write, measure, never read (mirrors B4's own playbook exactly)
- `/v1/write` (memories) and `/v1/kb-segment` (evidence) additionally write into a local `.amr`
  shard, Postgres/Qdrant unchanged and still authoritative.
- Read-compare harness (same shape as `readCompareEvidence` in `embedded-agent.mjs`) logs overlap
  between the shard and Postgres+Qdrant per query. Purely observational.
- Gate to Phase 12.3, explicitly, per customer: sustained real traffic, read-compare holding at
  parity over a corpus size that can actually support the claim — not the 23-segment mistake this
  session already made once centrally. A customer with a small KB does not clear this gate quickly,
  and that is correct, not a blocker to route around.

### Phase 12.3 — Cut over reads, one lane at a time
Memory lexical → memory vector → graph/edges → evidence vector → evidence lexical → documents/
access-gate → entities/provenance. Same lane-by-lane order as the embedded migration, same reason:
each lane independently regressable, each with its own rollback.

### Phase 12.4 — Retire Postgres+Qdrant for this agent
Only after 12.3 is fully cut over AND the Phase-12.0 backup path has been proven on at least one
real restore drill for THIS agent shape (not inferred from the embedded shard's restore drill —
different files, different failure modes, needs its own proof).

## 4. What does NOT change

- The HTTP contract (`/v1/write`, `/v1/recall`, `/v1/kb-recall`, …) — this is the whole point of
  Phase 12 being possible without an engine change.
- `AGENT_TOKEN`/`ORG_ID` env-based single-tenant model.
- Nothing in `document-first-ingestion.js`, `contextual-embed-input.js`, or the `ingestMode`
  plumbing — those already apply uniformly regardless of which agent receives the call.

## 5. Immediate next step (not gated on any of the above)

Every item in Phase 12.0 is safe today, requires no customer action, and closes the two sharpest
gaps (no backup path; three drifting copies of an access-control predicate) without touching
architecture. Recommend starting there while the rest of this plan is reviewed.
