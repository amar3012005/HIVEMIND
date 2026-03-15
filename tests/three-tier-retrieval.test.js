/**
 * Three-Tier Retrieval Architecture Tests
 *
 * @module tests/three-tier-retrieval
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ThreeTierRetrieval,
  quickSearch,
  panoramaSearch,
  insightForgeSearch,
  createThreeTierRetrieval
} from '../src/search/three-tier-retrieval.js';
import { PanoramaSearch, createPanoramaSearch } from '../src/search/panorama-search.js';
import { InsightForge } from '../src/search/insight-forge.js';
import hybridSearch from '../src/search/hybrid.js';

// Mock dependencies
const mockVectorStore = {
  search: async () => [],
  getClient: () => ({
    search: async () => []
  })
};

const mockGraphStore = {
  getRelatedMemories: async () => []
};

const mockLLMClient = {
  generate: async () => JSON.stringify({
    subQueries: [
      { query: 'test query 1', focus: 'aspect1', weight: 0.5 },
      { query: 'test query 2', focus: 'aspect2', weight: 0.5 }
    ],
    reasoning: 'Test reasoning'
  })
};

describe('ThreeTierRetrieval', () => {
  let retrieval;

  beforeEach(() => {
    retrieval = new ThreeTierRetrieval({
      vectorStore: mockVectorStore,
      graphStore: mockGraphStore,
      llmClient: mockLLMClient
    });
  });

  describe('Constructor', () => {
    it('should create instance with dependencies', () => {
      expect(retrieval).toBeInstanceOf(ThreeTierRetrieval);
      expect(retrieval.vectorStore).toBe(mockVectorStore);
      expect(retrieval.graphStore).toBe(mockGraphStore);
      expect(retrieval.llmClient).toBe(mockLLMClient);
    });

    it('should create instance without optional dependencies', () => {
      const minimal = new ThreeTierRetrieval({});
      expect(minimal).toBeInstanceOf(ThreeTierRetrieval);
      expect(minimal.llmClient).toBeNull();
    });
  });

  describe('Tier Selection', () => {
    it('should select quick tier for simple queries', () => {
      expect(retrieval.selectTier('hello world')).toBe('quick');
      expect(retrieval.selectTier('find my notes')).toBe('quick');
    });

    it('should select panorama tier for historical queries', () => {
      expect(retrieval.selectTier('show me history')).toBe('panorama');
      expect(retrieval.selectTier('past events')).toBe('panorama');
      expect(retrieval.selectTier('evolution over time')).toBe('panorama');
    });

    it('should select insight tier for analytical queries', () => {
      expect(retrieval.selectTier('analyze patterns')).toBe('insight');
      expect(retrieval.selectTier('why did this happen')).toBe('insight');
      expect(retrieval.selectTier('deep dive into')).toBe('insight');
    });

    it('should respect explicit options', () => {
      expect(retrieval.selectTier('test', { includeHistorical: true })).toBe('panorama');
      expect(retrieval.selectTier('test', { simulationRequirement: 'context' })).toBe('insight');
    });
  });

  describe('Configuration', () => {
    it('should have default configuration', () => {
      expect(retrieval.config.limits.quickSearch).toBe(10);
      expect(retrieval.config.limits.panoramaSearch).toBe(50);
      expect(retrieval.config.limits.insightForge).toBe(30);
    });

    it('should allow configuration overrides', () => {
      const custom = new ThreeTierRetrieval({
        config: { limits: { quickSearch: 20 } }
      });
      expect(custom.config.limits.quickSearch).toBe(20);
    });
  });
});

describe('PanoramaSearch', () => {
  let panorama;

  beforeEach(() => {
    panorama = new PanoramaSearch({
      vectorStore: mockVectorStore,
      graphStore: mockGraphStore
    });
  });

  describe('Temporal Categorization', () => {
    it('should categorize results by temporal status', () => {
      const results = [
        { id: '1', created_at: new Date().toISOString() },
        { id: '2', created_at: '2025-01-01T00:00:00Z' },
        { id: '3', temporal_status: 'expired', created_at: '2024-01-01T00:00:00Z' }
      ];

      const categorized = panorama.categorizeByTemporalStatus(results);

      expect(categorized.active).toBeDefined();
      expect(categorized.expired).toBeDefined();
      expect(categorized.historical).toBeDefined();
      expect(categorized.archived).toBeDefined();
    });

    it('should determine temporal status from dates', () => {
      const now = new Date();
      const recent = { created_at: now.toISOString() };
      const old = { created_at: '2020-01-01T00:00:00Z' };

      expect(panorama.determineTemporalStatus(recent, now)).toBe('active');
      expect(panorama.determineTemporalStatus(old, now)).toBe('archived');
    });
  });

  describe('Timeline Building', () => {
    it('should build timeline from results', () => {
      const results = [
        { id: '1', document_date: '2026-03-15T10:00:00Z' },
        { id: '2', document_date: '2026-03-15T14:00:00Z' },
        { id: '3', document_date: '2026-03-10T10:00:00Z' }
      ];

      const timeline = panorama.buildTimeline(results);

      expect(timeline.byDate).toBeDefined();
      expect(timeline.byMonth).toBeDefined();
      expect(timeline.byYear).toBeDefined();
      expect(timeline.chronological).toHaveLength(3);
      expect(timeline.summary.totalEvents).toBe(3);
    });
  });

  describe('Statistics', () => {
    it('should calculate temporal statistics', () => {
      const results = [
        { id: '1', score: 0.9, created_at: new Date().toISOString() },
        { id: '2', score: 0.7, created_at: new Date().toISOString() },
        { id: '3', score: 0.5, created_at: '2020-01-01T00:00:00Z' }
      ];

      const stats = panorama.getTemporalSummary(results);

      expect(stats.total).toBe(3);
      expect(stats.active).toBeGreaterThan(0);
      expect(stats.percentages).toBeDefined();
    });
  });
});

describe('InsightForge', () => {
  let insightForge;

  beforeEach(() => {
    insightForge = new InsightForge({
      vectorStore: mockVectorStore,
      graphStore: mockGraphStore,
      llmClient: mockLLMClient
    });
  });

  describe('Sub-Query Generation', () => {
    it('should generate sub-queries from LLM', async () => {
      const subQueries = await insightForge.generateSubQueries('test query', {});

      expect(subQueries).toHaveLength(2);
      expect(subQueries[0]).toHaveProperty('id');
      expect(subQueries[0]).toHaveProperty('query');
      expect(subQueries[0]).toHaveProperty('focus');
      expect(subQueries[0]).toHaveProperty('weight');
    });

    it('should normalize weights to sum to 1.0', async () => {
      const subQueries = await insightForge.generateSubQueries('test', {});
      const totalWeight = subQueries.reduce((sum, sq) => sum + sq.weight, 0);

      expect(totalWeight).toBeCloseTo(1.0, 5);
    });

    it('should generate fallback sub-queries on LLM failure', async () => {
      const failingLLM = { generate: async () => { throw new Error('LLM error'); } };
      const forge = new InsightForge({ llmClient: failingLLM });

      const subQueries = await forge.generateSubQueries('test query', { limit: 3 });

      expect(subQueries.length).toBeGreaterThan(0);
      expect(subQueries[0].focus).toBe('direct');
    });
  });

  describe('Result Aggregation', () => {
    it('should aggregate results from multiple sub-queries', () => {
      const subQueryResults = [
        {
          subQuery: { id: 'sq-1', weight: 0.5 },
          results: [
            { id: '1', score: 0.8 },
            { id: '2', score: 0.7 }
          ]
        },
        {
          subQuery: { id: 'sq-2', weight: 0.5 },
          results: [
            { id: '1', score: 0.9 },
            { id: '3', score: 0.6 }
          ]
        }
      ];

      const aggregated = insightForge.aggregateResults(subQueryResults);

      expect(aggregated).toHaveLength(3);
      expect(aggregated[0].matchCount).toBeGreaterThanOrEqual(1);
    });

    it('should boost scores for multi-match results', () => {
      const subQueryResults = [
        {
          subQuery: { id: 'sq-1', weight: 0.5 },
          results: [{ id: '1', score: 0.8 }]
        },
        {
          subQuery: { id: 'sq-2', weight: 0.5 },
          results: [{ id: '1', score: 0.9 }]
        }
      ];

      const aggregated = insightForge.aggregateResults(subQueryResults);
      const result = aggregated.find(r => r.id === '1');

      expect(result.matchCount).toBe(2);
      expect(result.score).toBeGreaterThan(result.originalScore);
    });
  });

  describe('Entity Extraction', () => {
    it('should extract entities from results', async () => {
      const results = [
        { content: 'John Smith works at Acme Corp' },
        { content: 'Acme Corp is based in New York' }
      ];

      const entities = await insightForge.extractEntities(results, 'test');

      expect(Array.isArray(entities)).toBe(true);
    });

    it('should use fallback extraction on LLM failure', async () => {
      const failingLLM = { generate: async () => { throw new Error('LLM error'); } };
      const forge = new InsightForge({ llmClient: failingLLM });

      const results = [
        { content: 'John Smith and Jane Doe met at Google' }
      ];

      const entities = await forge.extractEntities(results, 'test');

      expect(Array.isArray(entities)).toBe(true);
    });
  });

  describe('JSON Parsing', () => {
    it('should parse JSON from LLM response', () => {
      const response = '{"key": "value"}';
      const parsed = insightForge.parseLLMJson(response);

      expect(parsed).toEqual({ key: 'value' });
    });

    it('should extract JSON from markdown code blocks', () => {
      const response = '```json\n{"key": "value"}\n```';
      const parsed = insightForge.parseLLMJson(response);

      expect(parsed).toEqual({ key: 'value' });
    });

    it('should return empty object on parse failure', () => {
      const response = 'not valid json';
      const parsed = insightForge.parseLLMJson(response);

      expect(parsed).toEqual({});
    });
  });
});

describe('Hybrid Search Integration', () => {
  describe('Temporal Filters', () => {
    it('should include temporal configuration', () => {
      expect(hybridSearch.CONFIG.temporal).toBeDefined();
      expect(hybridSearch.CONFIG.temporal.defaultIncludeExpired).toBe(false);
      expect(hybridSearch.CONFIG.temporal.defaultIncludeHistorical).toBe(false);
    });

    it('should export buildQdrantFilter', () => {
      expect(hybridSearch.buildQdrantFilter).toBeDefined();
    });
  });
});

describe('Convenience Functions', () => {
  it('should create ThreeTierRetrieval instance', () => {
    const instance = createThreeTierRetrieval({
      vectorStore: mockVectorStore
    });
    expect(instance).toBeInstanceOf(ThreeTierRetrieval);
  });

  it('should create PanoramaSearch instance', () => {
    const instance = createPanoramaSearch({
      vectorStore: mockVectorStore
    });
    expect(instance).toBeInstanceOf(PanoramaSearch);
  });
});

// Integration tests (require actual services)
describe.skip('Integration Tests', () => {
  describe('QuickSearch', () => {
    it('should perform quick search', async () => {
      const result = await quickSearch('test query', {
        userId: 'test-user',
        limit: 5
      });

      expect(result.tier).toBe('quick');
      expect(result.results).toBeDefined();
      expect(result.metadata).toBeDefined();
    });
  });

  describe('PanoramaSearch', () => {
    it('should perform panorama search', async () => {
      const result = await panoramaSearch('test query', {
        userId: 'test-user',
        includeExpired: true
      });

      expect(result.tier).toBe('panorama');
      expect(result.categories).toBeDefined();
      expect(result.timeline).toBeDefined();
    });
  });

  describe('InsightForge', () => {
    it('should perform insight analysis', async () => {
      const result = await insightForgeSearch('analyze test', {
        userId: 'test-user',
        subQueryLimit: 3
      });

      expect(result.tier).toBe('insight');
      expect(result.subQueries).toBeDefined();
      expect(result.entityInsights).toBeDefined();
    });
  });
});
