# Phase 2 Implementation Plan: Contextual Retrieval Pipeline

**Document Version:** 1.0  
**Date:** 2026-03-09  
**Status:** 🚧 IN PROGRESS  
**Priority:** P0 - Critical Path  

---

## Executive Summary

The Contextual Retrieval Pipeline addresses the fundamental limitation of traditional RAG: **context fragmentation**. When a text chunk is separated from its source document, semantic meaning is lost, causing failed retrievals. This plan implements a "Pre-Embedding Situationalizer" step that uses a lightweight LLM to generate one-sentence context before vector embedding.

**Target:** Match Supermemory.ai's contextual retrieval with Groq API for cost efficiency.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    CONTEXTUAL RETRIEVAL PIPELINE                            │
└─────────────────────────────────────────────────────────────────────────────┘

┌──────────────┐    ┌──────────────────┐    ┌──────────────────┐    ┌──────────────┐
│   Document   │    │   Chunking       │    │  Pre-Embedding   │    │   Vector     │
│   / Stream   │───▶│  (Text/AST)      │───▶│  Situationalizer │───▶│   Embedding  │
└──────────────┘    └──────────────────┘    └──────────────────┘    └──────────────┘
                                                 │
                                                 ▼
                                    ┌─────────────────────────────┐
                                    │   Lightweight LLM (Groq)    │
                                    │   • Claude 3 Haiku          │
                                    │   • Mistral 7B              │
                                    │   • Groq Llama 3 70B        │
                                    └─────────────────────────────┘
                                                 │
                                                 ▼
                                    ┌─────────────────────────────┐
                                    │   Context Template          │
                                    │   "This is from [SOURCE];    │
                                    │    [ORIGINAL_TEXT]"         │
                                    └─────────────────────────────┘
                                                 │
                                                 ▼
                                    ┌─────────────────────────────┐
                                    │   Groq Embedding API        │
                                    │   • nomic-embed-text        │
                                    │   • 768-dim vectors         │
                                    └─────────────────────────────┘
```

---

## Current State Gap Analysis

| Component | Current Implementation | Target (Supermemory) | Gap |
|-----------|----------------------|---------------------|-----|
| Pre-Embedding Context | ❌ None | ✅ Lightweight LLM situationalizer | **HIGH** |
| Context Template | ❌ None | ✅ "[SOURCE]; [ORIGINAL_TEXT]" | **HIGH** |
| Groq API Integration | ⚠️ Partial (embeddings only) | ✅ Full LLM inference | **MEDIUM** |
| Cost Optimization | ❌ None | ✅ Caching + batching | **MEDIUM** |

---

## Implementation Steps

### Step 1: Groq LLM Client Integration

**Effort:** 2 days  
**Dependencies:** None  
**Files:** `core/src/llm/groq.js`

```javascript
/**
 * Groq LLM Client for Situationalizer
 * Uses Groq Cloud API for lightweight LLM inference
 */

import { getGroqClient } from '../config/groq.js';

export class GroqSituationalizer {
  constructor() {
    this.groqClient = getGroqClient();
    this.model = process.env.SITUATIONALIZER_MODEL || 'llama-3-70b-8192';
    this.cache = new Map();
    this.maxCacheAge = 3600000; // 1 hour
  }

  /**
   * Generate situational context for a chunk
   * @param {Object} params
   * @param {string} params.fullDocument - Original document content
   * @param {string} params.chunk - Text chunk to contextualize
   * @param {string} params.source - Document source metadata
   * @param {string} params.chunkIndex - Chunk position in document
   * @returns {Promise<string>} Situationalized context
   */
  async generateContext({ fullDocument, chunk, source, chunkIndex = 0 }) {
    const cacheKey = this._generateCacheKey({ fullDocument, chunk, source });
    
    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.maxCacheAge) {
      return cached.context;
    }

    const prompt = this._buildSituationalizerPrompt({
      fullDocument,
      chunk,
      source,
      chunkIndex
    });

    try {
      const response = await this.groqClient.generate({
        model: this.model,
        messages: [
          { role: 'system', content: this._getSystemPrompt() },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3, // Low temp for factual consistency
        max_tokens: 150
      });

      const context = response.choices[0].message.content.trim();
      
      // Cache result
      this.cache.set(cacheKey, {
        context,
        timestamp: Date.now()
      });

      return context;
    } catch (error) {
      console.error('Situationalizer failed:', error);
      // Fallback: simple template
      return this._fallbackContext({ source, chunk });
    }
  }

