# Cross-Platform Decision Intelligence

**Date**: 2026-03-27
**Status**: Design Document (Ready for Implementation Planning)
**Scope**: Commercial wedge — detect, link, store, and recall organizational decisions across Gmail/Slack/GitHub
**Prerequisite**: CSI v1 complete (Trail Executor, Blueprints, Identity, Meta-Loop)

---

## Executive Summary

Cross-Platform Decision Intelligence is the first commercial wedge for CSI. It detects decisions scattered across Gmail, Slack, and GitHub, links cross-platform evidence, stores structured decision objects with provenance, and enables accurate recall with rationale and evidence chains.

The system uses a hybrid detection pipeline: high-recall heuristics flag candidates cheaply, then a high-precision LLM confirms and extracts structured decision data. Only validated decisions enter canonical memory.

**The one-sentence claim:**

> CSI converts fragmented cross-platform activity into persistent, reusable decision intelligence with provenance.

---

## Decision Object Schema

### Two-Tier Model

Decisions progress through two tiers:
- **`decision_candidate`** — detected but not yet validated (single source, low confidence, or ambiguous)
- **`validated_decision`** — confirmed with sufficient confidence and cross-platform evidence

### Schema

```js
{
  // Core identity
  id: uuid,
  type: "decision_candidate" | "validated_decision",
  decision_key: string,            // canonical dedup key: hash(project + decision_type + normalized_statement)

  // The decision itself
  decision_statement: "Use Redis for caching instead of Postgres",
  decision_type: "choice" | "approval" | "rejection" | "priority" | "assignment" | "resolution" | "policy",

  // Rationale + context
  rationale: "Redis handles cache invalidation natively, lower latency for hot keys",
  alternatives_rejected: ["Postgres with materialized views", "Memcached"],

  // Participants
  participants: [
    { name: "Alice", role: "proposer", platform: "slack" },
    { name: "Bob", role: "approver", platform: "gmail" }
  ],

  // Cross-platform evidence (the provenance chain)
  evidence: {
    supporting: [
      { platform: "slack", ref_id: "msg_123", channel: "#architecture", snippet: "I think Redis is the way to go", timestamp: "..." },
      { platform: "gmail", ref_id: "thread_456", subject: "Re: Caching strategy", snippet: "Approved, let's proceed", timestamp: "..." },
      { platform: "github", ref_id: "pr_789", repo: "acme/backend", snippet: "Implement Redis cache layer", timestamp: "..." }
    ],
    conflicting: [
      { platform: "slack", ref_id: "msg_100", snippet: "I still think Postgres is simpler", timestamp: "..." }
    ]
  },

  // Confidence + lifecycle
  confidence: 0.85,               // LLM classification confidence
  evidence_strength: 0.9,         // cross-platform corroboration score
  status: "candidate" | "validated" | "superseded" | "revoked",
  decision_state_reason: "cross_platform_corroborated",  // why this status

  // Scope
  scope: { project: "acme-backend", team: "platform", repo: "acme/backend" },

  // Relationships (typed)
  relationships: [
    { type: "supersedes", target_id: "decision_old_123" },
    { type: "implements", target_id: "decision_arch_456" }
  ],
  // Relationship types: supersedes, contradicts, implements, follows_from

  // Metadata
  detected_at: "2026-03-27T...",
  validated_at: "2026-03-27T..." | null,
  detected_by: "heuristic_gmail",
  confirmed_by: "llm_classifier",
  source_platform: "gmail",

  // Tags for retrieval
  tags: ["caching", "redis", "architecture", "backend"],
}
```

**Confidence definition**: Classifier confidence that this item represents a real decision (0-1).

**Evidence strength definition**: Cross-platform corroboration score. Higher when multiple independent platforms provide supporting evidence for the same decision (0-1).

**Decision state reasons**: `single_source_only`, `low_classifier_confidence`, `cross_platform_corroborated`, `manual_validation`, `superseded_by_newer_decision`.

