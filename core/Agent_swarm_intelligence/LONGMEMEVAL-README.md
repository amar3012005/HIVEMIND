# HIVEMIND x LongMemEval Benchmark

Running the [LongMemEval](https://arxiv.org/pdf/2410.10813.pdf) (ICLR 2025) benchmark against HIVEMIND's memory engine to produce verifiable, comparable scores against published baselines.

**Target**: Beat Supermemory.ai's 81.6% overall accuracy (GPT-4o judge).

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Architecture Overview](#architecture-overview)
3. [Dataset](#dataset)
4. [Correct Adaptors & Endpoints](#correct-adaptors--endpoints)
5. [6 SOTA Features & How They Map to LongMemEval](#6-sota-features--how-they-map-to-longmemeval)
6. [Running the Benchmark](#running-the-benchmark)
7. [Official Evaluation](#official-evaluation)
8. [Scoring Breakdown](#scoring-breakdown)
9. [Optimization Playbook](#optimization-playbook)
10. [File Reference](#file-reference)

---

## Quick Start

```bash
# 1. Ensure the dataset is downloaded
ls benchmarks/LongMemEval/data/longmemeval_oracle.json

# 2. Run 30-question test (streaming mode — recommended)
HIVEMIND_API_KEY="<your-api-key>" \
HIVEMIND_API_BASE="https://core.hivemind.davinciai.eu:8050" \
GROQ_API_KEY="<your-groq-key>" \
GROQ_INFERENCE_MODEL="llama-3.3-70b-versatile" \
LONGMEMEVAL_DATA="./benchmarks/LongMemEval/data/longmemeval_oracle.json" \
NODE_TLS_REJECT_UNAUTHORIZED=0 \
node core/src/evaluation/longmemeval-runner.js --phase stream --sample 30

# 3. Run official GPT-4o judge on the output
cd benchmarks/LongMemEval
OPENAI_API_KEY="<your-openai-key>" \
python3 src/evaluation/evaluate_qa.py gpt-4o \
  ../../core/evaluation-reports/longmemeval-hypotheses.jsonl \
  data/longmemeval_oracle.json
```

---

## Architecture Overview

```
                    LongMemEval Dataset (500 questions)
                              |
                    longmemeval-runner.js
                              |
               ┌──────────────┼──────────────┐
               v              v              v
         1. INGEST      2. RETRIEVE     3. GENERATE
               |              |              |
       POST /api/memories   /api/search/quick   Groq LLM
       (predict-calibrate)  (Qdrant vectors)    (llama-3.3-70b)
       (bi-temporal dates)  (operator routing)
       (skipPredictCalibrate)                    4. JUDGE
                                                    |
                                              Groq or GPT-4o
                                              (yes/no verdict)
                                                    |
                                              5. CLEANUP
                                                    |
                                           DELETE per-question
                                           memories
```

### Streaming Pipeline (Recommended)

The `--phase stream` mode processes each question in isolation:

```
For each of the 500 questions:
  1. Ingest this question's ~3-40 haystack sessions as memories
     - Each user+assistant turn pair becomes one memory
     - Tagged with project: bench/longmemeval/{question_id}
     - document_date set from haystack_dates
  2. Wait 1s for Qdrant vector indexing
  3. Retrieve via /api/search/quick (70% Qdrant vector, 20% keyword, 10% graph)
  4. Generate answer via Groq llama-3.3-70b-versatile
  5. Judge with Groq (yes/no correctness)
  6. Cleanup: delete this question's memories
  7. Next question
```

This prevents memory pollution between questions and ensures fair evaluation.

---

## Dataset

### Source

- **Official repo**: [xiaowu0162/LongMemEval](https://github.com/xiaowu0162/LongMemEval)
- **Paper**: ICLR 2025 — "LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory"
- **HuggingFace**: `xiaowu0162/longmemeval-cleaned`

### Files

| File | Description | Use Case |
|------|-------------|----------|
| `longmemeval_oracle.json` | Oracle retrieval — only evidence sessions included | Best for benchmarking retrieval quality |
| `longmemeval_s_cleaned.json` | Full LongMemEval_S — ~40 sessions, ~115k tokens per question | Full difficulty benchmark |
| `longmemeval_m_cleaned.json` | LongMemEval_M — ~500 sessions per question | Extreme difficulty |

### Download

```bash
cd benchmarks/LongMemEval/data/
wget https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json
wget https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
```

### Question Types (500 total)

| Type | Count | Tests |
|------|-------|-------|
| `single-session-user` | ~100 | Recall a fact the user mentioned |
| `single-session-assistant` | ~50 | Recall info the assistant provided |
| `single-session-preference` | ~50 | Recall user's preferences/tastes |
| `temporal-reasoning` | ~80 | "How many days between X and Y?" |
| `knowledge-update` | ~60 | "User switched from X to Y — what's current?" |
| `multi-session` | ~60 | Synthesize facts across multiple conversations |
| `*_abs` (abstention) | ~30 | Correctly say "I don't know" for unmentioned topics |

### Instance Format

```json
{
  "question_id": "ku_42",
  "question_type": "knowledge-update",
  "question": "What is Alice's favorite ice cream flavor?",
  "answer": "She recently switched to mango.",
  "question_date": "2024/03/15 (Fri) 10:00",
  "haystack_dates": ["2024/01/15 (Mon) 09:00", "2024/02/20 (Tue) 14:30"],
  "haystack_sessions": [
    [
      {"role": "user", "content": "I love pistachio ice cream"},
      {"role": "assistant", "content": "Great choice!"}
    ],
    [
      {"role": "user", "content": "Actually I switched to mango recently"},
      {"role": "assistant", "content": "Mango is delicious!"}
    ]
  ],
  "answer_session_ids": [1],
  "haystack_session_ids": [0, 1]
}
```

---

## Correct Adaptors & Endpoints

### USE THESE (Qdrant Vector Search)

| Endpoint | How It Works | When to Use |
|----------|-------------|-------------|
| **`POST /api/search/quick`** | 70% Qdrant vector + 20% keyword + 10% graph | **Primary retrieval** — best balance of recall and precision |
| **`POST /api/recall`** | Lexical + Qdrant hybrid + graph expansion | Fallback when quick search returns < 3 results |
| **`POST /api/search/panorama`** | Comprehensive historical search across all memory layers | Knowledge-update questions (timeline reconstruction) |
| **`POST /api/cognitive-frame`** | Intent-aware frame assembly with dynamic weight adjustment | Future: operator-layer-enhanced retrieval |

### DO NOT USE (No Vector Search)

| Endpoint | Why It's Bad |
|----------|-------------|
| ~~`POST /api/memories/search`~~ | **Prisma-only** — uses `computeTokenSimilarity()` (token overlap), does NOT touch Qdrant vectors |
| ~~`POST /api/memories/query`~~ | Pattern matching only, no semantic search |
| ~~`GET /api/memories`~~ | List endpoint, no relevance ranking |

### Retrieval Routing (Type-Aware)

The runner uses `longmemeval-routing.js` for type-specific retrieval:

```
temporal-reasoning  → /api/recall (include_expired, include_historical, date_range filter)
knowledge-update    → /api/search/panorama (include_timeline for version history)
everything else     → /api/recall (standard hybrid search)
```

**Override in practice**: The runner actually uses `/api/search/quick` as primary for ALL types because `/api/recall` aggressively deduplicates similar memories down to 1 result. Quick search returns 10-15 diverse results.

### API Authentication

```bash
# Headers required for all API calls
X-API-Key: hmk_live_...          # Your HIVEMIND API key
Content-Type: application/json
X-HM-User-Id: <bench-user-id>   # Isolated benchmark user
X-HM-Org-Id: <bench-org-id>     # Organization for isolation
```

---

## 6 SOTA Features & How They Map to LongMemEval

HIVEMIND's memory engine has 6 state-of-the-art features that directly address LongMemEval's challenge categories. Here's how each one contributes:

### 1. Predict-Calibrate (Extraction Filtering)

**File**: `core/src/memory/predict-calibrate.js`

**What it does**: Eliminates knowledge base bloat by storing only novel information. Compares incoming content against TOP-K=5 most similar existing memories using semantic similarity thresholds:
- **0.90+**: Routes to LLM conflict resolver (may be an UPDATE, not a duplicate)
- **0.60-0.90**: Extracts delta (only novel sentences retained)
- **< 0.60**: Stores full content as genuinely new

**LongMemEval impact**:
- **Knowledge Update (KU)**: When session 30 says "I switched to mango", predict-calibrate detects the conflict with the earlier "pistachio" memory and creates an UPDATE with `is_latest=true`, demoting the old fact
- **All types**: Prevents redundant memories from burying relevant ones in search results

**Benchmark config**:
```javascript
// In POST /api/memories:
{
  skipPredictCalibrate: true  // Disabled for benchmark ingestion (sessions are intentionally similar)
}
```

**Why we skip it for benchmark**: LongMemEval haystack sessions are designed to be noisy — predict-calibrate would filter out too aggressively. The filtering helps in production but hurts benchmark recall.

---

### 2. Operator Layer (Cognitive Rhythm)

**File**: `core/src/memory/operator-layer.js`

**What it does**: Transforms the knowledge graph from passive storage into an active reasoning substrate:
- **Intent Detection**: Classifies queries into 5 types — temporal, action, factual, emotional, exploratory
- **Dynamic Weight Adjustment**: Modifies scorer weights per query intent:
  - Temporal queries get boosted recency weights
  - Factual queries get boosted vector similarity weights
  - Exploratory queries get boosted graph traversal weights
- **Cognitive Frame Assembly**: 4-tier memory prioritization:
  1. **Anchor** — static facts (always present)
  2. **Trajectory** — dynamic events (by recency)
  3. **Modifiers** — heuristics/decisions (by task similarity)
  4. **Connectors** — relationships (for reasoning)

**LongMemEval impact**:
- **Multi-Session (MS)**: Graph traversal connects facts scattered across conversations
- **Temporal Reasoning (TR)**: Recency-boosted search prioritizes time-relevant memories
- **Single-Session**: Factual intent routes to high-precision vector search

**Endpoint**: `POST /api/cognitive-frame`

---

### 3. Context Autopilot (Preemptive Compaction)

**File**: `core/src/memory/context-autopilot.js`

**What it does**: Proactively manages context lifecycle to prevent context cliff:
- Monitors token usage at 80% capacity threshold
- Archives session turns with SHA-256 dedup
- Retention scoring: `recency x frequency x richness`
  - Recency: exponential decay (0.05 hourly rate)
  - Frequency: log-scaled access count
  - Richness: content length + importance score
- Reinjects top-15 critical memories into fresh context

**LongMemEval impact**:
- **All types**: With 40+ sessions per question (115k tokens), context autopilot prevents memory overflow during ingestion
- **Multi-Session**: Retention scoring keeps the most important cross-session facts alive
- **Abstention**: Low-richness irrelevant memories naturally decay

**Endpoints**: `POST /api/context/monitor`, `POST /api/context/archive`, `POST /api/context/compact`

---

### 4. Bi-Temporal Knowledge Graph (Time-Travel)

**File**: `core/src/memory/bi-temporal.js`

**What it does**: Tracks two independent time dimensions:
- **Transaction Time**: `MemoryVersion.createdAt` — when HIVEMIND learned the fact (append-only ledger)
- **Valid Time**: `Memory.documentDate` — when the event actually happened in the real world
- Time-travel queries: "What did we know at T1 about the world at T2?"
- Immutable event sourcing via MemoryVersion audit log

**LongMemEval impact**:
- **Temporal Reasoning (TR)**: `haystack_dates[i]` maps directly to `documentDate`. Bi-temporal queries answer "what happened before/after date X?" precisely
- **Knowledge Update (KU)**: Transaction time tracks WHEN we learned each version of a fact. The most recent transaction has the latest truth
- **Time arithmetic**: The runner extracts dates from memories and passes them to the LLM for day-counting

**Endpoint**: `POST /api/temporal/as-of`, `POST /api/temporal/diff`, `POST /api/temporal/timeline`

**Benchmark integration**:
```javascript
// Each ingested memory gets the session's timestamp
await apiCall('POST', '/api/memories', {
  content: "User: I love pistachio\nAssistant: Great choice!",
  document_date: "2024-01-15T09:00:00.000Z",  // from haystack_dates[i]
  project: "bench/longmemeval/ku_42",
  // ...
});
```

---

### 5. Stigmergic Chain-of-Thought (Swarm Coordination)

**File**: `core/src/memory/stigmergic-cot.js`

**What it does**: O(n) agent coordination via shared memory instead of O(n^2) messaging:
- **Pheromone Traces**: Agents leave affordance (success) and disturbance (failure) signals
- **Thought Recording**: CoT reasoning steps stored as tagged memory nodes with `Extends` relationships
- **Trace Evaporation**: 30-minute TTL prevents stale coordination signals
- **Environment Sensing**: `followTraces()` lets agents see current reasoning state

**LongMemEval impact**:
- **Multi-Session (MS)**: Thought chains link related facts across sessions — the graph expansion in `/api/recall` follows these `Extends` edges
- **Future CSI integration**: Multiple retrieval agents can coordinate via stigmergic traces to find scattered evidence

**Endpoints**: `POST /api/swarm/thought`, `POST /api/swarm/trace`, `POST /api/swarm/follow`

---

### 6. Byzantine Consensus (Hallucination Protection)

**File**: `core/src/memory/byzantine-consensus.js`

**What it does**: Multi-voter consensus before any memory UPDATE operation:
- **3D Evaluation Vectors**: `[factuality, relevance, consistency]` scored 0-100
- **Geometric Median**: Weiszfeld's algorithm minimizes outlier influence
- **Byzantine Tolerance**: Tolerates up to floor((n-1)/2) faulty voters
- **2-Sigma Outlier Detection**: Flags divergent evaluations
- **Commit Threshold**: Average score >= 80/100 to accept an update

**LongMemEval impact**:
- **Knowledge Update (KU)**: When predict-calibrate detects an update ("switched to mango"), byzantine consensus validates the update before committing — preventing hallucinated updates from corrupting the knowledge base
- **Abstention**: Consensus prevents false memories from being created, improving abstention accuracy

**Integration**: Called internally on UPDATE operations (no direct API endpoint needed for benchmark)

---

### Feature Usage Summary

| SOTA Feature | LongMemEval Category | How It Helps | Active During Benchmark? |
|---|---|---|---|
| **Predict-Calibrate** | KU, all | Dedup + delta extraction | Skipped (`skipPredictCalibrate: true`) — sessions are intentionally noisy |
| **Operator Layer** | TR, MS, all | Intent-aware retrieval weights | Yes, via `/api/search/quick` scorer weights |
| **Context Autopilot** | MS, all | Prevents context overflow on 40+ sessions | Yes, during ingestion |
| **Bi-Temporal** | TR, KU | Time-travel queries, date filtering | Yes, `document_date` set per session |
| **Stigmergic CoT** | MS | Cross-session graph edges | Partially, via graph expansion in recall |
| **Byzantine Consensus** | KU, abstention | Validates updates before commit | Yes, on UPDATE operations |

---

## Running the Benchmark

### Prerequisites

```bash
# Required API keys
export GROQ_API_KEY="gsk_..."              # Groq — generation + judging
export HIVEMIND_API_KEY="hmk_live_..."     # HIVEMIND API key
export OPENAI_API_KEY="sk-..."             # OpenAI — official GPT-4o judge (optional)

# Required software
node --version  # >= 18
python3 --version  # >= 3.9 (for official eval script)
pip install openai numpy tqdm backoff  # For evaluate_qa.py
```

### Step 1: Clean Database

Before running, ensure the benchmark user has 0 memories:

```bash
# Check current memory count
curl -sk -H "X-API-Key: $HIVEMIND_API_KEY" \
  "https://core.hivemind.davinciai.eu:8050/api/memories?limit=1" | jq '.total'

# If > 0, clean via bulk delete endpoint or direct SQL:
# DELETE FROM hivemind.source_metadata WHERE memory_id IN (SELECT id FROM hivemind.memories WHERE user_id = '<user-id>');
# DELETE FROM hivemind.memory_versions WHERE memory_id IN (SELECT id FROM hivemind.memories WHERE user_id = '<user-id>');
# DELETE FROM hivemind.memories WHERE user_id = '<user-id>';
# Note: Must disable triggers first (see session notes on audit_logs FK constraint)
```

### Step 2: Run Streaming Benchmark (Recommended)

```bash
# Test on 30 questions first
HIVEMIND_API_KEY="hmk_live_..." \
HIVEMIND_API_BASE="https://core.hivemind.davinciai.eu:8050" \
GROQ_API_KEY="gsk_..." \
GROQ_INFERENCE_MODEL="llama-3.3-70b-versatile" \
LONGMEMEVAL_DATA="./benchmarks/LongMemEval/data/longmemeval_oracle.json" \
NODE_TLS_REJECT_UNAUTHORIZED=0 \
node core/src/evaluation/longmemeval-runner.js --phase stream --sample 30

# Full 500-question run
node core/src/evaluation/longmemeval-runner.js --phase stream
```

### Step 3: Alternative — Batch Mode

```bash
# Phase 1: Ingest all sessions
node core/src/evaluation/longmemeval-runner.js --phase ingest --sample 100

# Phase 2: Evaluate (retrieve + generate)
node core/src/evaluation/longmemeval-runner.js --phase evaluate --sample 100

# Phase 3: Judge with Groq
node core/src/evaluation/longmemeval-runner.js --phase judge

# Or run all three:
node core/src/evaluation/longmemeval-runner.js --phase all --sample 100
```

**Warning**: Batch mode ingests ALL questions' sessions before evaluating. This means question 1's memories may be buried by question 100's memories during evaluation. **Use streaming mode instead.**

### CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| `--phase` | `all` | `stream` (recommended), `ingest`, `evaluate`, `judge`, `all` |
| `--sample N` | 500 | Process only N questions |
| `--start-from N` | 0 | Skip first N questions |
| `--concurrency N` | 1 | Parallel instances (batch mode only) |

### Output Files

| File | Description |
|------|-------------|
| `core/evaluation-reports/longmemeval-hypotheses.jsonl` | One JSON per line: `{question_id, hypothesis, retrieval, autoeval_label}` |
| `core/evaluation-reports/longmemeval-report.json` | Full report with accuracy breakdown, bottleneck analysis, timing |

---

## Official Evaluation

The official LongMemEval evaluation uses GPT-4o as judge via `evaluate_qa.py`:

```bash
cd benchmarks/LongMemEval

# Run official evaluation
export OPENAI_API_KEY="sk-..."
python3 src/evaluation/evaluate_qa.py gpt-4o \
  ../../core/evaluation-reports/longmemeval-hypotheses.jsonl \
  data/longmemeval_oracle.json

# Print detailed metrics from the eval log
python3 src/evaluation/print_qa_metrics.py gpt-4o \
  ../../core/evaluation-reports/longmemeval-hypotheses.jsonl.eval-results-gpt-4o \
  data/longmemeval_oracle.json
```

### Output Format

The hypothesis JSONL must have exactly two fields per line for the official script:

```json
{"question_id": "ku_42", "hypothesis": "Her favorite is now mango."}
```

The official script outputs a `.eval-results-gpt-4o` log file with `autoeval_label` per question and prints aggregated accuracy by question type.

### Judging Rules (from official script)

| Question Type | Judge Prompt Differences |
|---|---|
| `single-session-*`, `multi-session` | Standard: "does response contain correct answer?" |
| `temporal-reasoning` | Lenient: off-by-one day errors are acceptable |
| `knowledge-update` | Lenient: previous info alongside updated answer is OK |
| `single-session-preference` | Rubric-based: "does response satisfy the desired personalization?" |
| `*_abs` (abstention) | Inverse: "does model correctly identify as unanswerable?" |

---

## Scoring Breakdown

### Baselines to Beat

| System | Overall | KU | TR | MS | Source |
|--------|---------|----|----|----|----|
| **Supermemory.ai** | 81.6% | 88.5% | 76.7% | 71.4% | MemoryBench (2025) |
| **GPT-4o (full context)** | ~65% | — | — | — | LongMemEval paper |
| **Stella + BM25** | ~45% | — | — | — | LongMemEval paper |

### HIVEMIND Progress

| Run | Questions | Accuracy | Notes |
|-----|-----------|----------|-------|
| v1 (batch, Prisma search) | 100 | 42% | Used wrong endpoint (no vectors) |
| v2 (stream, quick search) | 30 | 56.7% (keyword) / 33.3% (Groq judge) | First correct pipeline |

### Cost Per Run

| Component | Calls | Model | Cost |
|-----------|-------|-------|------|
| Embedding (ingestion) | ~20,000 | Mistral embed | ~$2.30 |
| Predict-Calibrate | ~20,000 | Groq Llama 3 | ~$3.00 |
| Retrieval (search) | 500 | HIVEMIND self-hosted | $0 |
| Generation (answers) | 500 | Groq Llama 3.3 70B | ~$2.00 |
| Judging (Groq) | 500 | Groq Llama 3.3 70B | ~$1.00 |
| Judging (GPT-4o official) | 500 | GPT-4o | ~$5.00 |
| **Total** | ~41,500 | | **~$13** |

---

## Optimization Playbook

### If Knowledge Update (KU) score is low:
- Enable predict-calibrate during ingestion (remove `skipPredictCalibrate`)
- Tighten `is_latest` penalty in scorer (currently 0.55x)
- Route KU questions through `/api/search/panorama` with `include_timeline: true`
- Verify delta extraction catches "changed", "switched", "updated" patterns

### If Temporal Reasoning (TR) score is low:
- Verify `document_date` is being set correctly from `haystack_dates`
- Enable bi-temporal `asOfValid` queries for date-range filtering
- Boost recency weight when operator layer detects temporal intent
- Improve LLM prompt for day-counting arithmetic

### If Multi-Session (MS) score is low:
- Increase graph search weight in hybrid fusion
- Verify `Extends` relationships are created across sessions
- Use stigmergic traces to link related facts
- Increase `maxItems` in context builder (currently 6)

### If Overall is low:
- Tune hybrid fusion weights (vector 0.60, keyword 0.30, graph 0.10)
- Lower pre-filter thresholds to allow more candidates
- Increase generation context window (more chunks = more information)
- Switch to a stronger LLM (GPT-4o or Claude for generation)

### Adding CSI (Cognitive Swarm Intelligence) Layer
Once core engine hits 60-70%, layer CSI on top:
- Multiple retrieval agents search in parallel with different strategies
- Blueprint extraction identifies winning retrieval patterns per question type
- ForceRouter dynamically adjusts search strategy based on past performance
- Target: 85%+ overall with CSI augmentation

---

## File Reference

```
core/
  src/
    evaluation/
      longmemeval-runner.js         # Main benchmark runner (stream + batch modes)
      longmemeval-routing.js        # Type-aware retrieval routing
    memory/
      predict-calibrate.js          # SOTA 1: Extraction filtering
      operator-layer.js             # SOTA 2: Cognitive rhythm & intent detection
      context-autopilot.js          # SOTA 3: Preemptive compaction
      bi-temporal.js                # SOTA 4: Time-travel knowledge graph
      stigmergic-cot.js             # SOTA 5: Swarm coordination
      byzantine-consensus.js        # SOTA 6: Hallucination protection
      graph-engine.js               # Core memory engine (MemoryGraphEngine)
    external/search/
      three-tier-retrieval.js       # Qdrant + Prisma + Graph hybrid search
    search/
      time-aware-expander.js        # Temporal query expansion
    server.js                       # API server with all endpoints
  evaluation-reports/
    longmemeval-hypotheses.jsonl    # Generated answers
    longmemeval-report.json        # Benchmark report with accuracy breakdown

benchmarks/
  LongMemEval/                     # Official repo (cloned)
    data/
      longmemeval_oracle.json      # Oracle dataset (evidence sessions only)
      longmemeval_s_cleaned.json   # Full S dataset (~40 sessions/question)
    src/evaluation/
      evaluate_qa.py               # Official GPT-4o judge script
      print_qa_metrics.py          # Metrics aggregation
    run-core.js                    # Convenience wrapper for core benchmark

docs/
  longmemeval-benchmark-plan.md   # Original planning document
  LONGMEMEVAL-README.md           # This file
```

---

## Known Issues & Gotchas

1. **`/api/recall` deduplicates aggressively** — returns only 1 result when memories are similar. Use `/api/search/quick` as primary.

2. **Qdrant needs ~1s indexing delay** — after ingesting memories, wait 1000ms before searching. The runner handles this automatically.

3. **Cleanup requires trigger management** — the `audit_logs` table has FK constraints that block cascading deletes. Must disable triggers, delete in order (source_metadata -> memory_versions -> memories), re-enable triggers.

4. **`skipPredictCalibrate: true`** — necessary for benchmark ingestion because LongMemEval sessions are intentionally noisy/similar. Without this flag, predict-calibrate filters out ~60% of sessions.

5. **Panorama search was broken** — `this.panoramaSearch = new PanoramaSearch()` in `three-tier-retrieval.js` constructor shadowed the class method. Fixed by renaming to `this.panoramaSearchEngine`.

6. **Observer auto-summaries** — the HIVEMIND observer creates automatic memory summaries that can pollute search results. Project-based namespace isolation (`bench/longmemeval/{question_id}`) filters these out.

7. **Groq model selection** — `openai/gpt-oss-120b` returns empty strings on yes/no tasks. Use `llama-3.3-70b-versatile` for both generation and judging.