  /**
   * Build prompt for situationalizer
   */
  _buildSituationalizerPrompt({ fullDocument, chunk, source, chunkIndex }) {
    return `Analyze this text chunk and generate a one-sentence context that situates it within the broader document.

Document Source: ${source}
Chunk Position: ${chunkIndex}

FULL DOCUMENT (for context):
${fullDocument.substring(0, 2000)}

TEXT CHUNK TO CONTEXTUALIZE:
"${chunk}"

INSTRUCTIONS:
1. Identify the document type (report, code, conversation, etc.)
2. Extract the main topic or purpose
3. Describe how this chunk relates to the overall document
4. Output exactly ONE sentence in this format:
   "This is from [DOCUMENT_TYPE] about [TOPIC]; [CHUNK]"

OUTPUT FORMAT (ONE SENTENCE ONLY):
`;
  }

  /**
   * System prompt for situationalizer
   */
  _getSystemPrompt() {
    return `You are a precise context generator. Your task is to create a single sentence that situates a text chunk within its source document.

RULES:
- Output exactly ONE sentence
- Format: "This is from [DOCUMENT_TYPE] about [TOPIC]; [ORIGINAL_TEXT]"
- Do not add explanations or commentary
- Keep it concise but informative
- Preserve the original text exactly as given
`;
  }

  /**
   * Fallback context generation (no LLM)
   */
  _fallbackContext({ source, chunk }) {
    const sourceType = this._detectSourceType(source);
    return `This is from ${sourceType} document; "${chunk.substring(0, 100)}..."`;
  }

  /**
   * Detect document type from source
   */
  _detectSourceType(source) {
    if (!source) return 'unknown';
    
    const lower = source.toLowerCase();
    if (lower.includes('.pdf') || lower.includes('report')) return 'report';
    if (lower.includes('.md') || lower.includes('readme')) return 'documentation';
    if (lower.includes('.py') || lower.includes('.js')) return 'code';
    if (lower.includes('meeting') || lower.includes('chat')) return 'conversation';
    
    return 'document';
  }

  /**
   * Generate cache key
   */
  _generateCacheKey({ fullDocument, chunk, source }) {
    const hash = (str) => {
      let h = 0;
      for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h) + str.charCodeAt(i);
        h = h & h;
      }
      return Math.abs(hash).toString(36);
    };
    
    return `situationalizer:${hash(source)}:${hash(chunk.substring(0, 200))}`;
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getStats() {
    return {
      cacheSize: this.cache.size,
      model: this.model
    };
  }
}

// Singleton
let situationalizer = null;
export function getSituationalizer() {
  if (!situationalizer) {
    situationalizer = new GroqSituationalizer();
  }
  return situationalizer;
}
```

---

### Step 2: Context Injection Pipeline

**Effort:** 3 days  
**Dependencies:** Step 1  
**Files:** `core/src/pipeline/contextual.js`

```javascript
/**
 * Contextual Retrieval Pipeline
 * Integrates situationalizer with embedding pipeline
 */

import { getSituationalizer } from '../llm/groq.js';
import { getGroqEmbedService } from '../embedding/groq.js';

export class ContextualPipeline {
  constructor() {
    this.situationalizer = getSituationalizer();
    this.embedService = getGroqEmbedService();
    this.maxDocumentSize = 10000; // Characters
  }

  /**
   * Process a document through the contextual pipeline
   * @param {Object} params
   * @param {string} params.content - Document content
   * @param {string} params.source - Document source
   * @param {string} params.userId - User ID
   * @param {string} params.orgId - Organization ID
   * @param {string} params.project - Project name
   * @param {Object} [params.metadata={}] - Additional metadata
   * @returns {Promise<Object[]>} Array of contextualized chunks with embeddings
   */
  async processDocument({ content, source, userId, orgId, project, metadata = {} }) {
    // Step 1: Chunk the document
    const chunks = this._chunkDocument({ content, source });
    
    // Step 2: Generate context for each chunk
    const contextualizedChunks = await Promise.all(
      chunks.map((chunk, index) => 
        this._contextualizeChunk({
          chunk,
          fullDocument: content,
          source,
          chunkIndex: index,
          userId,
          orgId,
          project,
          metadata
        })
      )
    );

    // Step 3: Generate embeddings for contextualized chunks
    const textsToEmbed = contextualizedChunks.map(c => c.contextualizedText);
    const embeddings = await this.embedService.embedBatch(textsToEmbed);

    // Step 4: Combine results
    return contextualizedChunks.map((chunk, index) => ({
      ...chunk,
      embedding: embeddings[index],
      embeddingDimension: this.embedService.getDimension()
    }));
  }

