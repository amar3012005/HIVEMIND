# HIVE-MIND Retrieval Quality Evaluation System

A comprehensive evaluation framework for measuring HIVE-MIND's retrieval performance using standard Information Retrieval metrics.

## Overview

The evaluation system measures retrieval quality across multiple dimensions:

| Metric | Target | Description |
|--------|--------|-------------|
| Precision@5 | >0.80 | % of top 5 results that are relevant |
| Recall@10 | >0.70 | % of all relevant memories found in top 10 |
| F1 Score | >0.75 | Harmonic mean of precision and recall |
| NDCG@10 | >0.75 | Ranking quality measure |
| MRR | >0.60 | Mean reciprocal rank of first relevant result |
| Latency P99 | <300ms | 99th percentile response time |

## Quick Start

### Running Evaluations via CLI

```bash
# Run evaluation with default settings (hybrid search)
node src/evaluation/run-evaluation.js

# Run with specific method
node src/evaluation/run-evaluation.js --method quick

# Run on sample of 10 queries
node src/evaluation/run-evaluation.js --sample 10 --verbose

# Filter by category
node src/evaluation/run-evaluation.js --category technical

# Compare with baseline
node src/evaluation/run-evaluation.js --compare baseline-2026-03-15.json

# Save report to file
node src/evaluation/run-evaluation.js --output my-report.json
```

### Running Evaluations via API

```bash
# Run full evaluation suite
POST /api/evaluate/retrieval
{
  "methods": ["quick", "hybrid", "recall"],
  "sample_size": 10
}

# Evaluate single query
POST /api/evaluate/retrieval
{
  "query": "What was the decision about the database migration?",
  "relevant_memories": ["uuid-1", "uuid-2"],
  "method": "hybrid"
}

# Get latest results
GET /api/evaluate/results

# Get evaluation history
GET /api/evaluate/history?limit=5

# Compare evaluations
POST /api/evaluate/compare
{
  "baseline_id": "eval-uuid-1",
  "current_id": "eval-uuid-2"
}

# Get test dataset info
GET /api/evaluate/dataset
```

## Architecture

### Components

```
src/evaluation/
├── retrieval-evaluator.js    # Core evaluation logic
├── test-dataset.js           # Pre-defined test queries
├── run-evaluation.js         # CLI runner
├── index.js                  # Module exports
└── README.md                 # This file
```

### RetrievalEvaluator Class

The main evaluation engine that provides:

- **Single Query Evaluation**: `evaluateQuery(query, relevantIds, options)`
- **Batch Evaluation**: `evaluateBatch(testQueries, options)`
- **Metric Calculation**: Precision, Recall, F1, NDCG, MRR
- **Report Generation**: Comprehensive evaluation reports
- **Baseline Comparison**: Compare evaluations over time

### Test Dataset

30 enterprise-like queries across three categories:

- **Technical** (10 queries): Database migrations, API design, architecture decisions
- **Business** (10 queries): Revenue targets, customer feedback, hiring plans
- **Personal** (10 queries): Action items, meeting notes, goals

Each query includes:
- Ground truth relevant memory IDs
- Category and difficulty classification
- Tags for filtering

## Metrics Explained

### Precision@K
```
Precision@K = |Relevant ∩ Retrieved| / |Retrieved|
```
Percentage of top K results that are relevant. Higher is better.

### Recall@K
```
Recall@K = |Relevant ∩ Retrieved| / |Relevant|
```
Percentage of all relevant memories found in top K. Higher is better.

### F1 Score
```
F1 = 2 * (Precision * Recall) / (Precision + Recall)
```
Harmonic mean of precision and recall. Balances both metrics.

### NDCG@K (Normalized Discounted Cumulative Gain)
```
DCG = Σ (relevance_i / log2(i + 1))
NDCG = DCG / IDCG
```
Measures ranking quality, giving higher scores to relevant results at top positions.

### MRR (Mean Reciprocal Rank)
```
MRR = 1 / rank_of_first_relevant
```
Measures how quickly the first relevant result appears. Higher is better.

## Search Methods

The evaluation system supports multiple search methods:

| Method | Description | Use Case |
|--------|-------------|----------|
| `quick` | Fast semantic search | Immediate results (<100ms) |
| `panorama` | Historical search | Include expired/archived content |
| `insight` | LLM-powered analysis | Deep analysis with sub-queries |
| `hybrid` | Combined search | Best balance of speed and quality |
| `recall` | Full recall pipeline | Production retrieval |

## Report Format

