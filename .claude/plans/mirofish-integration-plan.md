# MiroFish Integration Plan for HIVE-MIND

## Executive Summary

This plan outlines the integration of seven key MiroFish-inspired features into the HIVE-MIND memory system. MiroFish is a multi-agent social simulation engine with sophisticated temporal knowledge graphs, while HIVE-MIND provides a comprehensive memory management infrastructure with vector search, graph relationships, and hybrid retrieval.

---

## Phase Breakdown

### Phase 1: Immediate (Weeks 1-2)
**Goal**: Temporal Edge Lifecycle, Three-Tier Retrieval Architecture foundations

### Phase 2: Short-term (Weeks 3-6)
**Goal**: Batch Ingestion with Retry, Dynamic Ontology Extraction, Multi-Dimensional Memory Scoring

### Phase 3: Long-term (Weeks 7-12)
**Goal**: Memory Enrichment Pipeline, Simulation-to-Memory Feedback

---

## Feature 1: Temporal Edge Lifecycle

### Description
Add temporal awareness to relationships with `valid_from`, `valid_until`, and `temporal_status` fields, enabling time-based relationship queries and historical analysis.

### Implementation Plan

#### Database Schema Changes
**File**: `/Users/amar/HIVE-MIND/core/src/db/schema.sql`

Add temporal columns to the `Relationship` table:
```sql
ALTER TABLE "Relationship" ADD COLUMN "valid_from" TIMESTAMP;
ALTER TABLE "Relationship" ADD COLUMN "valid_until" TIMESTAMP;
ALTER TABLE "Relationship" ADD COLUMN "temporal_status" VARCHAR(20) DEFAULT 'active';
ALTER TABLE "Relationship" ADD COLUMN "expired_at" TIMESTAMP;
```

#### Core Changes
**File**: `/Users/amar/HIVE-MIND/core/src/memory/prisma-graph-store.js`

Update `mapRelationshipRecord` and `createRelationship`:
```javascript
function mapRelationshipRecord(record) {
  return {
    // ... existing fields
    valid_from: record.validFrom ? record.validFrom.toISOString() : null,
    valid_until: record.validUntil ? record.validUntil.toISOString() : null,
    temporal_status: record.temporalStatus || 'active',
    expired_at: record.expiredAt ? record.expiredAt.toISOString() : null,
  };
}

async createRelationship(edge) {
  return this.client.relationship.create({
    data: {
      // ... existing fields
      validFrom: edge.valid_from ? new Date(edge.valid_from) : null,
      validUntil: edge.valid_until ? new Date(edge.valid_until) : null,
      temporalStatus: edge.temporal_status || 'active',
      expiredAt: edge.expired_at ? new Date(edge.expired_at) : null,
    }
  });
}
```

#### New Files
1. **File**: `/Users/amar/HIVE-MIND/core/src/memory/temporal-edge-manager.js`
   - Implements temporal edge lifecycle management
   - Methods: `activateEdge`, `expireEdge`, `getActiveEdges`, `getExpiredEdges`
   - Complexity: Medium (3-4 days)

### Dependencies
- Prisma schema migration
- Updates to graph-engine.js relationship creation

### Testing Strategy
- Unit tests for temporal status transitions
- Integration tests for time-based queries
- Edge case testing for overlapping temporal ranges

---

## Feature 2: Three-Tier Retrieval Architecture

### Description
Implement MiroFish's three-tier search system:
1. **QuickSearch**: Fast semantic search for immediate results
2. **PanoramaSearch**: Comprehensive search including historical/expired content
3. **InsightForge**: Deep multi-dimensional analysis with sub-query generation

### Implementation Plan

#### New Files

**File**: `/Users/amar/HIVE-MIND/src/search/three-tier-retrieval.js`