  /**
   * Contextualize a single chunk
   */
  async _contextualizeChunk({ chunk, fullDocument, source, chunkIndex, userId, orgId, project, metadata }) {
    // Generate situational context
    const context = await this.situationalizer.generateContext({
      fullDocument: fullDocument.substring(0, this.maxDocumentSize),
      chunk: chunk.text,
      source,
      chunkIndex
    });

    // Inject context before original text
    const contextualizedText = `${context}\n\n${chunk.text}`;

    return {
      ...chunk,
      context,
      contextualizedText,
      userId,
      orgId,
      project,
      metadata: {
        ...metadata,
        chunkIndex,
        source,
        contextGeneratedAt: new Date().toISOString()
      }
    };
  }

  /**
   * Chunk document into manageable pieces
   */
  _chunkDocument({ content, source }) {
    const chunks = [];
    const chunkSize = 1500; // Characters
    const overlap = 100;

    let position = 0;
    let chunkIndex = 0;

    while (position < content.length) {
      const chunkText = content.substring(position, position + chunkSize);
      
      chunks.push({
        text: chunkText,
        position,
        chunkIndex: chunkIndex++
      });

      position += chunkSize - overlap;
    }

    return chunks;
  }

  /**
   * Batch process multiple documents
   */
  async processDocuments(documents) {
    const results = [];
    
    for (const doc of documents) {
      try {
        const processed = await this.processDocument(doc);
        results.push(...processed);
      } catch (error) {
        console.error(`Failed to process document ${doc.source}:`, error);
      }
    }

    return results;
  }

  /**
   * Get pipeline statistics
   */
  getStats() {
    return {
      situationalizer: this.situationalizer.getStats(),
      embedService: this.embedService.getStats()
    };
  }
}

// Singleton
let contextualPipeline = null;
export function getContextualPipeline() {
  if (!contextualPipeline) {
    contextualPipeline = new ContextualPipeline();
  }
  return contextualPipeline;
}
```

---

### Step 3: API Endpoints

**Effort:** 2 days  
**Dependencies:** Steps 1 & 2  
**Files:** `core/src/server.js` (extensions)

```javascript
// Add to server.js API routes

case '/api/contextual/process':
  if (req.method === 'POST') {
    const pipeline = getContextualPipeline();
    const results = await pipeline.processDocument({
      content: body.content,
      source: body.source,
      userId: body.userId || DEFAULT_USER,
      orgId: body.orgId || DEFAULT_ORG,
      project: body.project,
      metadata: body.metadata
    });
    jsonResponse(res, { chunks: results, count: results.length });
  }
  break;

case '/api/contextual/stats':
  const pipeline = getContextualPipeline();
  jsonResponse(res, pipeline.getStats());
  break;
```

---

## Cost Optimization Strategies

### 1. Caching Strategy

| Cache Level | Duration | Coverage | Savings |
|-------------|----------|----------|---------|
| LLM Response | 1 hour | Same document+chunk | ~70% |
| Embedding | 24 hours | Same contextualized text | ~80% |
| Full Pipeline | 7 days | Same document | ~90% |

### 2. Batch Processing

```javascript
// Process 100 chunks in parallel
const BATCH_SIZE = 100;
const batches = chunks.reduce((acc, chunk, i) => {
  const batchIndex = Math.floor(i / BATCH_SIZE);
  acc[batchIndex] = acc[batchIndex] || [];
  acc[batchIndex].push(chunk);
  return acc;
}, []);

// Process batches sequentially
for (const batch of batches) {
  await Promise.all(batch.map(chunk => processChunk(chunk)));
}
```

### 3. Model Selection Matrix

| Use Case | Model | Cost/1M tokens | Latency |
|----------|-------|---------------|---------|
| Situationalizer | Llama 3 70B | $0.59/$0.79 | ~2s |
| Fallback Context | Template | $0 | instant |
| Embedding | nomic-embed-text | $0.05 | ~500ms |

### 4. Usage Limits

```javascript
// Rate limiting per user
const RATE_LIMITS = {
  dailyContextualizations: 1000,
  dailyEmbeddings: 10000,
  maxDocumentSize: 100000 // 100KB
};
```

---

## Testing Strategy

### Unit Tests

```javascript
// tests/contextual.test.js
import { describe, it, expect, beforeEach } from 'node:test';
import { GroqSituationalizer } from '../src/llm/groq.js';
import { ContextualPipeline } from '../src/pipeline/contextual.js';