### Promotion Rules

| Condition | Result | State Reason |
|-----------|--------|-------------|
| LLM confidence ≥ 0.8 AND ≥ 2 evidence sources | Auto-validate | `cross_platform_corroborated` |
| LLM confidence ≥ 0.6 AND 1 evidence source | Stay candidate | `single_source_only` |
| LLM confidence < 0.6 | Discard or observation | `low_classifier_confidence` |
| New evidence arrives for existing candidate | Re-evaluate, may promote | `cross_platform_corroborated` |

### Storage

Decisions are stored as memories (`memory_type: "decision"`) in the existing Prisma `Memory` table. Decision-specific fields are stored in a JSON metadata column. This reuses existing search, graph traversal, and recall infrastructure.

---

## Tools

### 5 New Tools

#### `detect_decision_candidate`

High-recall heuristic scanner. No LLM call — pure JS pattern matching.

```
Input:  { content: string, platform: "gmail"|"slack"|"github", metadata: { threadId?, eventType?, channel? } }
Output: { is_candidate: boolean, signals: string[], confidence: number, needs_more_context: boolean }
```

**Heuristic signals by platform:**

| Platform | Signals |
|----------|---------|
| Gmail | Phrases: "approved", "let's go with", "decided to", "we agreed". Reply-chain with resolution pattern. |
| Slack | Phrases: "we're going with", "closing this", "final answer". Emoji reactions (checkmark, thumbsup). Thread resolution pattern. |
| GitHub | Event types: PR merged, issue closed with comment, review approved, label "decision". Close/merge comments with rationale. |

#### `classify_decision`

LLM-based confirmation + structured extraction via Groq API.

```
Input:  { content: string, platform: string, context: { signals: string[], thread_context?: string } }
Output: {
  is_decision: boolean,
  decision_type: string,
  decision_statement: string,
  rationale: string,
  alternatives_rejected: string[],
  participants: { name, role, platform }[],
  confidence: number,
  needs_more_context: boolean
}
```

#### `link_evidence`

Cross-platform search for corroborating and conflicting evidence.

```
Input:  { decision_statement: string, tags: string[], source_platform: string, scope?: object }
Output: {
  supporting: Evidence[],
  conflicting: Evidence[],
  evidence_strength: number,
  related_decisions: { id, relationship_type, statement }[]
}
```

Uses existing `searchMemories()` across platforms + `traverse_graph` for relationship discovery.

#### `store_decision`

Writer only — does not judge. Persists the decision object as assembled by upstream steps. Handles merge-on-`decision_key`.

```
Input:  { decision_object: DecisionObject }
Output: { decision_id: string, status: string, merged: boolean, stored: true, done: true }
```

**Merge behavior**: If a decision with the same `decision_key` already exists:
- Merge new evidence into existing evidence arrays
- Update status if evidence now crosses validation threshold
- Do not create duplicate decision memories

#### `recall_decision`

Provenance-aware decision retrieval with multi-signal ranking.

```
Input:  { query: string, scope?: object, project?: string, top_k?: number }
Output: {
  decisions: [{
    decision_statement, rationale, evidence, participants,
    confidence, evidence_strength, status, detected_at,
    recall_score, completeness_score
  }],
  total_found: number,
  done: true
}
```

**Ranking formula** (multi-signal, not just semantic similarity):

```
recall_score = 0.35 * semantic_match
             + 0.20 * (validated > candidate ? 1 : 0.5)
             + 0.15 * evidence_strength
             + 0.15 * recency_score
             + 0.10 * scope_match
             + 0.05 * (1 - contradiction_penalty)
```

---

## Trails

### 10 Seeded Trails

**Capture trails (per-platform):**

