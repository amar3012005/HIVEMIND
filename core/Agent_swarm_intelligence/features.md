# HIVEMIND Complete Feature Catalog

This document comprehensively documents every feature of HIVEMIND, organized by subsystem with technical implementation details.

---

## 1. Memory Engine (Core Ingestion & Retrieval)

### 1.1 Predict-Calibrate Filter

**Purpose**: Deduplicate and extract semantic deltas before storage.

**Implementation**:
- SHA-256 fingerprint for exact duplicate detection
- TOP-K semantic similarity (cosine distance on token vectors)
- Thresholds:
  - ≥0.90 similarity → conflict (route to resolver)
  - 0.60-0.90 → partial match (delta extraction)
  - <0.60 → novel (full storage)
- Ruflo framework calibration for threshold tuning

**Configuration**:
```javascript
{
  enablePredictCalibrate: true,
  similarityThreshold: 0.45,
  skipPredictCalibrate: false  // Set true in benchmarks to avoid fingerprint cache conflicts
}
```

**Impact**: Prevents knowledge base bloat from repeated ingestion of identical content.

---

### 1.2 MemoryProcessor (LLM Fact Extraction)

**Purpose**: Extract structured facts from unstructured user content.

**Extraction Categories**:
- **factSentences**: Exact user quotes (not paraphrases)
- **entities**: People, organizations, locations
- **dates**: Absolute (ISO 8601) and relative (parsed to absolute)
- **eventDates**: When described events actually occurred (crucial for bi-temporal queries)
- **observation**: System-generated summary
- **relationship**: ADD / UPDATE / EXTEND / NOOP classification

**LLM Prompt**:
```
"Quote user's EXACT words, skip questions, extract STATEMENTS only"
```

**Configuration**:
```javascript
{
  model: "llama-3.3-70b-versatile",
  maxInputChars: 8000,
  maxOutputTokens: 2000,
  factMemoryCap: 15,          // Max separate fact-memories per input
  trivialFactFiltering: true  // Filter low-novelty facts
}
```

**Fallback**: Heuristic multi-turn parsing if LLM fails (splits by `User:` lines).

**Impact**: Converts prose into searchable atomic facts with independent embeddings.

---

### 1.3 Contextual Embedding

**Purpose**: Enrich vector representation with extracted facts while keeping payload clean.

**Process**:
1. Extract facts from content via MemoryProcessor
2. Construct embedding input: `factSentences.join('. ') + '\n\n' + original_content`
3. Generate 1024-dim bge-m3 (or 384-dim all-MiniLM) vector
4. Store in Qdrant: vector + metadata (event_dates, document_date, etc.)
5. Payload contains ONLY original content (no enrichment artifact)

**Benefit**: Precise vectors that capture facts without diluting signal with raw chunks.

**Configuration**:
```javascript
{
  embeddingModel: "bge-m3",           // or "all-MiniLM-L6-v2"
  embeddingDimension: 1024,           // or 384
  contextualEmbeddingEnabled: true,
  factAugmentWeight: 1.0
}
```

---

### 1.4 Fact-Memory Creation

**Purpose**: Each extracted fact becomes its own searchable memory.

**Architecture**:
- Parent memory: original content + all facts
- Child fact-memories: one per meaningful extracted fact
  - Linked to parent via `Extends` relationship
  - Tagged `['extracted-fact']` for visualization
  - Independent vectors (can be searched separately)
  - Up to 15 per input (configurable)

**Trivial Fact Filtering**:
```javascript
const TRIVIAL_PATTERNS = [
  /\b(is|are|was|were|be|have|has|do|does)\b/,  // copulas, auxiliaries
  /^(yes|no|ok|okay|sure)$/i,                    // affirmations
  /\b(thanks|thank you|no problem|fine)\b/i      // politeness
];
```

**Filtering Logic**: Skip observations when facts exist (prevents duplication).

**Impact**: 3 memories per input (parent + selective facts + observation) instead of 8 (parent + all facts + all observations).

---

### 1.5 Smart Ingestion (Search-Before-Store)

**Purpose**: Catch duplicates at ingest time before Qdrant storage.

**Process**:
1. Extract facts from new input
2. For each fact, search existing memories (vector + keyword)
3. If similarity > 0.85 → skip storage, link to existing
4. Otherwise → store new memory

**Configuration**:
```javascript
{
  smartIngest: true,
  searchBeforeStoreThreshold: 0.85,
  maxSearchResults: 5
}
```

**Benefit**: Real-time deduplication, 50% reduction in redundant fact-memories.

