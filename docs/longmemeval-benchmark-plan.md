# LongMemEval Benchmark Implementation Plan

## Objective

Run HIVEMIND against the official LongMemEval_S benchmark to produce verifiable, comparable SOTA scores against Supermemory's 81.6% baseline. This establishes HIVEMIND as the #1 memory engine globally with mathematical proof.

---

## Targets to Beat (Supermemory on GPT-4o)

| Category | Supermemory Score | HIVEMIND Target | What It Tests |
|----------|-------------------|-----------------|---------------|
| **Overall** | 81.6% | >82% | All categories combined |
| **Knowledge Update (KU)** | 88.46% | >89% | Can the engine retrieve the *latest* version of a fact that was updated across sessions? |
| **Temporal Reasoning (TR)** | 76.69% | >77% | Can the engine answer "what happened before/after X?" using timestamps? |
| **Multi-Session (MS)** | 71.43% | >72% | Can the engine connect facts scattered across multiple conversation sessions? |

---

## Dataset

### Source
- **Dataset**: `longmemeval_s.json` from HuggingFace (`xiaowu0162/LongMemEval`)
- **Eval Script**: `evaluate_qa.py` from GitHub `xiaowu0162/LongMemEval`
- **MemoryBench** (optional reference): Supermemory's open-source `memorybench` repo for cross-provider comparison harness
- **License**: MIT (open source)

### Dataset Structure
- **500 evaluation instances** (questions with ground truth answers)
- **~115k tokens per question** (~40 chat history sessions per instance)
- **~57.5M tokens total** across all instances
- **30 abstention instances** (question_id ends in `_abs`) — skip during retrieval eval

### Fields per Instance
```json
{
  "question_id": "ku_42",
  "question_type": "knowledge_update",   // ku, tr, ms, or abs
  "question": "What is Alice's favorite ice cream flavor?",
  "answer": "She recently switched to mango.",
  "haystack_dates": ["2024-01-15", "2024-02-20", ...],
  "haystack_sessions": [
    [
      {"role": "user", "content": "I love pistachio ice cream"},
      {"role": "assistant", "content": "Great choice!"},
      ...
    ],
    ...
  ]
}
```

---

## Architecture — How HIVEMIND's Existing Features Map

### Predict-Calibrate (Knowledge Update advantage)
- Each session is ingested through the predict-calibrate filter
- Delta extraction ensures that when Session 30 says "I switched to mango", the engine stores a NEW memory with `is_latest=true` and marks the old "pistachio" memory as `is_latest=false`
- The `is_latest` penalty in scorer/hybrid ensures the old fact is demoted
- **This directly targets the KU category (88.46% to beat)**

### Bi-Temporal Knowledge Graph (Temporal Reasoning advantage)
- `haystack_dates[i]` maps to `documentDate` (transaction time — when HIVEMIND learned it)
- Operator Layer extracts `eventDate` (valid time — when the event actually happened)
- Time-travel queries (`asOfTransaction`, `asOfValid`) enable "what did we know on date X?"
- **This directly targets the TR category (76.69% to beat)**

### Operator Layer (Multi-Session advantage)
- Intent detection classifies each benchmark question as temporal/factual/exploratory
- Dynamic weight adjustment routes temporal questions to recency-boosted search
- Cognitive frame assembly pulls anchor + trajectory memories across sessions
- **This directly targets the MS category (71.43% to beat)**

### Hybrid Search + Scorer
- Vector (Qdrant) + Keyword (PostgreSQL FTS) + Graph (AGE relationships)
- Semantic-majority scoring: vector 0.50, matchBonus 0.20
- Pre-filter thresholds and diversity enforcement reduce noise in top-K

---

## Implementation Steps

### Step 0: Prerequisites

```bash
# Required API keys
GROQ_API_KEY=...           # For ingestion + generation (cheap, fast)
OPENAI_API_KEY=...         # For GPT-4o judge ONLY (~$5 for 500 calls)
HIVEMIND_API_KEY=...       # Production or local API key

# Required tools
pip install openai          # For evaluate_qa.py judge script
npm install                 # HIVEMIND core dependencies
```

**Estimated cost: ~$15 total per full run**
- Mistral embeddings: ~$2.30 (57.5M tokens @ $0.04/1M)
- Groq ingestion/generation: ~$5
- GPT-4o judging: ~$5

### Step 1: Download Dataset + Eval Script

```bash
# Clone official LongMemEval repo
git clone https://github.com/xiaowu0162/LongMemEval.git /opt/HIVEMIND/benchmarks/LongMemEval

# Download dataset from HuggingFace
cd /opt/HIVEMIND/benchmarks/LongMemEval
# Follow repo instructions to download longmemeval_s.json into data/

# Verify
python3 -c "import json; d=json.load(open('data/longmemeval_s.json')); print(f'{len(d)} instances')"
# Expected: 500 instances
```