| # | Trail | Tool | Tags |
|---|-------|------|------|
| 1 | Gmail decision detection | `detect_decision_candidate` | `[gmail, detect]` |
| 2 | Slack decision detection | `detect_decision_candidate` | `[slack, detect]` |
| 3 | GitHub decision detection | `detect_decision_candidate` | `[github, detect]` |
| 4 | LLM decision classification | `classify_decision` | `[classify]` |
| 5 | Cross-platform evidence linking | `link_evidence` | `[link, evidence]` |
| 6 | Decision storage | `store_decision` | `[store, decision]` |

**Recall trails:**

| # | Trail | Tool | Tags |
|---|-------|------|------|
| 7 | Decision recall by query | `recall_decision` | `[recall, query]` |
| 8 | Decision recall by scope | `recall_decision` | `[recall, scope]` |

**Composite trails (blueprint candidates):**

| # | Trail | Sequence | Tags |
|---|-------|----------|------|
| 9 | Full capture pipeline | `detect → classify → link → store` | `[capture, pipeline]` |
| 10 | Evidence-enriched recall | `recall → link` | `[recall, enriched]` |

### Blueprint Formation

Trail 9 (`detect>classify>link>store`) is expected to become a blueprint after ~3 successful captures. Once promoted, the capture pipeline executes as a single composite step with per-step events preserved.

---

## Execution Flows

### Flow 1: Decision Capture

```
POST /api/swarm/execute { goal: "capture_decision", agent_id: "gmail_scanner" }

  ForceRouter selects trail based on:
    - platform affordance (gmail → trail 1, slack → trail 2, github → trail 3)
    - blueprint availability (composite trail 9 if promoted)

  Step 1: detect_decision_candidate
    → { is_candidate: true, signals: ["phrase:approved", "reply_chain:resolution"], confidence: 0.7 }

  Step 2: classify_decision (only if candidate)
    → { is_decision: true, decision_type: "approval", statement: "Use Redis for caching",
        rationale: "Lower latency", participants: [{name: "Alice", role: "proposer"}], confidence: 0.85 }

  Step 3: link_evidence
    → { supporting: [slack_msg, github_pr], conflicting: [], evidence_strength: 0.9 }

  Step 4: store_decision
    → status computed from promotion rules: confidence 0.85 + 3 sources = "validated"
    → { decision_id: "uuid", status: "validated", merged: false, done: true }
```

### Flow 2: Decision Recall

```
POST /api/swarm/execute { goal: "recall_decision" }

  Step 1: recall_decision
    Input: { query: "Why did we choose Redis?", scope: { project: "acme-backend" } }
    → { decisions: [{
          statement: "Use Redis for caching instead of Postgres",
          rationale: "Lower latency for hot keys",
          evidence: { supporting: [slack, gmail, github], conflicting: [1 dissent] },
          participants: [Alice (proposer), Bob (approver)],
          confidence: 0.85, evidence_strength: 0.9,
          recall_score: 0.92, completeness_score: 0.95
        }],
        done: true }
```

### Platform-Aware ForceRouter

For this wedge, affordance scoring includes platform context:

| Platform + Event | Affordance Boost |
|-----------------|-----------------|
| GitHub PR merged / issue closed | +0.4 (strong decision signal) |
| Gmail reply chain with "approved" | +0.3 |
| Slack thread with resolution emoji | +0.2 |
| General content (no decision signal) | +0.0 |

---

## Success Metrics + Benchmark

### 3 Core Metrics

| Metric | Definition | Target |
|--------|-----------|--------|
| **Decision Detection Recall** | Of real decisions in test corpus, % detected as candidates | ≥ 90% |
| **Decision Classification Precision** | Of items classified as decisions by LLM, % that are actually decisions | ≥ 85% |
| **Decision Recall Accuracy** | When asked "why did we decide X?", correct decision returned with rationale + evidence | ≥ 80% |

### Strict Definition of "Correct Recall"

A recall is correct **only if all three hold**:
1. Decision statement matches ground truth (or is semantically equivalent)
2. Rationale contains at least 1 correct justification from ground truth
3. At least 1 valid cross-platform evidence source is linked

