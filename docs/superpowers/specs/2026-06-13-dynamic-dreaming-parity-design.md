# HIVEMIND Dynamic Dreaming — Parity + Beyond (Full Program WS1–WS5)

> Design spec. Verified against the live codebase 2026-06-13 via a 48-agent
> read-only gap analysis (map → adversarial verify → synthesize). Goal: match
> supermemory's "Dynamic Dreaming" and exceed it, ordered by **increasing
> feasibility → complexity** (WS1 easiest, WS5 hardest).

---

## 0. Executive summary

We already own the dreaming substrate. The gap analysis **dropped 3 of 8 claimed
gaps as already-built** and confirmed **5 real ones**. The program closes those 5
without rebuilding what works.

**Already have (do NOT rebuild):**
- Hybrid retrieval — raw memory queryable instantly (`graph-engine.ingestMemory` :449), background enrichment (`enrichment-queue.js`), unprocessed tier served by `recallPersistedMemories` (`persisted-retrieval.js` :967).
- Background cognition loop — `ResidentAgentScheduler` (`resident/scheduler.js` :61) → `CognitionLoop.runOnce(orgId)` → synthesize + drift-compact + distill-principles. `ContradictionScanner` re-scans entity pairs in background.
- Contradiction detect + delta-update — `conflict-detector.js detectContradictions` (:169) at ingest; `graph-engine.js` :1372–1455 reconciles Contradicts→Updates/Extends + flips `is_latest`; `_maybeDeltaUpdate` (:1167) routes REAFFIRM/EXTEND/CONTRADICT/IRRELEVANT.
- Per-cluster dirty table — `ClusterIndex` + `cluster_index` table (`dirtyCount`, `recallCount30d`, `lastTickAt`) migrated; `bumpDirty`/`upsertOnSynthesis` implemented (only ingest-time wiring missing).
- Synthesis storage + embedding + Derives edges — `_writeSynthMemory` (:1599), `_embedSynthMemory` (:1838) to per-tenant Qdrant, `_linkDerivesEdges` (:1867).
- Governance agents + evolution engine — Faraday/Feynman/Turing via `run-manager.runFullCycle` (:803); `evolution-engine.js` self-tunes recall config via Recall@K replay.

**The 5 confirmed gaps → 5 workstreams:**

| # | Workstream | Effort | Risk | Headline |
|---|---|---|---|---|
| WS1 | Event-driven adaptive trigger | M | low | Dream on dirty-threshold / idle, not just hourly |
| WS2 | Late-evidence recall fix | S | medium | Poisoned-preference fix at recall time (latency ~0) |
| WS3 | Retroactive re-sweep | L | medium | Re-score OLD facts vs full corpus; temper down |
| WS4 | Derivations graph + show-its-work | L | medium | `Implies`/`DependsOn` edges + validated proof tree |
| WS5 | Evolving user profile | XL | high | Self-updating persona, confidence decay, lineage |

**Build order = feasibility order:** WS1 → WS2 → WS3 → WS4 → WS5.

---

## 1. Research — target vs current

### 1.1 Supermemory "Dynamic Dreaming" claims
1. **Event-driven adaptive trigger** — dreams when user goes quiet OR enough context piled up; depth scales to session size; no fixed timer.
2. **Reconsolidate** — merge fragments, generate abstractions.
3. **Retroactive reweighting** — re-score OLD facts vs everything since; over-confident tempered, contradictions resolved on re-sweep, isolated memories find neighbors.
4. **Derivations graph** — inferences weaving between memories, each grounded/traceable ("show its work or it can't claim the thought").
5. **Evolving user profile** — weighted, self-updating "who the user actually is," not a static attribute list.
6. **Hybrid retrieval** — unprocessed content queryable instantly; dreamt state catches up ≤15 min.
7. **Poisoned-preference fix** — user debates A vs B, lands on B in the last message; naive systems wrote "prefers A" from the middle and poison every future session.

### 1.2 Mapping to HIVEMIND
| Claim | Status | Where |
|---|---|---|
| 2 Reconsolidate | ✅ have | drift compaction + synthesis-bridge |
| 4 Derivations (basic) | ⚠️ partial | only synthesis→source `Derives`; no cross-synthesis edges |
| 6 Hybrid retrieval | ✅ have | dropped as already-built |
| 1 Event-driven trigger | ❌ gap | fixed 1h cron (`COGNITION_INTERVAL_MS`); `_shouldRunForOrg` is a skip-gate, not a trigger |
| 3 Retroactive reweight | ❌ gap | rolling 1h window only (`_cognitionWindow`); confidence write-once, ratchets UP only |
| 5 Evolving profile | ❌ gap | static `UserProfile`, non-decaying confidence, single source, no vector |
| 7 Poisoned-preference | ❌ gap | recall contradiction penalty flat ×0.40, discards edge timestamps |

