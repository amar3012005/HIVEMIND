# Phase 8 — Chat Grounding (thin over RecallPacket)   🟡 PARTIAL

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