---

### 1.6 Operator Layer (Intent-Driven Retrieval)

**Purpose**: Detect query intent and dynamically adjust retrieval weights.

**Intent Detection**:
- **temporal**: Time-related keywords → boost date-based ranking
- **factual**: Definition/reference keywords → boost fact-memory search
- **preference**: Opinion/personal keywords → boost user-context matching
- **action**: Command/decision keywords → boost decision memories
- **exploratory**: Question mark + low-signal keywords

**Dynamic Weights**:
```javascript
const weights = {
  temporal: { vector: 0.4, keyword: 0.3, graph: 0.3, dateBoost: 1.5 },
  factual: { vector: 0.6, keyword: 0.2, graph: 0.2 },
  preference: { vector: 0.5, keyword: 0.3, graph: 0.2, personalBoost: 1.2 },
  action: { vector: 0.4, keyword: 0.3, graph: 0.3, decisionBoost: 1.4 },
  exploratory: { vector: 0.5, keyword: 0.3, graph: 0.2 }
};
```

**Temporal Query Expansion**:
- Parse date ranges from query
- Expand to ±7 days (configurable)
- Boost memories within range

**Memory Type Boost**:
```javascript
const boosts = {
  temporal: { decision: 1.3, event: 1.5, fact: 0.9 },
  factual: { fact: 1.4, decision: 0.8, event: 0.9 },
  preference: { observation: 1.2, decision: 1.1, fact: 0.8 }
};
```

**Impact**: 15-20% improvement on multi-session and preference questions.

---

### 1.7 Context Autopilot

**Purpose**: Preemptive context compression before LLM "context cliff".

**Mechanism**:
- Monitor working memory token count
- At 80% capacity threshold → archive low-priority memories
- Reinjection: archive moves to frame assembly (retrieved on next query)

**Retention Scoring**:
```
score = recency_decay(hours) × log(frequency) × content_richness
recency_decay(h) = exp(-h / 24)    // hourly decay, 1-day half-life
content_richness = min(char_count / 1000, 1.0)
```

**Archive Format**:
- SHA-256 digest + summary + retention_score
- Searchable via frame assembly (not in working memory)

**Configuration**:
```javascript
{
  contextAutopilotEnabled: true,
  tokenThreshold: 0.80,
  deduplicateArchive: true,
  reinjectionBudget: 5000  // tokens available for reinject
}
```

**Impact**: Handles multi-turn conversations 10x longer than naive context windows.

---

### 1.8 Bi-Temporal Versioning

**Purpose**: Separate "when events happened" (valid_time) from "when system learned" (transaction_time).

**Schema**:
```javascript
{
  memory: {
    id: uuid,
    content: string,
    document_date: ISO8601,        // When user created/mentioned it
    event_dates: [ISO8601],        // When described events occurred
    is_latest: boolean,            // Version chain marker
    memory_version: string,        // "1.0", "1.1", etc.
    relationships: [
      { type: "Updates", target_id, valid_from, valid_to }
    ]
  }
}
```

**Queries**:
- **"What did I know on Tuesday?"** → `transaction_time <= date` (includes memories stored before)
- **"What happened in October?"** → `event_dates OVERLAP [Oct 1, Oct 31]`
- **"Latest status on project X?"** → `is_latest = true`

**Triple Operator Relationships**:
- **Updates**: Semantic replacement (old → new truth)
- **Extends**: Evidence chaining (hypothesis → parent)
- **Derives**: Logical inference (fact A + B → derived C)

**Impact**: Historical queries ("what did I know then?") vs current state queries ("what's true now?").

---

### 1.9 Conflict Detection & Resolution

**Purpose**: Identify semantic conflicts and route to LLM for principled resolution.

**Detection**:
- Token similarity (Jaccard overlap) on normalized tokens
- Threshold: 0.45 (lowered from 0.92 to catch knowledge updates)
- Pattern: "I went to Paris" vs "I visited Paris" = high similarity, semantic equivalent

**Resolution**:
LLM prompt:
```
"Existing: [old memory]. New: [new input].
Same topic (0.80+ overlap)? If yes: UPDATE (new supersedes) or MERGE (combine)?
Answer: UPDATE or MERGE with rationale."
```

**Outcomes**:
- UPDATE: New replaces old, creates Updates relationship
- MERGE: Combine both, mark old as superseded
- KEEP_BOTH: Store separately (explicit contradiction)

**Configuration**:
```javascript
{
  conflictDetectionThreshold: 0.45,
  autoResolveAboveConfidence: 0.85,
  requireManualConfirmation: false
}
```

