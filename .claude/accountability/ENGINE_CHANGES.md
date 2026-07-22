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
