# KB ingestion + recall v2 — production rollout plan

Companion to `kb-ingestion-pipeline-v2.md` (the design). This is the **shipping
order**, the flag model, and the FE/core/control-plane split.

## The flag model — and why there is no `v2/` folder

CLAUDE.md: *"No second path. A parallel implementation is worse than the bug.
Delete the bypass, never leave it as a fallback."*

That rule forbids a second **path**, not a second **parameter set**. The
distinction is what makes a safe rollout possible without a fork:

- **A second path** = two implementations of the same behaviour that can diverge
  when one is fixed. A `v2/` copy of `document-first-ingestion.js` is this.
  FORBIDDEN.
- **A parameter profile** = ONE implementation whose constants come from config.
  Already the convention here — 15 `KB_*` flags live in production today.

### Audit of the v2 changes by type

**(a) Pure parameter — no new code, no flag risk.** `DOC_CAP` formula,
`MIN_IMPORTANCE`, curator cap, window chars, window overlap, retrieval
depth vs deliver, rerank pool size, MMR position.
→ one `ingestion-profile.js` returning the parameter set.

**(b) Strictly additive — NO FLAG NEEDED.** Populating `segment_type`
(today literally `'structured'`, a value not even in the schema's documented
set), `depth`, `start_page`, `end_page`, `metadata.heading_path`; the
`progress_at` heartbeat; table grounding columns; the `pipeline_version` stamp.
**Filling a null column cannot regress anything.** Flagging these would add risk,
not remove it.

**(c) Genuinely new code — one flag EACH, so a regression can be bisected in
production instead of guessed at.**

| module (new file) | flag | reversible? |
|---|---|---|
| `knowledge/segmentation/section-tree.js` | `KB_SECTION_TREE` | write-side |
| `knowledge/entity/resolver.js` | `KB_ENTITY_RESOLVE=deterministic` | write-side |
| `knowledge/relations/document-pass.js` | `KB_DOC_RELATION_PASS` | write-side |
| `memory/fusion.js` (memories ∪ segments, one rerank) | `RECALL_V2` | **fully** |

Directory layout is **by capability inside the existing tree**, never by version.
Each new module has exactly ONE call site in the existing file.

### THE ASYMMETRY THAT WILL BITE IF NOT STATED

- **Read-side flags are a true rollback.** `RECALL_V2` is a pure function of
  stored data. Flip it, behaviour reverts completely.
- **Write-side flags are NOT a time machine.** Documents ingested under v2 keep
  their v2 shape. Flipping the flag back stops *new* v2 data; it does not restore
  v1 data. The real rollback for write changes is **re-ingestion**, which is only
  possible because source retention shipped (295594e54), and which is only
  *selective* because of `pipeline_version` on the row.

Every document/segment/memory written under v2 is stamped
`pipeline_version = 2`. That is what makes "what is live?", "measure v1 vs v2 on
the same corpus", and "re-ingest only the v1 rows" answerable.

Do **not** reuse `processing_version` for this — it is a retry counter, and
overloading it is how the next bug gets written.

### Exit condition (this is what honours the rule)

**P7 deletes the v1 parameter sets and the flags.** They are a rollout
mechanism with an expiry date, not a permanent fallback. A flag still present
three months later is a second path that we chose not to notice.

## Shipping order

Each phase is independently deployable and independently revertible.