```javascript
export class ThreeTierRetrieval {
  constructor({ vectorStore, graphStore, llmClient }) {
    this.vectorStore = vectorStore;
    this.graphStore = graphStore;
    this.llmClient = llmClient;
  }

  // Tier 1: Quick Search
  async quickSearch(query, options) {
    // Direct vector + keyword search
    return await this.hybridSearch(query, {
      limit: options.limit || 10,
      includeExpired: false,
      depth: 'shallow'
    });
  }

  // Tier 2: Panorama Search
  async panoramaSearch(query, options) {
    // Include all content including expired/historical
    const results = await this.hybridSearch(query, {
      limit: options.limit || 50,
      includeExpired: true,
      includeHistorical: true,
      depth: 'full'
    });

    return this.categorizeByTemporalStatus(results);
  }

  // Tier 3: Insight Forge
  async insightForge(query, simulationRequirement, options) {
    // Generate sub-queries using LLM
    const subQueries = await this.generateSubQueries(query, simulationRequirement);

    // Search for each sub-query
    const allResults = await Promise.all(
      subQueries.map(sq => this.hybridSearch(sq, { limit: 15 }))
    );

    // Extract entities and build relationship chains
    const entities = await this.extractEntities(allResults);
    const chains = await this.buildRelationshipChains(entities);

    return {
      query,
      subQueries,
      semanticFacts: this.extractFacts(allResults),
      entityInsights: entities,
      relationshipChains: chains
    };
  }
}
```

**File**: `/Users/amar/HIVE-MIND/src/search/insight-forge.js`
- LLM-powered sub-query generation
- Multi-dimensional result aggregation
- Relationship chain building

**File**: `/Users/amar/HIVE-MIND/src/search/panorama-search.js`
- Historical content retrieval
- Temporal categorization
- Full-context result assembly

### Modified Files

**File**: `/Users/amar/HIVE-MIND/src/search/hybrid.js`
- Add `includeExpired` and `includeHistorical` filter options
- Enhance `buildQdrantFilter` to handle temporal filters

### Dependencies
- Temporal edge lifecycle (Feature 1)
- LLM client integration
- Vector store access

### Complexity
- High (7-10 days)
- Requires LLM integration for InsightForge

### Testing Strategy
- Benchmark each tier against existing search
- A/B testing for result quality
- Performance testing for latency requirements

---

## Feature 3: Batch Ingestion with Retry

### Description
Queue-based ingestion system with exponential backoff for handling large document ingestion and external API failures.

### Implementation Plan

#### New Files

**File**: `/Users/amar/HIVE-MIND/src/ingestion/batch-queue.js`

```javascript
export class BatchIngestionQueue {
  constructor(options = {}) {
    this.batchSize = options.batchSize || 5;
    this.maxRetries = options.maxRetries || 3;
    this.initialDelay = options.initialDelay || 1000;
    this.maxDelay = options.maxDelay || 30000;
    this.backoffFactor = options.backoffFactor || 2;
    this.queue = [];
    this.processing = false;
  }

  async add(item) {
    this.queue.push({
      ...item,
      attempts: 0,
      nextAttempt: Date.now()
    });
    if (!this.processing) {
      await this.process();
    }
  }

  async process() {
    this.processing = true;

    while (this.queue.length > 0) {
      const batch = this.takeBatch();
      const results = await this.processBatch(batch);

      // Handle failures with retry
      for (const result of results) {
        if (!result.success) {
          await this.scheduleRetry(result.item);
        }
      }
    }

    this.processing = false;
  }

  calculateDelay(attempt) {
    const delay = this.initialDelay * Math.pow(this.backoffFactor, attempt);
    return Math.min(delay, this.maxDelay) * (0.5 + Math.random());
  }
}
```

**File**: `/Users/amar/HIVE-MIND/src/ingestion/retry-handler.js`
- Exponential backoff implementation
- Dead letter queue for failed items
- Retry statistics tracking

#### Modified Files

**File**: `/Users/amar/HIVE-MIND/src/ingestion/pipeline-orchestrator.js`
- Integrate batch queue into pipeline
- Add retry-aware stage transitions

**File**: `/Users/amar/HIVE-MIND/src/ingestion/index.js`
- Export batch queue functionality

### Dependencies
- None (self-contained)

### Complexity
- Medium (4-5 days)

### Testing Strategy
- Load testing with 1000+ documents
- Simulated failure injection
- Retry timing verification

---

## Feature 4: Dynamic Ontology Extraction

### Description
Auto-detect entity and relationship types from documents using LLM analysis, similar to MiroFish's ontology generation.

### Implementation Plan

#### New Files

**File**: `/Users/amar/HIVE-MIND/src/ingestion/ontology-extractor.js`