### Additional Metrics

| Metric | Definition |
|--------|-----------|
| **Top-1 Accuracy** | Correct decision is the #1 ranked result |
| **Top-3 Accuracy** | Correct decision is in the top 3 results |
| **Completeness Score** | % of ground truth evidence sources that were linked |
| **Time-to-Answer** | Latency from query to full decision reconstruction with evidence |
| **Fragmentation Penalty** | Reduction for partial/incomplete decision reconstruction |
| **Mislink Rate** | % of decisions with incorrectly merged or mislinked evidence |

### Benchmark Design

**Ground Truth Dataset: 50 items**
- 20 clear decisions (approvals, merges, choices with rationale)
- 15 ambiguous items (discussions that look like decisions but aren't)
- 15 non-decisions (status updates, questions, FYIs)

For each real decision: document the statement, rationale, evidence sources, participants.

**Benchmark Steps:**

1. **Detection test**: Feed all 50 through heuristic pipeline → measure recall, precision
2. **Classification test**: Feed candidates through LLM classifier → measure precision, F1
3. **Recall test**: For each of 20 real decisions, ask natural language question → measure accuracy (top-1, top-3), completeness, time-to-answer
4. **Baseline comparison**: Run same recall questions against 3 baselines

### Baseline Comparisons

| System | Description |
|--------|-------------|
| Plain search | `searchMemories(query)` — raw semantic search, no decision structure |
| Single-platform | Search only the platform where the question originated |
| CSI without blueprints | Full pipeline but no blueprint formation |
| **CSI full** | Complete pipeline with blueprints, identity, meta-loop |

### Operational Metrics (Post-Launch)

Track via Dashboard:
- Decisions captured per day
- Candidate → validated promotion rate
- Cross-platform evidence link rate (% with ≥ 2 platform sources)
- Recall response latency
- False positive rate (decisions later revoked/superseded)
- Blueprint formation rate for capture flows

---

## Implementation Path

### Phase 1: Tools + Heuristics
- Implement `detect_decision_candidate` (heuristic engine)
- Implement `classify_decision` (Groq LLM wrapper)
- Implement `link_evidence` (cross-platform search + graph traversal)
- Implement `store_decision` (merge-on-key, promotion logic)
- Implement `recall_decision` (multi-signal ranking)
- Register all 5 tools in server.js

### Phase 2: Trails + Execution
- Seed 10 trails for capture and recall flows
- Wire capture flow into connector sync hooks (Gmail/Slack/GitHub)
- Test full capture pipeline end-to-end
- Test recall pipeline end-to-end

### Phase 3: Ground Truth + Benchmark
- Curate 50-item ground truth dataset from real connector data
- Run detection + classification benchmark
- Run recall benchmark against baselines
- Capture metrics

### Phase 4: Blueprint Formation + Optimization
- Run capture pipeline 20+ times → verify blueprint forms
- Measure blueprint vs raw trail performance
- Tune parameters via MetaEvaluator
- Produce final benchmark report

---

## Success Criteria

- [ ] Heuristic detector catches ≥ 90% of real decisions (recall)
- [ ] LLM classifier achieves ≥ 85% precision on candidates
- [ ] Decision recall accuracy ≥ 80% (top-1) with correct rationale + evidence
- [ ] Top-3 recall accuracy ≥ 90%
- [ ] Cross-platform evidence linked for ≥ 70% of validated decisions
- [ ] Capture pipeline forms a blueprint after ~3 successful runs
- [ ] Merge-on-key prevents duplicate decisions from multiple platforms
- [ ] Full provenance chain visible in recall results
- [ ] CSI outperforms plain search baseline on recall accuracy by ≥ 20 points
- [ ] Time-to-answer < 3 seconds for decision recall

---

## Document History

| Date | Version | Status |
|------|---------|--------|
| 2026-03-27 | 1.0 | Design Complete, Ready for Implementation Planning |
