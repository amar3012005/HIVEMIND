# HIVEMIND Engine — Accountability Log

Running record of every change made to the HIVEMIND **engine** (recall / chat /
memory / graph / ingestion). One entry per shipped change: what, why, files,
deploy SHA, verification, rollback. Newest first. This is the audit trail —
append here whenever the engine changes. Deep operating knowledge + root causes
live in `.claude/skills/hivemind-engine.md` (the self-improving ledger); this
file is the concise "what changed and is it live" register.

Engine scope = `core/src/memory/*`, `core/src/knowledge/*`, `core/src/agent/*`,
`core/src/llm/*`, `core/src/vector/*`. All HIVEMIND engine work goes through the
`hivemind-engine` skill + the live-engine probe technique.

---

## 2026-07-22 (d) — Final recon + double-boost fix (declare-done gate)
**Release:** `prod-20260722-6339cc321` (live, flag on) · **Rollback:** `:stable` = `prod-20260722-abf1dfb87`
**Status:** LIVE + verified. Pushed singulance-main.

Two parallel recon agents (flags matrix; language/tenant-neutrality sweep) + a
direct RRF/scoring review. Results:
- **Flags:** all critical V5 flags correct (type-aware ON, corroboration-dedup OFF,
  canonical ON, entity-persist ON, rerank ON/cohere, entity-hop0 ON, progressive
  router, claim-structuring ON). MEMORY_FACT_CHILDREN_ENABLED OFF is intentional
  (V5 uses distill/section-tree). NOTE: RERANK_API_KEY is a live secret in plaintext
  /root/hivemind/.env:301 — rotate / move to secret store.
- **RRF:** reciprocalRankFusionMemories uses `1/(RRF_K + rank + 1)`, k=60, 1-based
  rank — canonical. Multi-retriever fusion is a documented max-score merge (not RRF)
  upstream. Boosts compose on `score` (what floor/MMR use); type-scoped injected
  candidates at score 0.55 are on the base scale; cohere rerank is the final arbiter.
- **BLOCKER FIXED:** detectMemoryTypeBoost (English-keyword) ran ungated and
  double-boosted (~×2.56, English-only) against the planner-driven boost. Gated
  behind !structured_intent → under the progressive router the language-neutral
  planner signal is the sole type mechanism. Verified: EN and DE "what did we decide"
  now return the same decision answer.

**Known non-blocking limitations (graceful degradation, English-specific, ungated —
future multilingual-hardening pass, NOT corruption):** temporal-intent detectors
(isTemporalComparisonQuery/detectTimeTravelIntent, persisted-retrieval), relative/
month date parsing on LLM-extracted content (graph-engine parseEventDates), and the
English stopword set in entity-normalize (isJunkEntity). Each under-fires for
non-English (missing time-travel lane / event tags / bare-English-word entity drop)
without corrupting data. PROFILE_RE is 4-language but a gated accept-only fast path
with LLM fallthrough (acceptable).

---

## 2026-07-22 (c) — D5 type-aware recall LIVE (language-neutral answer_type)
**Release:** `prod-20260722-abf1dfb87` (live, flag `V5_TYPE_AWARE_RECALL=true`) · **Rollback:** `prod-20260721-011721c9a` (`:stable`) + flag off
**Status:** LIVE + verified (8/8 company Q&A incl. the failing decision query; 6/6 meeting set; German verified).

**Files:** `chat-progressive-router.js` (answer_type nullable-enum param + ALWAYS-classify rule + 2 examples), `chat-intent-decision.js` (plan.answer_type), `react-agent-v2.js` (args.answer_type), `tool-registry.js` (schema declaration + boost_memory_type option), `recall-router.js` (flag-gated type-scoped lane + soft boost).

**What it does.** The Cerebras planner now classifies, on every hivemind_context
call and in any language BY MEANING, the expected memory KIND (`answer_type`:
decision/goal/preference/lesson/event/relationship/fact/null). When set and the
flag is on, recall adds a TYPE-SCOPED candidate lane (anchored on the resolved
canonical entities via memoryEntityLink, hydrated through store.getMemories —
tenant-safe, cross-org guarded) so a type-matching memory is guaranteed to be a
candidate, then soft-boosts matching rows (never a hard filter). Retires the need
for the English-keyword detectMemoryTypeBoost path for these intents.

**Two live-integration root causes fixed:** (1) `answer_type` was not declared in
the hivemind_recall tool schema and validateAndSanitize STRIPS undeclared keys —
the signal was silently dropped; (2) the planner emitted null because the field
was a bare nullable string with weak guidance — now a nullable ENUM with a strong
required-classification description + system-prompt rule.

**Verified:** "What did we decide about SolvisPia 13 pricing?" → "We decided to
set the SolvisPia 13 list price at 4,500 EUR per unit" (was returning the margin
fact). German equivalent works. Aggregate/products, people, cross-source
synthesis, full meeting set — all green. Lane log: `type-scoped lane: +1
type=decision candidates`, `memory-type-boost: boosted=1/9`.

---

## 2026-07-22 (b) — Pure-insert hardening for meeting sections (fixes intermittent content loss)
**Release:** `prod-20260721-df34a73e3` (live) · **Rollback:** `:stable` = `prod-20260721-ac333045e` · **singulance-main** @ `df34a73e3`
**Status:** LIVE + verified (3x integrity + recall re-measure).