```javascript
export class OntologyExtractor {
  constructor(llmClient) {
    this.llmClient = llmClient;
    this.systemPrompt = `You are an ontology design expert. Analyze the provided text and generate entity types and relationship types suitable for a knowledge graph.

Output JSON format:
{
  "entity_types": [
    {
      "name": "PascalCaseName",
      "description": "Brief description",
      "attributes": [{"name": "attr_name", "type": "text", "description": "..."}],
      "examples": ["example1", "example2"]
    }
  ],
  "edge_types": [
    {
      "name": "UPPER_SNAKE_CASE",
      "description": "Brief description",
      "source_targets": [{"source": "EntityType", "target": "EntityType"}]
    }
  ]
}`;
  }

  async extractOntology(documentTexts, context = {}) {
    const combinedText = documentTexts.join('\n\n---\n\n').slice(0, 50000);

    const response = await this.llmClient.chatJson({
      messages: [
        { role: 'system', content: this.systemPrompt },
        { role: 'user', content: this.buildPrompt(combinedText, context) }
      ],
      temperature: 0.3
    });

    return this.validateAndNormalize(response);
  }

  validateAndNormalize(result) {
    // Ensure 10 entity types with fallback types (Person, Organization)
    // Ensure 6-10 edge types
    // Validate against reserved names
    return normalized;
  }
}
```

**File**: `/Users/amar/HIVE-MIND/src/ingestion/entity-recognizer.js`
- Named entity recognition using LLM
- Entity linking to existing memories

#### Modified Files

**File**: `/Users/amar/HIVE-MIND/src/ingestion/pipeline-orchestrator.js`
- Add ontology extraction stage
- Store extracted ontology in metadata

### Dependencies
- LLM client integration
- Feature 6 (Memory Enrichment) for entity linking

### Complexity
- High (7-10 days)
- Requires prompt engineering for quality extraction

### Testing Strategy
- Test on diverse document types
- Compare extracted vs manual ontologies
- Measure entity recognition accuracy

---

## Feature 5: Multi-Dimensional Memory Scoring

### Description
Add influence, stance, and sentiment weights to memories for richer ranking and retrieval.

### Implementation Plan

#### Database Schema Changes
**File**: `/Users/amar/HIVE-MIND/core/src/db/schema.sql`

```sql
ALTER TABLE "Memory" ADD COLUMN "influence_score" FLOAT DEFAULT 0.5;
ALTER TABLE "Memory" ADD COLUMN "stance" VARCHAR(20); -- 'positive', 'negative', 'neutral'
ALTER TABLE "Memory" ADD COLUMN "sentiment_score" FLOAT DEFAULT 0.0; -- -1.0 to 1.0
ALTER TABLE "Memory" ADD COLUMN "multi_dimensional_weights" JSONB DEFAULT '{}';
```

#### Modified Files

**File**: `/Users/amar/HIVE-MIND/core/src/memory/prisma-graph-store.js`
- Update `mapMemoryRecord` to include new scoring fields
- Add methods to update scores

**File**: `/Users/amar/HIVE-MIND/src/recall/scorer.js`

```javascript
export function calculateMultiDimensionalScore(memory, options) {
  const {
    influenceWeight = 0.2,
    sentimentWeight = 0.15,
    stanceWeight = 0.1,
    recencyWeight = 0.25,
    similarityWeight = 0.3
  } = options;

  const influenceScore = memory.influence_score || 0.5;
  const sentimentScore = (memory.sentiment_score || 0) / 2 + 0.5; // Normalize to 0-1
  const stanceScore = calculateStanceScore(memory.stance);

  return {
    total: influenceWeight * influenceScore +
           sentimentWeight * sentimentScore +
           stanceWeight * stanceScore +
           recencyWeight * memory.recencyScore +
           similarityWeight * memory.similarityScore,
    breakdown: {
      influence: influenceScore,
      sentiment: sentimentScore,
      stance: stanceScore,
      recency: memory.recencyScore,
      similarity: memory.similarityScore
    }
  };
}
```

**File**: `/Users/amar/HIVE-MIND/src/recall/ranker.js`
- Add multi-dimensional ranking strategies
- Update `formatResults` to include score breakdowns