---

## 2. Workstreams (feasibility → complexity)

### WS1 — Event-driven adaptive trigger `[M / low]`

**Goal.** Dream when a cluster accumulates enough new evidence OR the org goes
quiet — not only on the 1h tick. Depth scales to ingest velocity. Mostly wiring
of already-built `ClusterIndex.bumpDirty`.

**Exact changes.**
- `graph-engine.js ingestMemory` (:449): after a successful **non-synthesis** save, derive the cluster hash (tag-intersection over `entity:`/`topic:` tags, same as cognition) and call `this.clusterIndex.bumpDirty({organizationId, userId, clusterHash, clusterType})` **fire-and-forget**. Guard with `input.cognitive_layer_role == null` so synthesis writes don't self-trigger. Makes `dirtyCount` a READ signal (resolves `cluster-index.js:85` TODO).
- `cluster-index.js`: re-add `getDirtyClusters({organizationId, minDirty})` → rows WHERE `dirty_count >= threshold`; add `markActivity({organizationId, at})` + `idleSince({organizationId})` backed by a new nullable `last_activity_at` column.
- `scheduler.js ResidentAgentScheduler`: add a fast inner timer (default 60s, `COGNITION_DIRTY_POLL_MS`) → `_maybeEarlyDream()`: for each active org, if `getDirtyClusters(threshold=COGNITION_DIRTY_THRESHOLD default 5)` returns hot clusters OR `idleSince > COGNITION_IDLE_MS` (default 5min) with `dirtyCount>0`, invoke `cognitionLoop.runOnce(orgId)` out-of-band. Keep 1h baseline tick as floor.
- `cognition-loop.js _shouldRunForOrg` (:384): add reason `early_dream_dirty` bypassing the no-new-activity gate when invoked via early-dream; scale `clusterMin` DOWN with dirty velocity: `clusterMin = max(SOFT, deriveClusterMin - floor(dirtyCount/20))`.
- `server.js`: ensure `engine.clusterIndex` is the shared instance so ingest can reach it.

**Files.** `graph-engine.js`, `cluster-index.js`, `resident/scheduler.js`, `cognition-loop.js`, `prisma/schema.prisma` (`ClusterIndex.last_activity_at`, nullable).

**Performance pipeline.** `ingest → bumpDirty (async, ~0 added latency) → cluster_index.dirty_count++ → 60s poll reads hot clusters → early dream (budget-gated) → upsertOnSynthesis resets dirty_count`.

**Beyond SM.** Connector ingestion (Gmail/Slack/Docs) routes through the same `ingestMemory`, so a connector burst triggers a dream — cross-connector clusters consolidate on arrival. Chat-only systems can't.

---

### WS2 — Late-evidence / poisoned-preference fix `[S / medium]` ⭐ highest value/effort

**Goal.** When the user lands on B in the last message after debating A, B
outranks A on the **very next** recall — no cron wait. Make the contradiction
penalty temporal.

**Exact changes (all in `persisted-retrieval.js`).**
- `buildContradictedIndex` (:367): change return from `Set<toId>` to `Map<toId,{createdAt, fromId, confidence}>` capturing the newest `Contradicts` edge per target (`relationships.created_at` exists, schema :855).
- Scoring (:1267, :1338, :1382): replace flat `score *= 0.40` with temporal multiplier: `penalty = clamp(0.40 + (1-0.40)*min(edgeAgeDays/CORRECTION_HALFLIFE_DAYS,1), 0.40, 0.90)`. Fresh contradiction → 0.40 (hard demote); 30d+ → ~0.85 (soft). `CORRECTION_HALFLIFE_DAYS` default 14.
- Add "correction winner" boost: a memory that is the `from_id` (source) of a recent `Contradicts`/`Updates` edge → ×up to 1.20 scaled by recency, so the latest stated preference floats up.
- Final sort tiebreak: two candidates within epsilon and one Contradicts the other → prefer the contradiction **source** (later-stated). Message-order-wins.
- `graph-engine.js` :1399–1428: confirm the within-session `Contradicts` edge is written **synchronously** at ingest (it is, via conflict-detector) so the fix takes effect immediately.