### Step 2: Build Ingestion Runner

Create `core/src/evaluation/longmemeval-runner.js`:

```javascript
/**
 * LongMemEval Ingestion Runner
 *
 * Ingests LongMemEval_S dataset session-by-session into HIVEMIND.
 * Maps haystack_dates to documentDate (transaction time).
 * Uses predict-calibrate for delta extraction across sessions.
 *
 * Usage:
 *   node longmemeval-runner.js --dataset /path/to/longmemeval_s.json
 */

// Key implementation details:
//
// 1. Create isolated tenant for benchmark:
//    userId: 'longmemeval-bench-001'
//    orgId:  'longmemeval-org-001'
//
// 2. For each of the 500 instances:
//    a. Clear/isolate memory space (or use unique project tags)
//    b. Ingest each of the ~40 haystack_sessions sequentially
//    c. Map haystack_dates[i] to documentDate on each memory
//    d. Let predict-calibrate handle delta extraction
//    e. Let bi-temporal engine track transaction vs valid time
//
// 3. Tag each ingested memory with:
//    - question_id (for traceability)
//    - session_index (for ordering)
//    - benchmark: 'longmemeval_s'
//
// 4. Concurrency: Process instances in batches of 10-20 for speed
//    Each instance is independent (different haystack), so parallelism is safe
//
// 5. Output: Log ingestion stats per instance
//    - memories_created, memories_deduplicated, sessions_processed
//    - Total ingestion time

// Pseudocode:
async function ingestInstance(instance, apiClient) {
  const { question_id, haystack_dates, haystack_sessions } = instance;

  for (let i = 0; i < haystack_sessions.length; i++) {
    const session = haystack_sessions[i];
    const sessionDate = haystack_dates[i];

    // Convert chat session to memory content
    const content = session
      .map(msg => `${msg.role}: ${msg.content}`)
      .join('\n');

    await apiClient.post('/api/memories', {
      content,
      title: `LongMemEval session ${i + 1} for ${question_id}`,
      tags: ['benchmark', 'longmemeval', question_id],
      memory_type: 'event',
      document_date: sessionDate,
      project: `longmemeval-${question_id}`,
      // Predict-calibrate runs automatically on ingest
    });
  }
}
```

### Step 3: Build Evaluation Runner

Create `core/src/evaluation/longmemeval-evaluate.js`:

```javascript
/**
 * LongMemEval Evaluation Runner
 *
 * Runs retrieval + generation for all 500 LongMemEval questions.
 * Outputs .jsonl file for official evaluate_qa.py script.
 *
 * Usage:
 *   node longmemeval-evaluate.js \
 *     --dataset /path/to/longmemeval_s.json \
 *     --output /path/to/hypotheses.jsonl
 */

// Key implementation details:
//
// 1. For each instance (skip _abs for retrieval-only eval):
//    a. Run hybrid search with the question text
//    b. Filter results to project=longmemeval-{question_id}
//    c. Inject top-K retrieved chunks into generation prompt
//    d. Generate answer via Groq (Llama 3.3 70B or similar)
//    e. Save {question_id, hypothesis} to output
//
// 2. Search strategy per question_type:
//    - knowledge_update (KU): Use is_latest=true filter, recency boost
//    - temporal_reasoning (TR): Use bi-temporal asOfValid/asOfTransaction
//    - multi_session (MS): Use graph traversal for cross-session links
//    - abstention (abs): Generate "I don't have information about this"
//
// 3. Generation prompt template:
//    "Based on the following conversation history from my memory:
//     {retrieved_chunks}
//     Answer this question: {question}
//     If you cannot find the answer in the provided context, say so."
//
// 4. Output format (one JSON per line):
//    {"question_id": "ku_42", "hypothesis": "Her favorite is now mango."}
//
// 5. Concurrency: Batch 20 questions at a time
//    Groq handles 800+ tokens/sec, so generation is fast

// Pseudocode:
async function evaluateQuestion(instance, apiClient, groqClient) {
  const { question_id, question, question_type } = instance;

  // Skip abstention for retrieval eval
  const isAbstention = question_id.endsWith('_abs');

  // Retrieve relevant memories
  const searchResults = await apiClient.post('/api/search/quick', {
    query: question,
    project: `longmemeval-${question_id}`,
    limit: 10,
  });

  // Build context from top results
  const context = searchResults.results
    .slice(0, 5)
    .map(r => r.content)
    .join('\n---\n');

  // Generate hypothesis via Groq
  const hypothesis = await groqClient.chat({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: 'Answer based only on the provided context.' },
      { role: 'user', content: `Context:\n${context}\n\nQuestion: ${question}` }
    ],
    temperature: 0,
    max_tokens: 200,
  });

  return {
    question_id,
    hypothesis: hypothesis.choices[0].message.content,
  };
}
```