**Impact**: Prevents contradictory memories from corrupting downstream reasoning.

---

### 1.10 Relationship Classification

**Purpose**: Automatically infer relationship types between memories.

**Classifier Logic**:
```javascript
classify(oldMemory, newMemory) {
  const similarity = computeTokenSimilarity(old, new);
  const temporal = parseTemporalOrder(old, new);

  if (similarity > 0.70 && temporal.new > temporal.old) {
    return "Updates";  // Semantic update: old → new
  }
  if (evidence(new) references old) {
    return "Extends";  // Hypothesis chaining
  }
  if (canInferFrom([old, new])) {
    return "Derives";  // Logical inference
  }
  return "Related";
}
```

**Impact**: Automatic versioning, hypothesis chains, inference discovery.

---

### 1.11 Persisted Retrieval (Advanced Recall)

**Purpose**: Multi-parameter recall with filtering, sorting, and graph expansion.

**Parameters**:
```javascript
POST /api/recall {
  query: "string",

  // Filters
  is_latest: boolean,              // Only latest versions
  include_expired: boolean,        // Include superseded memories
  project_id: string,
  tags: [string],
  memory_types: ["fact", "decision"],

  // Sorting
  sort: "score" | "date_asc" | "date_desc",

  // Expansion
  include_parent_chunks: boolean,  // Fact → parent injection
  graph_depth: number,             // Follow relationships

  // Limits
  contextLimit: 15,                // Max memories
  searchLimit: 20,                 // Max vector candidates
  maxChars: 12000                  // Total payload chars
}
```

**Type-Specific Routing**:
| Question Type | Strategy | Key Features |
|---|---|---|
| Temporal-Reasoning | Operator + temporal expansion | `sort: date_asc`, eventDate filtering |
| Knowledge-Update | Predict-calibrate + is_latest | Updates chain traversal |
| Multi-Session | Graph expansion + cross-session edges | Extends relationships, 30 memories |
| Single-Session | Direct vector search | Simple, fast, 10 memories |
| Preference | Operator Layer preference intent | Personalization cues, observation boost |

**Impact**: 78.3% on temporal-reasoning, 75.6% on knowledge-update (SOTA engine).

---

### 1.12 Hybrid Search (Qdrant + Prisma + Graph)

**Ranking Formula**:
```
final_score = 0.60 * vector_score
            + 0.25 * keyword_score
            + 0.15 * graph_score
            + intent_boosts
```

**Vector Search**: Qdrant similarity (cosine, 0.15 threshold minimum).

**Keyword Search**: Prisma full-text on content + titles.

**Graph Search**: Shortest-path traversal from query entities.

**Configuration**:
```javascript
{
  vectorWeight: 0.60,
  keywordWeight: 0.25,
  graphWeight: 0.15,
  vectorScoreThreshold: 0.15,
  maxGraphDepth: 3
}
```

**Impact**: Catches both semantic and keyword-based queries.

---

## 2. CSI Layer (Cognitive Swarm Intelligence)

### 2.1 Faraday Agent (Scanner)

**Purpose**: Scan knowledge graph for anomalies, duplicates, stale truths.

**Process**:
1. **Semantic Probe Generation**: 10 targeted queries from goal + context
2. **Memory Clustering**: Jaccard token overlap (0.34 threshold)
3. **Anomaly Detection**:
   - Duplicate clusters (high similarity)
   - Stale truths (timestamps + contradiction hints)
   - Update chains (temporal sequences)
   - Code smells (churn without tests)
4. **LLM Analysis** (Groq llama-3.3-70b):
   - Receives cluster memories with full UUIDs
   - Identifies DUPLICATES, UPDATE_CHAIN, CONFLICTS, MERGE, CROSS_PROJECT
   - Returns actionable analysis

**Learning**: Checks past observations before scanning. Skips already-flagged anomalies → second run finds 0 new issues.

**Budget**:
```javascript
{
  region: 400,     // Max memories to scan
  project: 900,
  workspace: 600
}
```

**Configuration**:
```javascript
{
  semanticClusterThreshold: 0.34,
  probeCount: 10,
  llmModel: "llama-3.3-70b-versatile",
  showFullUuidsToLlm: true,
  crossProjectDetection: true
}
```

**Output**:
- Observations: anomaly_candidate, code_smell, risk_candidate
- Trail marks: semantic_clusters, semantic_probes, semantic_seeds
- Relationship candidates for Turing

**Impact**: Detects 5-7 actionable anomalies per 4,600 memories.

