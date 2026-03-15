# Recall Scoring Algorithm

## Overview

HIVE-MIND's recall scoring algorithm combines multiple factors to rank memories by relevance:
- **Vector similarity** (40%): Semantic match between query and memory
- **Recency bias** (30% × recencyBias): How recent the memory is
- **Importance** (20%): User-assigned or model-estimated importance
- **Ebbinghaus decay** (10%): Memory strength and forgetting curve

## Algorithm Formula

```
finalScore = vector×0.4 + recency×recencyBias×0.3 + importance×0.2 + ebbinghaus×(1-recencyBias)×0.1
```

Where:
- `vector` = normalized cosine similarity (0-1)
- `recency` = exponential decay: 2^(-days/halfLife) × bias + (1-bias) × 0.5
- `importance` = base importance with boosts/penalties
- `ebbinghaus` = exp(-days × decayRate) + recallBoost

## Components

### 1. Vector Similarity (40% weight)

**Input**: Raw cosine similarity from Qdrant search (-1 to 1)

**Normalization**:
```javascript
normalizedScore = (rawScore + 1) / 2  // Maps -1..1 to 0..1
```

**Weighted Score**: `normalizedScore × 0.4`

### 2. Recency Bias (30% weight × recencyBias)

**Formula**:
```
daysSince = (now - documentDate) / (24 * 60 * 60 * 1000)
baseDecay = 2^(-daysSince / halfLifeDays)
recencyScore = baseDecay × recencyBias + (1 - recencyBias) × 0.5
```

**Parameters**:
- `halfLifeDays`: 30 days (memory becomes half as relevant)
- `recencyBias`: 0.7 (default, configurable per query)

**Weighted Score**: `recencyScore × 0.3`

### 3. Importance (20% weight)

**Formula**:
```
adjustedImportance = baseImportance × multiplier
if (baseImportance >= 0.8) adjustedImportance *= 1.15  // High boost
if (baseImportance <= 0.3) adjustedImportance *= 0.8   // Low penalty
```

**Weighted Score**: `adjustedImportance × 0.2`

### 4. Ebbinghaus Decay (10% weight × (1-recencyBias))

**Formula**:
```
daysSince = (now - lastConfirmedAt) / (24 * 60 * 60 * 1000)
effectiveStrength = min(strength, 10) + recallCount × 0.15
adjustedDecayRate = decayRate / (effectiveStrength / 2)
retention = exp(-daysSince × adjustedDecayRate) + recallCount × 0.05
```

**Parameters**:
- `decayRate`: 1/7 per day (half-life of 7 days)
- `maxStrength`: 10.0
- `recallBoost`: 0.15 per recall

**Weighted Score**: `retention × 0.1`

## Dynamic Weight Adjustment

Weights adjust based on query type:

| Query Type | Vector | Recency | Importance | Ebbinghaus |
|------------|--------|---------|------------|------------|
| Recent/Latest | 0.35 | 0.40 | 0.15 | 0.10 |
| Important/Critical | 0.35 | 0.25 | 0.30 | 0.10 |
| Specific/Factual | 0.50 | 0.20 | 0.15 | 0.15 |
| Learning/Knowledge | 0.35 | 0.20 | 0.15 | 0.30 |

## Quality Metrics

### NDCG@10 (Normalized Discounted Cumulative Gain)

Measures ranking quality:
```
DCG@k = Σ(rel_i / log2(i + 2)) for i = 1 to k
IDCG@k = DCG with ideal (sorted) relevance
NDCG@k = DCG / IDCG
```

**Target**: > 0.8

### MRR (Mean Reciprocal Rank)

Measures first relevant result position:
```
MRR = (1/n) × Σ(1 / rank_i)
```

**Target**: > 0.6

### Precision@10

Measures relevant results in top 10:
```
P@10 = (relevant in top 10) / 10
```

**Target**: > 0.7

## Configuration

```javascript
{
  weights: {
    vector: 0.4,
    recency: 0.3,
    importance: 0.2,
    ebbinghaus: 0.1
  },
  recency: {
    halfLifeDays: 30,
    recencyBias: 0.7
  },
  ebbinghaus: {
    halfLifeDays: 7,
    maxStrength: 10.0,
    decayRate: 1/7,
    recallBoost: 0.15
  }
}
```

## Usage Example

```javascript
import { calculateCombinedScore } from './recall/scorer.js';

const memory = {
  id: 'uuid',
  content: 'User prefers TypeScript for backend',
  memory_type: 'preference',
  importance_score: 0.8,
  strength: 3.5,
  recall_count: 5,
  document_date: new Date('2024-03-01'),
  last_confirmed_at: new Date('2024-03-05')
};

const result = calculateCombinedScore(memory, {
  vectorScore: 0.75,
  vectorMetric: 'cosine',
  recencyBias: 0.7
});

console.log(result.finalScore); // 0.723
console.log(result.breakdown);  // Component scores
```

## Performance

- **P99 latency**: < 200ms for 100 memories
- **Cache hit rate**: > 80% for repeated queries
- **Memory overhead**: ~1KB per scored memory

## References

- Ebbinghaus, H. (1885). *Memory: A Contribution to Experimental Psychology*
- Järvelin, K., & Kekäläinen, J. (2002). *Cumulated Gain-based IR Evaluation*
- Recchioni, A., et al. (2021). *Spaced Repetition for Long-Term Memory in LLMs*