describe('GroqSituationalizer', () => {
  let situationalizer;
  
  beforeEach(() => {
    situationalizer = new GroqSituationalizer();
  });

  it('generates context for a chunk', async () => {
    const context = await situationalizer.generateContext({
      fullDocument: 'Q3 2025 Financial Report: Revenue grew by 15%',
      chunk: 'Cloud services revenue increased by 25%',
      source: 'q3-2025-financial-report.pdf',
      chunkIndex: 3
    });
    
    expect(context).toMatch(/Q3 2025 Financial Report/);
    expect(context).toMatch(/Cloud services/);
  });

  it('caches results', async () => {
    const context1 = await situationalizer.generateContext({ ... });
    const context2 = await situationalizer.generateContext({ ... });
    
    expect(context1).toBe(context2);
    expect(situationalizer.getStats().cacheSize).toBe(1);
  });
});

describe('ContextualPipeline', () => {
  it('processes document through full pipeline', async () => {
    const pipeline = new ContextualPipeline();
    const results = await pipeline.processDocument({
      content: 'Test document content...',
      source: 'test.pdf',
      userId: 'test-user',
      orgId: 'test-org'
    });
    
    expect(results).toHaveLength(1);
    expect(results[0]).toHaveProperty('embedding');
    expect(results[0]).toHaveProperty('contextualizedText');
  });
});
```

### Integration Tests

```javascript
// tests/integration/contextual.test.js
import { describe, it, expect } from 'node:test';

describe('Contextual Retrieval Integration', () => {
  it('end-to-end document processing', async () => {
    const response = await fetch('http://localhost:3000/api/contextual/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: fs.readFileSync('test/fixtures/report.md'),
        source: 'report.md',
        userId: 'test-user',
        orgId: 'test-org'
      })
    });

    const data = await response.json();
    
    expect(data.count).toBeGreaterThan(0);
    expect(data.chunks[0]).toHaveProperty('embedding');
    expect(data.chunks[0].embedding.length).toBe(768);
  });
});
```

---

## Dependencies

| Component | Dependency | Priority |
|-----------|-----------|----------|
| Groq API | `GROQ_API_KEY` | P0 |
| Embedding Service | `core/src/embedding/groq.js` | P0 |
| LLM Client | `core/src/config/groq.js` | P0 |
| Database | PostgreSQL + AGE | P1 |
| Caching | Redis (optional) | P2 |

---

## Estimated Effort

| Task | Hours | Days |
|------|-------|------|
| Groq LLM Client Integration | 8 | 1 |
| Context Injection Pipeline | 12 | 1.5 |
| API Endpoints | 6 | 0.5 |
| Testing | 8 | 1 |
| Documentation | 4 | 0.5 |
| **Total** | **38** | **4.5** |

---

## Success Criteria

- [ ] Contextualized chunks improve retrieval precision by ≥30%
- [ ] Average situationalizer latency <2 seconds
- [ ] Cost per contextualization < $0.001
- [ ] Cache hit rate ≥60% for repeated documents
- [ ] All tests passing (unit + integration)

---

## Rollout Plan

### Phase 1: Internal Testing (Week 1)
- Deploy to staging environment
- Test with sample documents
- Measure latency and cost

### Phase 2: Gradual Rollout (Week 2)
- Enable for 10% of users
- Monitor error rates and performance
- Adjust rate limits as needed

### Phase 3: Full Launch (Week 3)
- Enable for 100% of users
- Update documentation
- Monitor production metrics

---

## Monitoring & Observability

### Key Metrics

| Metric | Alert Threshold | Target |
|--------|----------------|--------|
| Contextualization Latency | >3s | <2s |
| API Error Rate | >1% | <0.1% |
| Cache Hit Rate | <40% | >60% |
| Cost per Context | >$0.002 | <$0.001 |

### Logging

```javascript
logger.info('contextual.process', {
  source: chunk.source,
  contextLength: chunk.context.length,
  embeddingDimension: chunk.embedding.length,
  latencyMs: performance.now() - start
});
```

---

## Future Enhancements

1. **Multi-language Support**: Detect language and use appropriate model
2. **Domain-Specific Templates**: Finance, code, legal, etc.
3. **Hybrid Approach**: Use rule-based for simple cases, LLM for complex
4. **Feedback Loop**: Learn from user corrections

---

## References

- Supermemory Contextual Retrieval: https://supermemory.ai/blog/contextual-retrieval/
- Groq Embeddings API: https://console.groq.com/docs/embeddings
- RAG Context Fragmentation: https://arxiv.org/abs/2402.14776