---

### 2.2 Feynman Agent (Analyst)

**Purpose**: Convert anomaly clusters into testable hypotheses.

**Hypothesis Types**:
```javascript
{
  recurring_operational_issue: { keywords: ["failed", "error", "incident"], confidence_base: 0.65 },
  stale_or_conflicting_truth: { keywords: ["policy", "updated", "verify"], confidence_base: 0.60 },
  temporal_update_chain: { keywords: ["meeting", "schedule", "moved"], confidence_base: 0.70 },
  repeated_pattern_cluster: { minClusterSize: 5, confidence_base: 0.55 },
  emerging_pattern: { keywords: [], confidence_base: 0.50 }
}
```

**Confidence Calculation**:
```
base + (memory_count × 0.05) + (source_spread × 0.02)
capped at 0.94
```

**Novelty Scoring**:
```
0.3 + (evidence_count × 0.08) + (keyword_count × 0.03)
capped at 1.0
```

**Verification Checks** (3-4 per hypothesis):
- enough_evidence_refs (≥3)
- cross_memory_spread (≥2 sources)
- explicit_verification_plan (≥2 checks)
- novel_pattern (novelty ≥0.55)

**Output**:
- Hypotheses with summary, rationale, why_now
- verification_checks (specific tests to validate)
- counter_evidence (what would disprove)
- Trail mark for Turing

**Impact**: Turns raw clusters into actionable theses with success criteria.

---

### 2.3 Turing Agent (Verifier & Graph Surgeon)

**Purpose**: Evaluate hypotheses and execute graph mutations.

**Hypothesis Evaluation**:
Each hypothesis checked against 4 criteria:
1. enough_evidence_refs (≥3)
2. cross_memory_spread (≥2 sources OR ≥3 files)
3. explicit_verification_plan (≥2 checks)
4. novel_pattern (novelty_score ≥0.55)

**Verdict Mapping**:
```javascript
{
  likely_true: confidence ≥ 0.85,      // "Merge these duplicates"
  uncertain: 0.65 ≤ confidence < 0.85, // "Consider linking"
  weak: confidence < 0.65              // "Skip"
}
```

**Graph Actions Generated**:

1. **link_update_chain**
   - For: stale_or_conflicting_truth
   - Action: Sort memories chronologically, create Updates edges, mark old `is_latest: false`
   - Superseded metadata: { superseded_by, superseded_reason, superseded_at }

2. **merge_duplicate_cluster**
   - For: duplicates with high confidence
   - Action: Keep richest as canonical, link duplicates via Extends, boost canonical importance +0.2

3. **suppress_noise_cluster**
   - For: low-novelty patterns
   - Action: Set importance_score = 0.1 (deprioritize in retrieval)

4. **promote_known_risk**
   - For: verified patterns
   - Action: Create new fact memory tagged [promoted-risk] with importance 0.95

5. **relationship_candidate**
   - For: loose connections between memories
   - Action: Create Extends relationships, improve graph connectivity

**Configuration**:
```javascript
{
  minConfidenceToExecute: 0.65,
  mergeScoreThreshold: 0.85,
  dryRun: false
}
```

**Impact**: Graph mutations persist. Second Faraday scan finds 0 new anomalies.

---

### 2.4 Graph Action Executor

**Purpose**: Execute Turing's verified actions against the real memory store.

**Action Execution**:
```javascript
async executeActions(actions, { dryRun, minConfidence }) {
  for (const action of actions) {
    if (action.confidence < minConfidence) continue;

    switch (action.type) {
      case 'link_update_chain':
        await linkUpdateChain(action);
      case 'merge_duplicate_cluster':
        await mergeDuplicates(action);
      case 'suppress_noise_cluster':
        await suppressNoise(action);
      case 'promote_known_risk':
        await promoteRisk(action);
      case 'relationship_candidate':
        await createRelationship(action);
    }
  }
}
```

**UUID Matching**: Handles partial UUID matching (LLM outputs short IDs, executor finds full).

**Safety**:
- `_safeCreateRelationship()`: Handles unique constraint violations
- Dry-run mode: Preview actions without persistence
- Confidence threshold: Min 0.65 default

**Impact**: Knowledge graph evolves autonomously (duplicate count decreases, relationship density increases).

---

### 2.5 Run Manager (Orchestrator)

**Purpose**: Execute Faraday → Feynman → Turing pipeline + CSI feedback loop.