### P0 — Safety rails + baseline. ZERO behaviour change.
- `pipeline_version` column (additive, default 1) on documents/segments/memories
- `progress_at` heartbeat + per-stage reap budgets (parse 20m — PPTX measured
  603s, so today's `processingMaxMin: 45` can kill a healthy job)
- `ingestion-profile.js` seeded with **v1 values only** — proves the config seam
  with no behaviour delta
- **`DocumentTable` + `DocumentTableRow` → `ROUTED_MODELS`** (placement defect
  introduced this session: 7 of 13 orgs are non-hybrid and their spreadsheet
  cells are currently written to central Postgres)
- Baseline capture on the empty test org, current code, per format
- **Gate:** canary 6/6; counts identical to today; an `.amr` table write lands in
  the tenant store, not centrally.

### P1 — EVIDENCE ENRICHMENT. The recall fix. Read-side, fully reversible.
The owner's requirement: *small details must come from segments, not only from
memories.*
- Populate segment metadata (type (b) — no flag)
- **Split `limit` into `depth` + `deliver`** in `retrieveEvidence`
  (`depth: 150, deliver: 5–10`). Today one param does both: `{limit: 5}` →
  Qdrant returns 10 → rerank sees 10 while `RERANK_POOL=150` sits unused.
  Measured pool recall 1→6, 2→11, 0→8.
- **Mirror it in `amrKbRecall` in the SAME commit** — retrieval branches on
  `orgIsRemote`, so fixing only the Qdrant path leaves a second path for 54% of
  tenants.
- Scope-aware evidence (today: `user_id` filter on every unscoped search, so a
  colleague's org-shared upload is invisible). NOT a naive swap to `org_id` —
  that leaks personal documents. Reuse the memory scope logic.
- **Unified rerank pool: memories ∪ segments in ONE `rerank()` call.** Dedup a
  memory against its own supporting segment via `memory_evidence_links` — a
  join, not a heuristic.
- Move MMR **after** the cross-encoder (it currently runs before, so rerank
  undoes the diversity).
- **BLOCKER first:** explain `SPiNE` pool recall D60=24, D150=24, **D300=17**. A
  deeper pool returning fewer true positives is non-monotonic; P1 *is* a depth
  increase, so shipping on top of it hides a regression.
- **Gate:** semantic ground-truth probe (NOT the lexical one — it scored the
  reranker's correct `Wallbox`/`Charging station` answers as misses); two scoped
  keys + set intersection (the evidence collection is a new isolation surface);
  warm recall ≤ 2s.

### P2 — Ingestion yield. Write-side.
- `DOC_CAP = ceil(chars/550)` (was flat 24 → ~80% of every long document never
  reached the LLM, with no log line)
- Delete `KB_UNIFIED_MIN_IMPORTANCE`; delete the curator's 70% cap
- Window overlap 0 → 200
- `entityContext` + `heading_path` + `page` + doc summary into the window
  (all four are hardcoded `null` in two places today)
- Offset-based `segmentId` (replaces `promotableSegments[Math.min(i, len-1)]`)
- Kill `chunkWithDocling` — a second full Docling conversion whose output the
  default path discards
- **Gate:** same deck 18 → ~115 memories, all German;
  `windows_processed == windows_total` logged for every document or an explicit
  `budget_exhausted` line.

### P3 — Atomic facts + section-tree segmentation
- Atomic prompt (one subject-prefixed attribute, ~10–20 tokens)
- Windows = N contiguous segments inside ONE section
- **Gate:** median tokens/fact 10–20; supersession key
  `(org, entity, attribute)` is well-defined on a sample.

### P4 — Entities + relations
- Deterministic resolver with alias guards (high cosine AND ≥2 documents; never
  auto-merge existing canonicals)
- 5b intra-document relation pass over the atomic fact list
- `UNIQUE (org_id, entity_id, attribute) WHERE is_latest` partial index
- **OWNER DECISION REQUIRED:** `Entity` is not in `ROUTED_MODELS`, so for .amr
  tenants mentions sit in the tenant store while canonical rows sit centrally.
  Data-residency call, not a code call.
- **Gate:** `hannover` → exactly one canonical row, mentions > 0; every
  `Derives` has `inferred=true` and appears in no citation.

### P5 — Frontend. Must not break, must not fork.
- Stage display mapped to the R1 table; `enrichment` rendered as its own
  non-blocking state so a 0-memory document reads as an **outcome**, not Failed
- One batch poller (`GET /documents/processing`) replacing N per-job pollers —
  this is the fix for the list churn, not a cosmetic change
- "Clear completed"
- Precheck `duplicate: "maybe"` handling
- **Feature-detect the backend.** FE and core deploy separately and have raced
  before; the FE must work against both old and new core.
- **Gate:** browser, all three live orgs including the 0-memory one. A green curl
  is not e2e.

### P6 — API surface
`customId` (+ the R2 idempotency matrix), `taskType: memory|superrag`,
`filterByMetadata`, `dreaming: instant|dynamic`, scope-aware precheck.
- **Verify first:** whether the FE reaches upload directly on core `:2026` with a
  scoped key or via control-plane `:2027` with a session Bearer. If the latter,
  every new route needs a control-plane counterpart. Unverified as of writing.

### P7 — Delete the v1 branches and the flags.
Not optional. This is the phase that keeps the rule.

## Control plane

Ingestion quota (`planEnforcer.checkLimit(orgId, 'kbPages', …)`) lives in **core**,
not the control plane, so P0–P4 are expected to need no control-plane change.
P5/P6 depend on the routing question above. **Do not invent control-plane work
before that is verified.**

## Standing constraints

- Deploy only an immutable named commit; tag by SHA; refuse a dirty tree.
- The working tree is currently dirty (`toolkit-factory.js`,
  `stream-handler.js`, `agentscope_tools.py`, `hyper/engine.py`,
  `docker-compose.hetzner.yml`) — `preflight-deploy.sh` will refuse, by design.
  This gates P0.
- `.amr`/BYOD: any retrieval change lands in `amrKbRecall` in the same commit.
- No new tenant-visible surface ships without two scoped keys and a set
  intersection.