**Files.** `persisted-retrieval.js` (+ verify `graph-engine.js` synchronous edge write).

**Performance pipeline.** No new job. `ingest writes Contradicts edge synchronously → next recall: buildContradictedIndex carries edge age → temporal penalty + winner boost applied in-scoring`. Added recall cost: one extra field per contradicted candidate, O(candidates).

**Beyond SM.** Fix lands on the **literally next query** (latency ~0) because the edge is written synchronously at ingest. Supermemory catches up "within ~15 min"; the WS3 background dream only deepens ours.

**Risk.** Scanner-created edges carry **scan-time**, not statement-time. Must distinguish ingest-time edges (`conflict-detector`) from scan-time edges via `createdBy`, or old facts get falsely treated as "just corrected."

---

### WS3 — Retroactive re-sweep `[L / medium]`

**Goal.** The missing backward sweep: re-examine syntheses created weeks/months
ago against everything since; temper over-confident claims **downward**; resolve
late contradictions; relink isolated memories. Reuses `_maybeDeltaUpdate`.

**Exact changes.**
- `cognition-loop.js`: add `reweightStaleForOrg(orgId)` as **Pass 4**. Select synthesis memories WHERE `cognitiveLayerRole IN (canonical,bridge,principle)` AND `isLatest=true` AND `updatedAt < now - STALE_REWEIGHT_DAYS` (default 7), oldest-first, capped `REWEIGHT_MAX_PER_TICK` (default 20).
- For each stale synthesis: fetch its cluster's CURRENT members via `synthesisEvidenceIds` + tag-intersection over **FULL history** (explicitly bypass `_cognitionWindow`/`ROLLING_WINDOW_HOURS` — the ONE place we read >1h), then `_maybeDeltaUpdate({existing, newMemories: membersAddedSince(existing.updatedAt), allMembers})`.
- `_capConfidence`: add a **downward** path — on CONTRADICT or when N contradicting edges now point at the synthesis, allow confidence to LOWER: `finalConf = priorConf * (1 - 0.15*contradictionCount)`, floor 0.3. (Currently ratchets up only.)
- "Isolated memory finds neighbors": for synthesis/raw fact-decision memories with zero `Derives`/`Extends` edges, run bridge-eligibility against current centroids; create `Derives`/bridge if cosine in `[BRIDGE_SIM_LOW, BRIDGE_SIM_HIGH]` with entity grounding (reuse edgeless-relink concept).
- `scheduler.js _tickTier`: add a `reweight` tier on a slow multiple (every 12 ticks) gated by budget-pool `affordTier`.
- Cascade: when a re-sweep lowers a synthesis confidence that a WS5 profile fact derived from, downgrade that profile fact (lineage).

**Files.** `cognition-loop.js`, `resident/scheduler.js`, `resident/run-manager.js`.

**Performance pipeline.** `slow tier (every 12 ticks) → select ≤20 stale syntheses oldest-first → per synthesis: full-corpus cluster fetch (bounded to that cluster's members) → _maybeDeltaUpdate LLM call → confidence temper + edge updates → budget-pool affordTier gates total LLM spend`.

**Beyond SM.** **Transitive** tempering: when a re-sweep finds source B now Contradicts source C of a derived synthesis A, walk the AGE `Derives` edges and re-flag A. Supermemory reweights flat facts; we reweight a traceable derivation tree and fan high-stakes (principle-tier) reversals to the **Feynman** governance agent for verification.

**Risk.** Reading beyond 1h is a deliberate break of the "no historical backfill" invariant — scope ONLY to the reweight pass over already-synthesized clusters, never first-pass synthesis (token cost). Confidence oscillation → hysteresis (temper only when contradictionCount increases) + per-revision cap + `REWEIGHT_MAX_PER_TICK`.

---

### WS4 — Derivations graph + grounded show-its-work `[L / medium]`

**Goal.** Inferences weave between memories and are traceable. Add
`Implies`/`DependsOn` edges, drain the orphaned `DerivationJob` queue, expose a
proof-tree endpoint with grounding validation.