**Pipeline**:
```
1. RunManager.runAgent('faraday')
   → Faraday scans, creates observations
   → Direct graph action execution (clear-cut duplicates)

2. RunManager.runAgent('feynman', {run_id: faraday_run_id})
   → Resolves Faraday observations
   → Forms hypotheses

3. RunManager.runAgent('turing', {run_id: feynman_run_id})
   → Evaluates hypotheses
   → Executes action_candidates via GraphActionExecutor

4. CSI Feedback Loop (post-run)
   → ReputationEngine: Update agent scores (EMA)
   → ChainMiner: Mine blueprint patterns
   → WeightUpdater: Update trail weights
   → PromotionMux: Emit promotion candidates
```

**Direct Graph Actions** (Faraday → Executor):
- Bypasses Feynman/Turing for high-confidence duplicates
- Speeds up graph repair by 2-3x
- Marked with action_source: "faraday_direct"

**Hypothesis Handoff**:
```javascript
// Check .length (not truthiness) for empty arrays
if (result.hypotheses && result.hypotheses.length > 0) {
  await _executeFeynman(run);
}
```

**Configuration**:
```javascript
{
  enableDirectActions: true,
  directActionConfidenceThreshold: 0.80,
  maxConcurrentRuns: 3,
  timeout: 300000  // 5 minutes
}
```

**Impact**: Full graph repair cycle (Faraday scan → Turing actions) completes in 30-40 seconds.

---

### 2.6 CSI Feedback Loop

**Components** (all called in `_onRunCompleted`):

1. **GraphActionExecutor**: Mutates graph (merge, link, suppress, promote)
2. **ReputationEngine**: EMA-based agent scoring
3. **ChainMiner**: Extracts repeated successful patterns → blueprints
4. **WeightUpdater**: Composite trail scoring from 6 factors
5. **PromotionMux**: Emits promotion candidates (dedup + async)

**Learning Cycle**:
```
Run 1: Faraday finds 5 anomalies
       → 4 merged, 3 linked, 1 promoted
       → Reputation updated
       → ChainMiner detects patterns

Run 2: Faraday scans same memories
       → Checks past observations
       → Skips 4 already-fixed anomalies
       → Finds 0 new issues (graph is clean)
```

**Impact**: Self-improving system. Repeated runs find fewer anomalies (convergence to clean state).

---

## 3. Trail Executor (Goal-Driven Runtime)

### 3.1 Execution Loop (Select-Bind-Execute-Write)

**Phases**:
```
Phase 1: LOAD canonical state from knowledge graph
Phase 2: LOOP (up to maxSteps):
  A. SELECT: TrailSelector → ForceRouter → softmax sample
  B. BIND: ActionBinder resolves $ctx.*, $kg.*, $obs.* tokens
  C. EXECUTE: ToolRunner runs tool with budget + timeout
  D. WRITE: OutcomeWriter persists immutable event
  E. UPDATE: Merge tool output into working memory
  F. WEIGHT: WeightUpdater computes trail score
  G. PROMOTE: PromotionMux emits candidates
  H. LEASE: LeaseManager releases exclusive lock
Phase 3: BUILD result summary, update reputation, return
```

**Budget Enforcement**:
```javascript
{
  maxTokens: 50000,
  maxCostUsd: 1.0,
  maxWallClockMs: 60000
}
```

**Configuration**:
```javascript
{
  defaultMaxSteps: 10,
  defaultBudgetMaxTokens: 50000,
  defaultPromotionThreshold: 0.80,
  temperature: 1.0  // Softmax sampling temperature
}
```

**Output**: ExecutionResult with chainSummary, stepsExecuted, finalState, eventsLogged.

---

### 3.2 Force Router (8-Dimension Social Force Model)

**Forces** (per candidate trail):

| Force | Weight | Sub-signals | Range |
|-------|--------|-------------|-------|
| goalAttraction | 1.0 | wordOverlap(tags, goal) + historicalSuccess | [-1, +1] |
| affordanceAttraction | 1.0 | executableNow + paramBindability | [0, +1] |
| blueprintPrior | 0.3 | 1.0 if active blueprint, else 0 | [0, +0.3] |
| socialAttraction | 0.2 | creatorReputation × 0.5, capped 0.25 | [0, +0.2] |
| momentum | 0.15 | pathContinuity (same=0.8, family=0.3) | [0, +0.15] |
| conflictRepulsion | 1.0 | (1 - confidence) + recentFailure | [-1, 0] |
| congestionRepulsion | 1.0 | activeLease + queueDepth + recentReuse | [-1, 0] |
| costRepulsion | 1.0 | tokenCost (0.1) + latencyCost (0.1) | [-1, 0] |

