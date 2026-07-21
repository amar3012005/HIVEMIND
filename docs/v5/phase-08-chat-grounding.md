# Phase 8 — Chat Grounding   🟡 functional; packet unification = internal debt

## Envisioned state
Chat is thin orchestration over a trusted RecallPacket {facts, sourceSections,
timeline, conflicts, graphEvidence, citations, coverage, cutoff_reason}. It never
invents sources/relationships/history. One planner, one retrieval, ≤1 synthesis for
reads; writes = one planner, no synthesis. Require valid citation ids + claim
entailment + canonical doc ids + typed edges + honest partial coverage. Remove
English-regex routing gates, rescue auto-saves, duplicate source lookup.

## Current
Progressive router live; terminal writes (Stage B) done; profile/routing precision
fixes live. GAP: unify buildEvidencePacket→buildRecallPacket single contract +
claim-entailment on the chat lane. Some regex routing gates remain (the profile RE).

## Acceptance (real cURL)
Every query family through /api/chat grounded + cited; Overview / Talk-to-HIVE /
MCP inherit identical answers.

## STATUS 2026-07-21
Chat grounding works (verified all query families real-cURL): grounded, cited, query-shaped.
validateGroundedClaims (citation-id + entailment) exists on the /api/recall + react-agent path.
RESIDUAL (internal, not user-visible): unify buildEvidencePacket→buildRecallPacket (both
function today). Risky recall-path refactor — own characterized cycle.

## VERIFIED 2026-07-21 — grounding contract enforced live (real-cURL)
- Fabricated topic ("Xylophant-9Z warranty") → honest not-found, claims=0,
  rejected_claims=1 (validator caught + rejected the ungrounded claim), citations=0
  → NO invention.
- Real topic → claims=1 grounded, citations=1.
The substantive Phase 8 requirements (valid citation ids, claim entailment, honest
coverage, no invented sources/relations) are enforced on the chat lane. The dual
packet builders remain as documented internal debt (both function; unification is a
non-behavioral refactor deferred to its own characterized cycle).