**Exact changes.**
- `schema.prisma RelationshipType` enum (:1305): add `Implies`, `DependsOn` (additive, backward-compatible migration).
- `cognition-loop.js _writeSynthMemory`/`_linkDerivesEdges` (:1760, :1867): after synthesis→source `Derives`, detect cross-synthesis dependency — bridge evidence overlaps an existing canonical's `cluster_hash` → `DependsOn` bridge→canonical; principle generalizes ≥2 canonicals → `Implies` principle→canonical. Store `source_ids` in metadata.
- `validateGrounding(synthId)`: read `synthesisEvidenceIds`, check which still exist (`deletedAt null`); if any source deleted → mark `metadata.grounding='partial'` + queue re-sweep (feeds WS3).
- **New** `derivation-job-processor.js`: consume `DerivationJob` (schema :825, currently enqueued at `graph-engine.js` but never drained) — evaluate queued source→target `Derives` candidates, validate grounding, write or reject. Run from `scheduler.js` on the dirty-poll tick.
- `server.js`: `GET /api/cognition/derivation/:memoryId` — BFS `Derives`/`DependsOn`/`Implies` depth-N, return proof tree `{claim, depends_on:[...], grounded_in:[raw ids], grounding_status}`.
- `persisted-retrieval.js`: optionally surface compact `derivation_trace` in recall (`expansion_metadata` exists :859–864) so the agent answers "why do you think X" inline.

**Files.** `schema.prisma`, `cognition-loop.js`, **new** `derivation-job-processor.js`, `resident/scheduler.js`, `server.js`, `persisted-retrieval.js`.

**Performance pipeline.** `synthesis write → cross-synthesis edge detection (cluster_hash overlap, in-process) → DerivationJob enqueue → dirty-poll tick drains processor → grounding validation (existence check) → edge write/reject`. Proof-tree endpoint: read-only BFS, bounded depth-N.

**Beyond SM, outright.** Their show-its-work is generated text; ours is a
**queryable, validated proof tree** of real AGE edges with a grounding-status
flag that detects deleted sources. Transitive `DependsOn` enables impact
analysis ("if this canonical is false, which bridges break").

---

### WS5 — Evolving, grounded, vector-indexed user profile `[XL / high]`

**Goal.** Turn static `UserProfile` (non-decaying confidence, single source, no
vector) into a weighted self-updating persona with confidence decay, multi-source
lineage, a rolling "who is this user now" memo, and hybrid retrieval.

**Exact changes.**
- `schema.prisma UserProfile` (:1227): add `evidenceMemoryIds String[]`, `lastDreamedAt DateTime?`, keep `confidence` — all nullable/defaulted.
- `profile-store.js upsertFact` (:57): on contradiction, stop hard-resetting `confirmedCount=1` + overwriting — append the new value as competing evidence; let a dream pass arbitrate; record both source ids in `evidenceMemoryIds`.
- **New** `profile-dreamer.js`: `dreamProfileForUser(userId, orgId)` on the WS1 idle/dirty trigger + WS3 cadence:
  - (a) LLM-synthesize a rolling persona memo from recent + high-confidence facts (mirror `topic-state-writer.js`, user-scoped).
  - (b) age-based confidence decay: `confidence *= exp(-daysSinceConfirmed/PROFILE_HALFLIFE_DAYS)` so "works at Acme" rots without re-confirmation.
  - (c) replay full conversation transcripts for multi-turn sessions, re-extract **FINAL-state** preference (fixes poisoned-preference + the tree-ingestion `extractAndStore` skip).
- `profile-store.js getProfile`/`buildProfileContext` (:217): weight facts by decayed confidence, surface the memo, expose `evidenceMemoryIds` (show its work).
- `profile-dreamer.js`: embed the persona memo to per-tenant Qdrant (reuse `_embedSynthMemory`) → hybrid vector+SQL profile recall.
- `scheduler.js`: invoke `profile-dreamer` on the WS1 early-dream path for users active in the quiet window (depth scales to session size).

**Files.** `schema.prisma`, `profile-store.js`, **new** `profile-dreamer.js`, `resident/scheduler.js`, `persisted-retrieval.js` (profile injection ~:1874 reads decayed/weighted persona).

**Performance pipeline.** `session close / idle trigger → profile-dreamer → (transcript replay → final-state extract) + (decay sweep) + (persona memo LLM) → embed memo to Qdrant → recall: decayed-weighted facts + memo via hybrid`.

**Beyond SM.** Org-aware + connector-fed (a Slack/Gmail signal updates the
persona); every profile fact carries multi-memory derivation lineage; decay is
evidence-driven so stale facts self-deprecate rather than persisting at 1.0.