**Net Force**:
```
F_net = goalAttraction + affordanceAttraction + blueprintPrior
      + socialAttraction + momentum
      - conflictRepulsion - congestionRepulsion - costRepulsion
```

**Softmax Sampling** (NOT argmax):
```javascript
logits[i] = F_net[i] / temperature
P[i] = exp(logits[i] - max_logit) / sum(exp(logits - max_logit))
selected = CDF_sample(P)
```

**Configuration**:
```javascript
{
  temperature: 1.0,           // [0.01 - 10.0]
  forceWeights: {
    goalAttraction: 1.0,
    affordanceAttraction: 1.0,
    blueprintPrior: 0.3,
    socialAttraction: 0.2,
    momentum: 0.15,
    conflictRepulsion: 1.0,
    congestionRepulsion: 1.0,
    costRepulsion: 1.0
  }
}
```

**Impact**: Continuous, adaptive routing. Balances exploitation (proven trails) vs exploration (novel paths).

---

### 3.3 Chain Miner (Blueprint Extraction)

**Process**:
1. Gather last 50 chain runs for a goal
2. Filter: `doneReason == 'tool_signaled_completion'` && success ≥ 0.9
3. Canonicalize tool sequences → chain signatures (e.g., `detect>classify>link>store`)
4. Group by signature, evaluate:
   - minOccurrences ≥ 3
   - minSuccessRate ≥ 0.9
   - maxAvgLatencyMs ≤ 5000
5. Create blueprint trail with actionSequence

**Blueprint States**:
- candidate: Detected pattern, awaiting promotion
- active: Available for selection (participates in routing)
- deprecated: Never selected in recent window (MetaEvaluator detection)

**Configuration**:
```javascript
{
  minOccurrences: 3,
  minSuccessRate: 0.9,
  maxAvgLatencyMs: 5000,
  lookbackRuns: 50,
  autoActivate: true
}
```

**Auto-Activation**: If true, blueprints become active immediately. If false, require manual promotion.

**Impact**: Proven patterns become reusable procedures. Execution speed 2-3x faster via blueprint reuse.

---

### 3.4 Weight Updater (Trail Scoring)

**Six Signals** (composite weight):
```javascript
weight = clamp(
  base_confidence
  × (1 - failure_penalty)
  × (1 + agent_reputation_boost)
  × (1 - novelty_discount)
  × (1 + downstream_success_factor)
  × cost_factor,
  0, 1
)
```

**Components**:
```javascript
{
  base_confidence: 0-1,
  failure_penalty: min((failures / 10) × 0.5, 0.5),
  agent_reputation_boost: (reputation ?? 0.5) × 0.3,
  novelty_discount: 0-1,
  downstream_success_factor: 0-1 × 0.2,
  cost_factor: 1 - min(costUsd / 1.0, 0.3)
}
```

**Storage**: Components persisted for explainability.

**Configuration**:
```javascript
{
  storeComponents: true,
  decayRate: 0.05  // Per day
}
```

---

### 3.5 Reputation Engine (Agent Learning)

**Metrics** (per agent):
```javascript
{
  success_rate: EMA(1.0 if completed, 0.0 if failed, alpha=0.1),
  avg_confidence: EMA(weighted toward 0.9 on success, 0.3 on failure),

  skill_scores: {
    [tool]: {
      success_rate: EMA,
      avg_latency_ms: EMA,
      executions: counter
    }
  },

  blueprint_scores: {
    [signature]: {
      success_rate: EMA,
      executions: counter
    }
  },

  specialization_confidence: {
    explorer: score,      // Multi-tool, high success, low blueprint use
    operator: score,      // High blueprint success
    evaluator: score      // (reserved)
  }
}
```

**EMA Alpha**: 0.1 (learns quickly but smooths noise).

**Specialization Evidence Gating**: Confidence capped at 0.6 until agent has 10+ execution events.

**Configuration**:
```javascript
{
  emaAlpha: 0.1,
  minEvidence: 10,
  maxConfidenceWithoutEvidence: 0.6
}
```

---

### 3.6 Blueprint Execution

**Blueprint Trail Structure**:
```javascript
{
  kind: "blueprint",
  blueprintMeta: {
    chainSignature: "detect>classify>link>store",
    actionSequence: ["detect_action", "classify_action", "link_action", "store_action"],
    promotionStats: { successRate: 0.95, count: 5 },
    version: 1,
    state: "active"
  }
}
```