### New Files

**File**: `/Users/amar/HIVE-MIND/src/analysis/sentiment-analyzer.js`
- LLM-based sentiment analysis
- Caching for performance

### Dependencies
- LLM client for sentiment analysis
- Prisma schema migration

### Complexity
- Medium-High (5-7 days)

### Testing Strategy
- Compare rankings with and without multi-dimensional scores
- Validate sentiment analysis accuracy
- A/B test user satisfaction

---

## Feature 6: Memory Enrichment Pipeline

### Description
Auto-expand memories by linking related content, extracting entities, and adding contextual metadata.

### Implementation Plan

#### New Files

**File**: `/Users/amar/HIVE-MIND/src/enrichment/memory-enricher.js`

```javascript
export class MemoryEnricher {
  constructor({ graphStore, llmClient, vectorStore }) {
    this.graphStore = graphStore;
    this.llmClient = llmClient;
    this.vectorStore = vectorStore;
  }

  async enrich(memory) {
    const enrichment = {
      entities: await this.extractEntities(memory),
      relatedMemories: await this.findRelated(memory),
      summary: await this.generateSummary(memory),
      topics: await this.extractTopics(memory),
      links: await this.generateLinks(memory)
    };

    await this.updateMemoryMetadata(memory.id, enrichment);
    return enrichment;
  }

  async extractEntities(memory) {
    // Use LLM to extract named entities
    // Link to existing entities or create new ones
  }

  async findRelated(memory) {
    // Vector similarity search
    // Graph traversal for connected memories
  }

  async generateLinks(memory) {
    // Create Derives/Extends relationships based on content similarity
    // Link to entities mentioned in content
  }
}
```

**File**: `/Users/amar/HIVE-MIND/src/enrichment/entity-manager.js`
- Entity disambiguation
- Entity linking across memories

**File**: `/Users/amar/HIVE-MIND/src/enrichment/link-generator.js`
- Automatic relationship detection
- Confidence scoring for auto-generated links

#### Modified Files

**File**: `/Users/amar/HIVE-MIND/src/ingestion/pipeline-orchestrator.js`
- Add enrichment stage after indexing
- Queue enrichment jobs for async processing

**File**: `/Users/amar/HIVE-MIND/core/src/memory/graph-engine.js`
- Add methods for auto-linking memories

### Dependencies
- Feature 4 (Dynamic Ontology) for entity types
- Feature 5 (Multi-Dimensional Scoring) for link confidence
- LLM client

### Complexity
- High (8-10 days)

### Testing Strategy
- Measure enrichment coverage (what % of memories get enriched)
- Manual review of auto-generated links
- Performance testing for large memory sets

---

## Feature 7: Simulation-to-Memory Feedback

### Description
Integrate with multi-agent simulations to capture agent activities as memory events, enabling predictive memory capabilities.

### Implementation Plan

#### New Files

**File**: `/Users/amar/HIVE-MIND/src/simulation/simulation-bridge.js`

```javascript
export class SimulationBridge {
  constructor({ graphStore, memoryEngine }) {
    this.graphStore = graphStore;
    this.memoryEngine = memoryEngine;
    this.activeSimulations = new Map();
  }

  async attachToSimulation(simulationId, graphId) {
    // Create simulation memory updater similar to MiroFish's ZepGraphMemoryUpdater
    const updater = new SimulationMemoryUpdater({
      simulationId,
      graphId,
      graphStore: this.graphStore
    });

    this.activeSimulations.set(simulationId, updater);
    updater.start();
    return updater;
  }

  async recordAgentActivity(activity) {
    // Convert agent activity to memory event
    const memoryEvent = this.convertActivityToMemory(activity);

    // Ingest into graph
    await this.memoryEngine.ingestMemory(memoryEvent);
  }

  convertActivityToMemory(activity) {
    return {
      content: activity.toNaturalLanguage(),
      source_type: 'simulation',
      source_platform: activity.platform,
      metadata: {
        agent_id: activity.agentId,
        agent_name: activity.agentName,
        action_type: activity.actionType,
        round: activity.round,
        simulation_id: activity.simulationId
      }
    };
  }
}
```

