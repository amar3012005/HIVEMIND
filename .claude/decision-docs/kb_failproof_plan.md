# KB Ingestion — Fail-Proof Plan (recon + phased fixes)

Recon date: 2026-08-06. Every claim below was read out of the running code or
measured on production, not assumed.

## What is ALREADY solid — do not rebuild

| Surface | Mechanism | Evidence |
|---|---|---|
| Queue | BullMQ, `attempts:3`, exponential backoff, `JOB_TIMEOUT_MS=10min`, `CONCURRENCY=6`, `ORG_CONCURRENCY=4` | `kb-ingest-queue.js:41-44` |
| Overload | Backpressure → caller gets 429, counter `rejected_backpressure` | `:315-328` |
| Dead jobs | DLQ on final attempt → `status:'dead'`, raw file retained | `:170-176` |
| Cross-node status | Job status mirrored into Redis (24h TTL) because the worker may run on a different hm-core than the FE polls | `:178-185` |
| Idempotency | sha256 checksum dedup + `/upload/precheck` + in-flight flight-key | verified live (re-upload → `status:"existing"`) |
| FE concurrency | ADAPTIVE and deliberately low — sized against the core's Prisma pool (`connection_limit=20`), not a naive parallel blast | `KnowledgeBase.jsx:1353-1420` |
| FE slot release | Transfer slot freed the moment bytes land, so the next file starts during the 30-134s server ingest | `onQueued` → `_slotReleased` |
| FE refresh survival | `sessionStorage` rehydrates just-uploaded rows (metadata only — deliberately NOT localStorage, 5MB cap) | `:156-178, 1006` |
| FE retry policy | 502/503/504/429/no-response auto-retry; 402/403 plan-limit treated as terminal | `:1670-1680` |
| Completion gate | Coverage assert before `ready`; evidence-only counts as success | shipped `10653708` |
| Grounding | whitespace/unicode-tolerant quote match + per-condition drop counters + `capped` bucket + UNACCOUNTED self-check | shipped today |
| Scope | stamped on every segment, both segment paths; project scope verified e2e | shipped today |
| Pages | taken from the parser's own chunk pages, with an anti-fabrication guard | shipped today |
| Status contract | `queued → processing → done` now honest | shipped today |

## P0 — permanent data loss, no recovery path

### P0.1 Dead jobs cannot be replayed
DLQ marks `status:'dead'` and the raw file is retained, but there is **no retry
endpoint and no UI**. A document that exhausts 3 attempts is stuck forever and
nobody is told.

- Add `POST /api/knowledge/jobs/:id/retry` — org-scoped, re-enqueues from the
  retained raw file, resets attempts, requires the job be terminal.
- Add `GET /api/knowledge/jobs?status=dead` so failures are discoverable.
- FE: surface dead jobs with a Retry action (the row already has `_retryForce`
  wiring for the duplicate case — reuse that affordance).
- Guard: replay must go through the same checksum precheck so a retry cannot
  double-ingest a document that actually succeeded on another node.

### P0.2 Reconciler heals memories but not evidence segments
`embed-reconciler.js` scans `hivemind.memories` only. `_embedSegments` heals once
inline; if that heal fails, nothing ever repairs it — the segment exists in
Postgres but has no vector, so the evidence is permanently unsearchable while
looking perfectly healthy in the UI.

- Add a segment lane: find segments whose `vectorStored` is false (central) or
  absent from the agent (remote), re-embed through the same store path.
- Run on the existing 3-min tick + full sweep, with the same loud logging.
- Report `segments_in_vectorstore == segments_in_pg` per document in coverage.

## P1 — silent degradation

### P1.1 Inline fallback is invisible and undurable
When Redis is unreachable the queue disables itself and ingestion runs **inline
in the request**: no retry, no DLQ, no cross-node status. Correct as a
last-resort, wrong to do silently.

- Emit a loud, rate-limited WARN + a health flag when running inline.
- Surface it in `/api/knowledge/status` so the FE can say "degraded mode".

### P1.2 Stalled-job recovery runs on BullMQ defaults
No `lockDuration` / `stalledInterval` / `maxStalledCount` is configured, but real
jobs take 30-134s and the promote phase alone measured 25.4s. If a lock ever
lapses, BullMQ re-runs the job — **duplicate ingestion of the same document**.

- Set these explicitly, sized against `JOB_TIMEOUT_MS`.
- Verify a long job is never re-delivered.

### P1.3 Timeout vs slow parsers
`JOB_TIMEOUT_MS` is 10 min; docling was measured at 18-606s before falling back.
A scanned PDF + vision fallback can exceed the budget and die as a hard failure.

- Either raise the ceiling for OCR/vision tiers or fail them fast with an honest
  reason rather than a timeout.

## P2 — quality, not loss

### P2.1 Cap keeps the FIRST N facts, not the most salient N  ← approved: option (a)
`normalizeUnifiedClaims` does `if (out.length >= maxFacts) break`, so it keeps
whatever the model emitted first — document order, not importance. Measured
`in=24 kept=9`: 15 claims discarded unseen.

Supermemory's model is explicit that memories are *"curated rather than
exhaustive"* and prioritise *"quality over comprehensiveness"* — so the cap
itself is right; the SELECTION RULE is wrong.

- **Option (a), chosen:** keep document order, but select the top-N by
  importance. Preserves narrative flow while dropping the least salient.
- Safe to do now only because the rel-index remap shipped today — before it,
  changing which facts survive corrupted intra-window relationship indices.

### P2.2 Cross-doc linking non-deterministic
`20 facts → 63 edges` on one document, `28 facts → 0 edges` on another, same
code. Unexplained; needs instrumentation before tuning.

### P2.3 Unverified parser tiers
Verified this session: text PDF, DOCX. **Unverified:** scanned/OCR PDF, XLSX,
PPTX, audio, images. Each is a distinct failure surface.

### P2.4 `governanceAgentState.update()` should be `upsert`
Nine "Record to update not found" errors across 3 orgs per cycle. Non-fatal, but
recurring noise hides real errors.

## Order of execution
P0.1 → P0.2 → P2.1 (approved) → P1.2 → P1.1 → P1.3 → P2.4 → P2.3 → P2.2

Rationale: the two P0s are the only items where data is lost with no way back.
P2.1 is next because it is approved, small, and newly safe. P1.2 outranks the
rest of P1 because duplicate ingestion is a correctness bug, not just noise.