**Files:** `core/src/server.js` (meeting `baseChildMeta`), `core/src/knowledge/document-first-ingestion.js` (atomic passthrough).

**Bug:** the section-tree ingested each section via the atomic path with only
`skip_fact_extraction` + `smartIngest:false`. Under the concurrent 5-section
ingest, post-commit processing (contradiction detection / advisory-lock window)
INTERMITTENTLY mangled section content — quotes collapsed to one line (lost
header + timestamp stamp), sections dropped/superseded. Data-integrity regression.

**Fix:** opt meeting sections into the engine's `_pureInsert` fast path
(graph-engine.js:650) — requires ALL of `skipAdvisoryLock` + `skipPredictCalibrate`
+ (`smartIngest:false` | `skip_relationship_classification`) + `skip_contradiction_detection`.
First attempt (54c712d47) omitted `skipPredictCalibrate` so the gate never engaged
(3x test caught it — iteration 3 still failed); df34a73e3 added it. Forwarded the 3
new flags through the atomic passthrough (additive; undefined for other callers =>
no change to KB/chat/MCP/connector). Entity linking is `defer_entity_linking`-gated
(untouched) => canonical entities + typed edges + PartOf still land.

**Verified:** 3x meeting flow → all 5 sections present, `is_latest=t`, header+stamp
intact, quotes=5 every run. Recall re-measure: content fix RESOLVED "Hannover install"
+ "who works on Hannover" (were failing). RESIDUAL: "what did we decide about pricing"
still answers with the margin fact, not the `decision` memory (decision outranked by
co-topic memories; needs a decision-type signal). Proposed next: language-neutral
planner `memory_type` soft-boost hint (needs sign-off; borders Cerebras layer).

---

## 2026-07-22 — Meeting typed PartOf section-tree + adaptive synthesis budget
**Release:** `prod-20260721-ac333045e` (live, baked image, project `hivemind`)
**Rollback:** `hivemind/core-api:stable` = `prod-20260721-933147017`
**Branch:** `singulance-main` @ `ac333045e` (fast-forwarded; == live image)
**Status:** LIVE + verified. singulance-main aligned.

**Files**
- `core/src/server.js` — `/api/meetings/:id/ingest` facts path.
- `core/src/agent/react-agent-v2.js` — synthesis evidence formatter (~line 1321).

**Change 1 — meeting facts: `mode:'document'` → typed PartOf section-tree.**
- Old: one markdown note → LLM curator distill (`_promoteMemories`) → re-generated
  meaning, fragmented into claims, DROPPED the Notable-quotes section.
- New: parent memory (identity + participants, `event`) + one deterministically-typed
  child per non-empty insight section — Decisions→`decision`, Action items/Next steps→`goal`,
  Open questions→`fact`, Notable quotes→`event`. Each child PartOf→parent
  (`store.createRelationship`), verbatim (no LLM re-gen), ingested via the atomic
  path (`skip_fact_extraction:true`, `smartIngest:false`) which still runs entity
  extraction + canonical linking. Section TYPES come from the insight STRUCTURE,
  not heading text → language-neutral / tenant-neutral.
- Why: chat cited a single note as one `document_evidence` blob → section-specific
  questions ("notable quotes", "what did we decide") were unanswerable. Per-section
  typed memories make each answerable from the right memory, and each fits synthesis budget.

**Change 2 — synthesis per-memory content budget: flat 240 chars → adaptive.**
- `_evCount<=4 ? 1400 : (<=8 ? 700 : 300)`. The 240 cap hid everything past char 240
  in any rich memory. Fixes meetings AND all large memories (KB chunks, long notes).
  Bounded ~5-6k chars worst case; strengthens grounding; preserves [REMOVED/SUPERSEDED] markers.

**Verified (live)**
- Real meeting flow (insights→persist→ingest): 5 memories (parent + 4 typed sections),
  PartOf edges present, 5-7 canonical entities per section.
- Multi-source company test (KB+chat+slack+mcp+meeting, shared Solvis topics):
  cross-source entity linking OK (solvispia 13 / hannover / marco silva / r290 linked
  across sources); single-source fact recall OK; cross-source synthesis OK; meeting
  who/decide/action-items/quotes/next-steps answered.

**Open follow-up (NOT yet fixed):** recall-precision gap — when many memories share the
dominant entity, the specifically-relevant memory can fall out of top-K (flat ~0.52
vector scores). See skill ledger + memory `meeting-section-tree-and-recall-precision`.

---

## ≤ 2026-07-21 — V5 canonical engine (prior sessions; see skill ledger for detail)
Canonical envelope ingestion (`documentFirstIngestion.ingestSource`), universal
createMemory chokepoint, async multilingual claim structuring (subject/predicate/
qualifiers), EntityResolver + normalizeEntity + canonical_entities reuse, RecallRouter
(RRF/MMR/floor/collapse/cohere rerank), progressive router + Cerebras tool-calling,
EvidenceBus refactor, deletion guarantee, timestamp-on-every-memory. Full phase-by-phase
detail: memory `canonical-v5-progress` + skill LEARNINGS LEDGER.
**Do not modify the progressive router / Cerebras intent layer** without explicit sign-off.