**File**: `/Users/amar/HIVE-MIND/src/simulation/simulation-memory-updater.js`
- Adapts MiroFish's `ZepGraphMemoryUpdater` for HIVE-MIND
- Batch processing of agent activities
- Retry logic for ingestion failures

**File**: `/Users/amar/HIVE-MIND/src/simulation/agent-activity.js`
- Activity types: CREATE_POST, LIKE_POST, FOLLOW, etc.
- Natural language generation from activities

**File**: `/Users/amar/HIVE-MIND/src/simulation/predictive-memory.js`
- Analyze simulation patterns to predict future events
- Generate "what-if" memory scenarios

#### Modified Files

**File**: `/Users/amar/HIVE-MIND/core/src/memory/graph-engine.js`
- Add simulation-aware relationship types
- Handle simulation-specific metadata

### Dependencies
- All previous features (1-6)
- Integration with OASIS or similar simulation framework

### Complexity
- Very High (10-14 days)
- Requires external simulation integration

### Testing Strategy
- End-to-end simulation recording tests
- Predictive accuracy evaluation
- Performance under high simulation load

---

## Implementation Sequence

```
Phase 1 (Weeks 1-2):
  1. Temporal Edge Lifecycle
     └─ Database migration
     └─ Prisma store updates
     └─ Graph engine updates

  2. Three-Tier Retrieval (foundations)
     └─ QuickSearch implementation
     └─ PanoramaSearch basic structure

Phase 2 (Weeks 3-6):
  3. Batch Ingestion with Retry
     └─ Queue implementation
     └─ Retry handler
     └─ Pipeline integration

  4. Dynamic Ontology Extraction
     └─ Ontology extractor
     └─ LLM integration
     └─ Pipeline integration

  5. Multi-Dimensional Memory Scoring
     └─ Database migration
     └─ Scorer updates
     └─ Sentiment analyzer

Phase 3 (Weeks 7-12):
  6. Memory Enrichment Pipeline
     └─ Memory enricher
     └─ Entity manager
     └─ Link generator

  7. Simulation-to-Memory Feedback
     └─ Simulation bridge
     └─ Memory updater
     └─ Predictive memory
     └─ OASIS integration

  8. Three-Tier Retrieval (completion)
     └─ InsightForge LLM integration
     └─ Full testing
```

---

## Dependencies Summary

| Feature | Depends On | Blocks |
|---------|------------|--------|
| 1. Temporal Edge | - | 2, 7 |
| 2. Three-Tier | 1 | - |
| 3. Batch Ingestion | - | - |
| 4. Ontology Extraction | LLM | 6 |
| 5. Multi-Dim Scoring | - | 6, 7 |
| 6. Memory Enrichment | 4, 5 | 7 |
| 7. Simulation Feedback | 1, 5, 6 | - |

---

## Testing Strategy

### Unit Testing
- Each new module requires comprehensive unit tests
- Mock LLM client for deterministic testing
- Temporal edge state machine testing

### Integration Testing
- End-to-end ingestion pipeline tests
- Search tier integration tests
- Simulation bridge integration tests

### Performance Testing
- Batch ingestion throughput (target: 100 docs/sec)
- Search latency (target: <100ms for QuickSearch, <500ms for InsightForge)
- Memory enrichment processing time

### A/B Testing
- Compare new search tiers against existing hybrid search
- Measure user satisfaction with enriched memories
- Evaluate predictive memory accuracy

---

## Critical Files for Implementation

- `/Users/amar/HIVE-MIND/core/src/db/schema.sql` - Database schema modifications for temporal edges and multi-dimensional scoring
- `/Users/amar/HIVE-MIND/core/src/memory/prisma-graph-store.js` - Core data access layer requiring updates for temporal fields and scoring
- `/Users/amar/HIVE-MIND/core/src/memory/graph-engine.js` - Memory graph operations, relationship creation
- `/Users/amar/HIVE-MIND/src/search/hybrid.js` - Foundation for three-tier retrieval architecture
- `/Users/amar/HIVE-MIND/src/ingestion/pipeline-orchestrator.js` - Ingestion pipeline integration point for batch queue and enrichment

---

This implementation plan provides a comprehensive roadmap for integrating MiroFish's sophisticated memory and retrieval features into HIVE-MIND while maintaining the existing architecture and patterns.