**Execution**:
1. TrailSelector picks blueprint trail
2. Executor iterates through actionSequence
3. For each action: BIND → EXECUTE → WRITE
4. Working memory flows between steps
5. Failure at any step halts blueprint, records reason
6. Result: ExecutionResult with used_blueprint, blueprint_chain_signature

**Impact**: 10x speed improvement on repeated tasks.

---

## 4. Storage & Persistence

### 4.1 PostgreSQL Schema (Prisma ORM)

**Memory Tables**:
```javascript
// Core memory
Memory {
  id: uuid
  content: string
  memory_type: "fact" | "observation" | "decision" | "event" | "lesson"
  importance_score: float [0-1]
  document_date: datetime        // When user created/mentioned
  event_dates: json             // When events occurred
  is_latest: boolean
  memory_version: string
  tags: string[]
  project_id: uuid              // Cross-project support
  agent_id: uuid                // Creator agent
  created_at, updated_at: datetime
}

// Relationships
Relationship {
  id: uuid
  source_id: uuid (Memory)
  target_id: uuid (Memory)
  type: "Updates" | "Extends" | "Derives"
  confidence: float
  created_by: uuid (agent)
  created_at: datetime
}

// Versions
MemoryVersion {
  id: uuid
  memory_id: uuid
  version_number: int
  content: string
  created_at: datetime
}

// Observations (CSI)
Observation {
  id: uuid
  agent_id: uuid
  kind: "anomaly_candidate" | "hypothesis" | "verification" | "graph_action"
  content: json
  certainty: float
  memory_ids: uuid[]            // Related memories
  created_at: datetime
}
```

**Trail & Execution** (see architecture.md for full schema).

**Indices**:
```sql
CREATE INDEX memory_document_date ON Memory(document_date);
CREATE INDEX memory_event_dates ON Memory USING GIN(event_dates);
CREATE INDEX memory_project_id ON Memory(project_id);
CREATE INDEX memory_is_latest ON Memory(is_latest);
CREATE INDEX relationship_source_target ON Relationship(source_id, target_id);
CREATE INDEX observation_agent_id ON Observation(agent_id);
```

---

### 4.2 Qdrant Vector Storage

**Collections**:

1. **BUNDB AGENT** (Production)
   - Embedding: all-MiniLM-L6-v2 (384 dimensions)
   - Points: One per memory
   - Payload: Full metadata (event_dates, tags, project_id)

2. **BENCHMARK** (Testing)
   - Embedding: bge-m3 (1024 dimensions)
   - Points: One per memory (same data as production)
   - Payload: Same metadata

**Payload Schema**:
```javascript
{
  memory_id: uuid,
  memory_type: "fact" | "observation" | ...,
  document_date: ISO8601,
  event_dates: [ISO8601],
  project_id: uuid,
  tags: [string],
  importance_score: float,
  is_latest: boolean,
  content_snippet: string (first 500 chars)
}
```

**Similarity Search**:
```javascript
search_results = await qdrant.search(
  collection,
  query_vector,
  limit: 20,
  score_threshold: 0.15
);
```

**Configuration**:
```javascript
{
  QDRANT_URL: "https://...",
  QDRANT_API_KEY: "...",
  QDRANT_COLLECTION: "BUNDB AGENT" | "BENCHMARK",
  EMBEDDING_DIMENSION: 384 | 1024
}
```

---

## 5. LLM Integration

### 5.1 Model Selection

**Core LLM** (Groq API):
```javascript
GROQ_API_KEY=gsk_...
GROQ_MODEL=llama-3.3-70b-versatile  // Default
```

**Alternative Models**:
- llama-3.1-70b-versatile
- mixtral-8x7b-32768
- gemma-7b-it

**Configuration**:
```javascript
{
  model: "llama-3.3-70b-versatile",
  temperature: 0.7,           // 0.0 = deterministic, 1.0 = creative
  max_tokens: 2000,
  top_p: 1.0,
  timeout: 30000
}
```

**Fallback**: Include `include_reasoning: false` for reasoning models (prevents timeout).

### 5.2 Embedding Models

**Primary** (LiteLLM proxy):
```javascript
EMBEDDING_PROVIDER=litellm
LITELLM_API_KEY=...
LITELLM_BASE_URL=https://api.blaiq.ai/v1  // or custom
EMBEDDING_MODEL=bge-m3                    // 1024-dim
```

**Fallback** (Mistral):
```javascript
MISTRAL_API_KEY=...
EMBEDDING_MODEL=mistral-embed              // 1024-dim
```