### Step 4: Run Official LLM-as-Judge

```bash
cd /opt/HIVEMIND/benchmarks/LongMemEval

# Run official evaluation (requires OPENAI_API_KEY for GPT-4o judge)
OPENAI_API_KEY=sk-... python src/evaluation/evaluate_qa.py \
  --generation_file /opt/HIVEMIND/core/evaluation-reports/longmemeval-hypotheses.jsonl

# Output: evaluation log with autoeval_label per question + averaged scores
# Expected output format:
#   Overall: XX.X%
#   Knowledge Update (KU): XX.X%
#   Temporal Reasoning (TR): XX.X%
#   Multi-Session (MS): XX.X%
```

### Step 5: Compare Against Baselines

```bash
# Save results
cp evaluation_log.json /opt/HIVEMIND/core/evaluation-reports/longmemeval-results.json

# Compare:
# | Category | Supermemory | HIVEMIND | Delta |
# |----------|-------------|----------|-------|
# | Overall  | 81.6%       | ??%      | +??   |
# | KU       | 88.46%      | ??%      | +??   |
# | TR       | 76.69%      | ??%      | +??   |
# | MS       | 71.43%      | ??%      | +??   |
```

---

## Optimization Strategies (If Scores Need Boosting)

### If KU (Knowledge Update) is low:
- Tighten predict-calibrate similarity threshold (currently 0.70)
- Ensure `is_latest` penalty is aggressive enough (currently *0.55)
- Verify delta extraction catches "I switched from X to Y" patterns

### If TR (Temporal Reasoning) is low:
- Verify bi-temporal `documentDate` mapping from `haystack_dates`
- Add date-range pre-filtering in hybrid search for temporal queries
- Boost recency weight when operator layer detects temporal intent

### If MS (Multi-Session) is low:
- Verify graph relationships are being created across sessions
- Increase graph search weight in hybrid fusion for exploratory queries
- Ensure stigmergic traces connect related facts across sessions

### If Overall is low:
- Tune hybrid fusion weights (currently vector 0.6, keyword 0.3, graph 0.1)
- Lower pre-filter thresholds to allow more candidates through
- Increase generation context window (more chunks = more information)

---

## File Structure (When Implemented)

```
core/
  src/evaluation/
    longmemeval-runner.js        # Ingestion pipeline
    longmemeval-evaluate.js      # Retrieval + generation pipeline
  evaluation-reports/
    longmemeval-hypotheses.jsonl  # Generated answers
    longmemeval-results.json      # Official eval results
benchmarks/
  LongMemEval/                   # Cloned official repo
    data/longmemeval_s.json      # The 500-instance dataset
    src/evaluation/evaluate_qa.py # Official judge script
docs/
  longmemeval-benchmark-plan.md  # This file
```

---

## API Call Breakdown

| Step | Calls | Model | Cost |
|------|-------|-------|------|
| Embedding (ingestion) | ~20,000 | Mistral embed | ~$2.30 |
| Predict-Calibrate (ingestion) | ~20,000 | Groq Llama 3 | ~$3.00 |
| Retrieval (search) | 470 | HIVEMIND hybrid | $0 (self-hosted) |
| Generation (answers) | 500 | Groq Llama 3 | ~$2.00 |
| Judging (eval) | 500 | GPT-4o | ~$5.00 |
| **Total** | **~41,470** | | **~$12-15** |

**Estimated wall-clock time**: 45-60 minutes with concurrent processing.

---

## Prerequisites Checklist

- [ ] GPT-4o API key (OpenAI) — for official judging step
- [ ] Groq API key — for ingestion + generation (already have: `gsk_S77N...`)
- [ ] Download `longmemeval_s.json` from HuggingFace
- [ ] Clone `xiaowu0162/LongMemEval` repo for eval script
- [ ] Create isolated benchmark tenant in HIVEMIND
- [ ] Verify Qdrant has capacity for ~20,000 additional vectors
- [ ] Verify Mistral embedding endpoint is accessible

---

## Success Criteria

1. All 500 questions processed without pipeline failures
2. Overall score > 81.6% (beats Supermemory)
3. Results reproducible (same dataset, same judge, same methodology)
4. Results publishable (proper formatting for blog/marketing)

## When to Execute

This benchmark should be run after:
1. Current auto-evaluation system is stable in production
2. GPT-4o API key is available
3. Sufficient Qdrant capacity confirmed (~20K additional vectors)
4. A quiet maintenance window (~1 hour) is available