**Risk.** Transcript replay is expensive + touches the tree-ingestion skip path
→ dedupe, run only on session close, depth-scaled. New Qdrant point class must
not collide with memory point ids + be excluded from normal recall unless
requested.

---

## 3. Cross-cutting performance & data pipelines

**Trigger pipeline (WS1).** Hot path adds only a fire-and-forget `bumpDirty`
(try/catch, must never block a save). A 60s poll reads `cluster_index`; early
dreams are budget-gated by the existing `affordTier`. 1h baseline tick remains a
floor.

**Recall pipeline (WS2).** Zero new jobs; one extra map lookup + multiplier per
contradicted candidate. Synchronous ingest-time edge write means correctness is
immediate.

**Dream pipelines (WS3/WS4/WS5).** All run on the `ResidentAgentScheduler` tiers
(fast dirty-poll 60s; bridge every 4 ticks; compaction + reweight every 12
ticks) under `budget-pool affordTier` so total LLM spend is bounded per org per
window. WS3/WS5 are the only passes allowed to read beyond the 1h window, scoped
to already-synthesized clusters / a single user's session.

**Cost guards.** `COGNITION_DIRTY_THRESHOLD`, `COGNITION_IDLE_MS`, early-dream
cooldown (reuse `COOLDOWN_HOURS`), `REWEIGHT_MAX_PER_TICK`, `STALE_REWEIGHT_DAYS`,
`PROFILE_HALFLIFE_DAYS`, `CORRECTION_HALFLIFE_DAYS` — all env-tunable, all
behind flags for safe rollout/revert.

---

## 4. Schema migrations (backward-compatible, up + down tested)
- `ClusterIndex.last_activity_at DateTime?` (WS1)
- `RelationshipType` enum + `Implies`, `DependsOn` (WS4) — audit every `switch`/`normalizeRelationshipType` over edge types; the enum is referenced by AGE graph projection + recall relationship-decay.
- `UserProfile.evidenceMemoryIds String[]`, `UserProfile.lastDreamedAt DateTime?` (WS5)

---

## 5. Sequencing & dependencies
1. **WS1** — precondition; lets everything dream reactively. Behind `COGNITION_DIRTY_THRESHOLD`/`COGNITION_IDLE_MS`; 1h floor stays.
2. **WS2** — isolated to scoring, no schema, no job. Fixes headline bug immediately. Behind `CORRECTION_HALFLIFE_DAYS`.
3. **WS3** — depends on WS1 cadence; reuses WS2 temporal signal. Slow tier + budget gate.
4. **WS4** — schema migration; lands after scoring/trigger stable. Additive, read-mostly.
5. **WS5** — largest surface; depends on WS1 trigger + WS3 reweight + WS4 lineage. Per-user flag + poisoned-preference regression test before org-wide.

---

## 6. Top risks → mitigations
- **Trigger storm** (connector bulk-sync) → dirty-threshold + early-dream cooldown + `affordTier`.
- **Hot-path coupling** → `bumpDirty` strictly fire-and-forget try/catch; never gate a save.
- **Edge-timestamp trap** (WS2) → filter ingest-time vs scan-time edges by `createdBy`.
- **Confidence oscillation** (WS3) → hysteresis + per-revision cap.
- **1h-window invariant break** (WS3) → scope strictly to reweight pass over synthesized clusters.
- **Migration safety** (WS4/WS5) → backward-compatible, up+down tested, enum-consumer audit.
- **Transcript replay cost** (WS5) → session-close only, dedupe, depth-scaled.
- **Qdrant point collision** (WS5) → distinct point class, excluded from default recall.

---

## 7. Regression / test plan
- **Poisoned-preference golden test** (WS2 + WS5): ingest a multi-turn A-vs-B debate ending on B → assert next recall ranks B above A; assert profile fact = B.
- WS1: ingest N memories in one cluster → assert early dream fires before the 1h tick; assert no dream during connector bulk-sync beyond threshold (storm guard).
- WS3: seed an old over-confident synthesis + later contradicting evidence → assert confidence tempered downward, floored 0.3.
- WS4: build canonical→bridge→principle chain → assert `DependsOn`/`Implies` edges + proof-tree endpoint returns grounded tree; delete a source → assert `grounding='partial'`.
- All schema migrations tested up AND down. Mock all LLM/embedding calls in tests.