```json
{
  "timestamp": "2026-03-15T10:30:00.000Z",
  "evaluationId": "uuid",
  "duration": 15000,
  "summary": {
    "precisionAt5": { "mean": 0.82, "min": 0.6, "max": 1.0, "median": 0.8 },
    "recallAt10": { "mean": 0.71, "min": 0.5, "max": 0.9, "median": 0.7 },
    "f1At10": { "mean": 0.76, "min": 0.55, "max": 0.95, "median": 0.75 },
    "ndcgAt10": { "mean": 0.78, "min": 0.6, "max": 0.92, "median": 0.77 },
    "mrr": { "mean": 0.65, "min": 0.33, "max": 1.0, "median": 0.67 },
    "latencyP99": 245,
    "latencyP95": 180,
    "latencyP50": 120,
    "qualityScore": 82,
    "totalQueries": 30,
    "successfulQueries": 30,
    "failedQueries": 0
  },
  "byCategory": {
    "technical": { "count": 10, "metrics": { ... } },
    "business": { "count": 10, "metrics": { ... } },
    "personal": { "count": 10, "metrics": { ... } }
  },
  "bySearchMethod": {
    "hybrid": { "count": 30, "metrics": { ... }, "latencyP99": 245 }
  },
  "failedQueries": [],
  "targets": {
    "precisionAt5": 0.80,
    "recallAt10": 0.70,
    "f1Score": 0.75,
    "ndcgAt10": 0.75,
    "mrr": 0.60,
    "latencyP99": 300
  }
}
```

## Programmatic Usage

```javascript
import { RetrievalEvaluator, TEST_QUERIES } from './src/evaluation/index.js';

// Create evaluator
const evaluator = new RetrievalEvaluator({
  vectorStore: qdrantClient,
  graphStore: prismaStore,
  llmClient: groqClient
});

// Evaluate single query
const result = await evaluator.evaluateQuery(
  "What was the decision about the database migration?",
  ['550e8400-e29b-41d4-a716-446655440001', '550e8400-e29b-41d4-a716-446655440002'],
  {
    userId: 'user-123',
    orgId: 'org-456',
    method: 'hybrid',
    category: 'technical'
  }
);

console.log(`Precision@5: ${result.metrics.precisionAt5}`);
console.log(`Recall@10: ${result.metrics.recallAt10}`);
console.log(`Passed: ${result.passed.allPassed}`);

// Run batch evaluation
const report = await evaluator.evaluateBatch(TEST_QUERIES, {
  userId: 'user-123',
  orgId: 'org-456',
  methods: ['quick', 'hybrid', 'recall'],
  warmup: true
});

console.log(`Quality Score: ${report.summary.qualityScore}/100`);

// Compare with previous evaluation
const baseline = evaluator.getEvaluationHistory()[0];
const current = evaluator.getLatestReport();
const comparison = evaluator.compareReports(baseline, current);

console.log(`Assessment: ${comparison.assessment}`);
console.log(`Improvements:`, Object.keys(comparison.improvements));
console.log(`Regressions:`, Object.keys(comparison.regressions));
```

## CI/CD Integration

The evaluation runner exits with:
- Exit code 0: Quality score >= 75 (pass)
- Exit code 1: Quality score < 75 (fail)

Example GitHub Actions workflow:

```yaml
- name: Run Retrieval Evaluation
  run: node src/evaluation/run-evaluation.js --sample 20
  env:
    HIVEMIND_DEFAULT_USER_ID: ${{ secrets.TEST_USER_ID }}
    HIVEMIND_DEFAULT_ORG_ID: ${{ secrets.TEST_ORG_ID }}
```

## Custom Test Queries

You can provide custom queries for evaluation:

```javascript
const customQueries = [
  {
    query: "Your custom query",
    relevantMemories: ['uuid-1', 'uuid-2'],
    category: 'custom',
    difficulty: 'medium'
  }
];

const report = await evaluator.evaluateBatch(customQueries, {
  userId: 'user-123',
  methods: ['hybrid']
});
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `HIVEMIND_DEFAULT_USER_ID` | Default user for evaluations | `00000000-0000-4000-8000-000000000001` |
| `HIVEMIND_DEFAULT_ORG_ID` | Default org for evaluations | `00000000-0000-4000-8000-000000000002` |

## Troubleshooting

### No evaluation results
- Ensure memories exist with IDs matching the test dataset
- Check that vector store is connected and populated
- Verify user/org IDs have access to memories

### Low quality scores
- Check embedding quality and vector search configuration
- Verify ground truth relevance judgments are accurate
- Consider adjusting search method weights

### High latency
- Check Qdrant connection and indexing
- Consider reducing `limit` parameter
- Enable caching for embeddings

## License

Part of the HIVE-MIND project. See main LICENSE file.