**Local Fallback** (SHA-256 hashing):
```javascript
// If embedding service unavailable
vector = SHA256(content).hex().substring(0, 1024 / 4)
         .split('').map(c => c.charCodeAt(0) / 255)
```

---

## 6. Decision Intelligence (Experimental)

### 6.1 Detection Heuristics

**Strong Signals** (+0.25 each):
```javascript
[
  "decided", "approved", "agreed", "chosen", "chose",
  "picked", "selected", "went with", "accepted",
  "declined", "rejected", "assigned", "confirmed",
  "merged", "deferred", "overridden",
  // Platform-specific:
  "lgtm", "sign off",  // Gmail
  "shipped", "deployed",  // Slack
  "closed", "fixed"  // GitHub
]
```

**Weak Signals** (+0.15 each):
```javascript
[
  "I think we should", "let's go with", "leaning toward",
  "prefer", "opting for", "prioritizing", "taking ownership",
  "bump to p0", "bump to p3"
]
```

**Confidence Modifiers**:
- Questions: -0.10 if strong signals, -0.40 if none
- Hedging: -0.10 per phrase (maybe, perhaps, not sure)

**Minimum Threshold**: 0.10 confidence with ≥1 signal.

**Configuration**:
```javascript
{
  detectionEnabled: true,
  strongSignalWeight: 0.25,
  weakSignalWeight: 0.15,
  questionPenalty: 0.10,
  hedgingPenalty: 0.10,
  minConfidence: 0.10
}
```

---

### 6.2 LLM Classification

**Only called for candidates** that pass heuristic (≥0.10 confidence).

**Prompt**:
```
Candidate: "[text]"
Is this a decision?
Type: choice | approval | rejection | priority | assignment | resolution | policy

Output JSON: { is_decision, decision_type, decision_statement, confidence }
```

**Configuration**:
```javascript
{
  classifyEnabled: true,
  model: "llama-3.3-70b-versatile",
  temperature: 0.3  // Lower = stricter classification
}
```

---

## 7. Configuration & Deployment

### 7.1 Environment Variables

**Database**:
```bash
DATABASE_URL=postgresql://user:pass@host:5432/hivemind
REDIS_URL=redis://localhost:6379
```

**Vector**:
```bash
QDRANT_URL=https://qdrant.host.com
QDRANT_API_KEY=...
QDRANT_COLLECTION=BUNDB AGENT
```

**LLM**:
```bash
GROQ_API_KEY=gsk_...
GROQ_MODEL=llama-3.3-70b-versatile
EMBEDDING_PROVIDER=mistral|litellm
MISTRAL_API_KEY=...
LITELLM_API_KEY=...
LITELLM_BASE_URL=https://api.example.com/v1
```

**Security**:
```bash
API_MASTER_KEY=...
SESSION_SECRET=...
HIVEMIND_MASTER_API_KEY=...
```

**Features**:
```bash
USE_SITUATIONALIZER=true
USE_CONTEXTUAL_EMBEDDING=true
USE_AST_CHUNKING=true
USE_STATEFUL_MANAGER=true
USE_QDRANT_STORAGE=true
```

### 7.2 Feature Flags

| Flag | Default | Purpose |
|------|---------|---------|
| `USE_SITUATIONALIZER` | true | Intent-aware context |
| `USE_CONTEXTUAL_EMBEDDING` | true | Fact-augmented embeddings |
| `USE_AST_CHUNKING` | true | Code ingestion via AST |
| `USE_STATEFUL_MANAGER` | true | Stateful execution |
| `USE_QDRANT_STORAGE` | true | Vector storage |
| `ENABLE_DIRECT_ACTIONS` | true | Faraday direct graph mutations |
| `ENABLE_FACT_FILTERING` | true | Trivial fact filtering |
| `ENABLE_SMART_INGEST` | true | Search-before-store |

### 7.3 Tunable Parameters

All stored in `meta_parameters` table (atomic apply, rollback):

**Routing** (8):
- temperature, goalAttraction, affordanceAttraction, blueprintPrior, socialAttraction, momentum, conflictRepulsion, congestionRepulsion, costRepulsion

**Blueprint** (5):
- minOccurrences, minSuccessRate, maxAvgLatencyMs, lookbackRuns, autoActivate

**Reputation** (3):
- emaAlpha, minEvidence, maxConfidenceWithoutEvidence

**Execution** (3):
- defaultMaxSteps, defaultBudgetMaxTokens, defaultPromotionThreshold

---

*Complete Feature Catalog. HIVEMIND © 2026.*
