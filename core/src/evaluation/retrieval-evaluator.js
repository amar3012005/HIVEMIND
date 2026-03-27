/**
 * Retrieval Quality Evaluation Engine
 *
 * Implements comprehensive evaluation metrics for HIVE-MIND retrieval system:
 * - Precision@K: Percentage of relevant results in top K
 * - Recall@K: Percentage of all relevant memories found in top K
 * - F1 Score: Harmonic mean of precision and recall
 * - NDCG@K: Normalized Discounted Cumulative Gain for ranking quality
 * - MRR: Mean Reciprocal Rank of first relevant result
 * - Latency metrics: P99 response times
 *
 * @module evaluation/retrieval-evaluator
 * @requires search/three-tier-retrieval
 * @requires search/hybrid
 */

import crypto from 'node:crypto';
import { createThreeTierRetrieval } from '../search/three-tier-retrieval.js';
import hybridSearch from '../search/hybrid.js';
import { getQdrantClient } from '../vector/qdrant-client.js';
import { getPrismaClient } from '../db/prisma.js';
import { PrismaGraphStore } from '../memory/prisma-graph-store.js';
import { recallPersistedMemories } from '../memory/persisted-retrieval.js';

// ==========================================
// Configuration
// ==========================================

const CONFIG = {
  // Default evaluation parameters
  defaults: {
    kValues: [5, 10, 20],
    maxLatencyMs: 300,
    warmupQueries: 3
  },

  // Metric weights for composite scoring
  weights: {
    precision: 0.25,
    recall: 0.25,
    ndcg: 0.25,
    mrr: 0.15,
    latency: 0.10
  },

  // Search method configurations
  searchMethods: {
    quick: { tier: 'quick', description: 'Fast semantic search' },
    panorama: { tier: 'panorama', description: 'Historical search' },
    insight: { tier: 'insight', description: 'LLM-powered analysis' },
    hybrid: { tier: 'hybrid', description: 'Combined vector + keyword + graph' },
    recall: { tier: 'recall', description: 'Full recall pipeline' }
  },

  // Quality thresholds
  thresholds: {
    precisionAt5: 0.80,
    recallAt10: 0.70,
    f1Score: 0.75,
    ndcgAt10: 0.75,
    mrr: 0.60,
    latencyP99: 300
  }
};

// ==========================================
// Logger
// ==========================================

const logger = {
  info: (msg, ctx) => console.log(`[EVALUATION INFO] ${msg}`, ctx || {}),
  warn: (msg, ctx) => console.warn(`[EVALUATION WARN] ${msg}`, ctx || {}),
  error: (msg, ctx) => console.error(`[EVALUATION ERROR] ${msg}`, ctx || {}),
  debug: (msg, ctx) => console.debug(`[EVALUATION DEBUG] ${msg}`, ctx || {})
};

// ==========================================
// RetrievalEvaluator Class
// ==========================================

/**
 * Retrieval Quality Evaluator
 *
 * Evaluates retrieval performance using standard IR metrics.
 * Supports multiple search methods and comprehensive reporting.
 */
export class RetrievalEvaluator {
  /**
   * Create a RetrievalEvaluator instance
   *
   * @param {Object} options - Configuration options
   * @param {Object} options.vectorStore - Vector store instance (Qdrant)
   * @param {Object} options.graphStore - Graph store instance
   * @param {Object} options.llmClient - LLM client for InsightForge
   * @param {Object} options.config - Optional configuration overrides
   */
  constructor(options = {}) {
    this.vectorStore = options.vectorStore || getQdrantClient();
    this.graphStore = options.graphStore;
    this.llmClient = options.llmClient;
    this.config = { ...CONFIG, ...(options.config || {}) };

    // Initialize Three-Tier Retrieval
    this.threeTierRetrieval = createThreeTierRetrieval({
      vectorStore: this.vectorStore,
      graphStore: this.graphStore,
      llmClient: this.llmClient,
      config: this.config
    });

    // Results storage
    this.evaluationHistory = [];

    logger.info('RetrievalEvaluator initialized', {
      hasVectorStore: !!this.vectorStore,
      hasGraphStore: !!this.graphStore,
      hasLLMClient: !!this.llmClient
    });
  }

  // ==========================================
  // Core Evaluation Methods
  // ==========================================

  /**
   * Evaluate a single query against ground truth
   *
   * @param {string} query - Search query
   * @param {string[]} relevantIds - Array of relevant memory IDs (ground truth)
   * @param {Object} options - Evaluation options
   * @param {string} options.userId - User ID for multi-tenant isolation
   * @param {string} options.orgId - Organization ID
   * @param {string} options.method - Search method ('quick', 'panorama', 'insight', 'hybrid', 'recall')
   * @param {number} options.limit - Maximum results to retrieve
   * @returns {Promise<Object>} Evaluation results for this query
   */
  async evaluateQuery(query, relevantIds, options = {}) {
    const {
      userId,
      orgId,
      method = 'hybrid',
      limit = 20,
      category = 'general'
    } = options;

    const startTime = Date.now();
    const requestId = crypto.randomUUID();

    logger.info('Starting query evaluation', {
      requestId,
      query,
      method,
      relevantCount: relevantIds.length
    });

    try {
      // Execute search based on method
      const searchResults = await this.executeSearch(query, {
        userId,
        orgId,
        method,
        limit
      });

      const latencyMs = Date.now() - startTime;

      // Extract result IDs and content for semantic scoring
      const resultIds = this.extractResultIds(searchResults, method);
      const resultContents = this.extractResultContents(searchResults, method);

      // Calculate UUID-based metrics
      const metrics = this.calculateMetrics(resultIds, relevantIds, latencyMs);

      // Calculate semantic P@5 (content relevance, not just UUID match)
      metrics.semanticPrecisionAt5 = this.computeSemanticPrecision(query, resultContents, 5);
      metrics.semanticGapAt5 = Math.max(0, metrics.semanticPrecisionAt5 - metrics.precisionAt5);

      const diagnostics = this.diagnoseBottlenecks(metrics, {
        query,
        category,
        method,
        relevantCount: relevantIds.length
      });

      // Determine if query passed thresholds
      const passed = this.checkThresholds(metrics);

      const evaluation = {
        requestId,
        query,
        category,
        method,
        latencyMs,
        relevantCount: relevantIds.length,
        retrievedCount: resultIds.length,
        metrics,
        diagnostics,
        passed,
        resultIds,
        relevantIds,
        timestamp: new Date().toISOString()
      };

      logger.info('Query evaluation completed', {
        requestId,
        latencyMs,
        precisionAt5: metrics.precisionAt5,
        recallAt10: metrics.recallAt10,
        passed
      });

      return evaluation;
    } catch (error) {
      logger.error('Query evaluation failed', {
        requestId,
        error: error.message,
        query
      });

      return {
        requestId,
        query,
        category,
        method,
        error: error.message,
        diagnostics: {
          primary: {
            type: 'execution_error',
            severity: 'high',
            reason: error.message
          },
          bottlenecks: [{
            type: 'execution_error',
            severity: 'high',
            reason: error.message
          }]
        },
        passed: false,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Execute search using specified method
   *
   * @private
   * @param {string} query - Search query
   * @param {Object} options - Search options
   * @returns {Promise<Object>} Search results
   */
  async executeSearch(query, options) {
    const { userId, orgId, method, limit } = options;

    switch (method) {
      case 'quick':
        return this.threeTierRetrieval.quickSearch(query, {
          userId,
          orgId,
          limit
        });

      case 'panorama':
        return this.threeTierRetrieval.panoramaSearch(query, {
          userId,
          orgId,
          limit
        });

      case 'insight':
        if (!this.llmClient) {
          throw new Error('LLM client required for InsightForge evaluation');
        }
        return this.threeTierRetrieval.insightForge(query, {
          userId,
          orgId,
          subQueryLimit: 3,
          resultsPerSubQuery: Math.ceil(limit / 3)
        });

      case 'hybrid':
        return hybridSearch.hybridSearch({
          query,
          userId,
          orgId,
          limit,
          includeExpired: false,
          includeHistorical: false
        });

      case 'recall':
        // Use persisted retrieval if available
        if (this.graphStore) {
          return recallPersistedMemories(this.graphStore, {
            query_context: query,
            user_id: userId,
            org_id: orgId,
            max_memories: limit
          });
        }
        throw new Error('Graph store required for recall evaluation');

      default:
        throw new Error(`Unknown search method: ${method}`);
    }
  }

  /**
   * Extract result IDs from search results
   *
   * @private
   * @param {Object} searchResults - Search results from any method
   * @param {string} method - Search method used
   * @returns {string[]} Array of memory IDs
   */
  extractResultIds(searchResults, method) {
    if (!searchResults) return [];

    // Handle different result formats
    if (searchResults.results) {
      // Three-tier and hybrid results
      return searchResults.results
        .map(r => r.id || r.memory?.id)
        .filter(Boolean);
    }

    if (Array.isArray(searchResults)) {
      // Direct array results (recall)
      return searchResults
        .map(r => r.id || r.memory?.id)
        .filter(Boolean);
    }

    if (searchResults.memories) {
      // Some results wrap in memories
      return searchResults.memories
        .map(m => m.id || m.memory?.id)
        .filter(Boolean);
    }

    return [];
  }

  /**
   * Extract content strings from search results for semantic scoring
   */
  extractResultContents(searchResults, method) {
    if (!searchResults) return [];
    const items = searchResults.results || searchResults.memories || (Array.isArray(searchResults) ? searchResults : []);
    return items.map(r => ({
      title: r.title || r.payload?.title || r.memory?.title || '',
      content: r.content || r.payload?.content || r.memory?.content || '',
      tags: r.tags || r.payload?.tags || r.memory?.tags || [],
    }));
  }

  /**
   * Compute semantic Precision@K using token overlap relevance
   *
   * Instead of checking UUID matches, grades each result by how well its
   * content/title/tags match the query terms. A result is "semantically relevant"
   * if it shares significant token overlap with the query.
   *
   * @param {string} query - The search query
   * @param {Array} resultContents - Array of {title, content, tags}
   * @param {number} k - Cutoff rank
   * @returns {number} Semantic Precision@K (0-1)
   */
  computeSemanticPrecision(query, resultContents, k) {
    if (!query || !resultContents || resultContents.length === 0) return 0;

    const topK = resultContents.slice(0, k);
    if (topK.length === 0) return 0;

    // Tokenize query (remove stopwords)
    const STOPWORDS = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our', 'out', 'has', 'have', 'been', 'were', 'they', 'their', 'what', 'when', 'where', 'who', 'will', 'with', 'this', 'that', 'from', 'about', 'tell', 'how', 'does', 'did', 'know']);
    const queryTokens = new Set(
      query.toLowerCase().split(/\W+/).filter(t => t.length > 2 && !STOPWORDS.has(t))
    );
    if (queryTokens.size === 0) return 0;

    let relevant = 0;
    for (const result of topK) {
      // Build result token set from title + content snippet + tags
      const resultText = `${result.title} ${result.content.slice(0, 500)} ${result.tags.join(' ')}`.toLowerCase();
      const resultTokens = new Set(resultText.split(/\W+/).filter(t => t.length > 2));

      // Count overlapping tokens
      let overlap = 0;
      for (const qt of queryTokens) {
        if (resultTokens.has(qt)) overlap++;
      }

      // Relevant if >= 40% of query tokens appear in result
      const overlapRatio = overlap / queryTokens.size;
      if (overlapRatio >= 0.4) relevant++;
    }

    return relevant / topK.length;
  }

  // ==========================================
  // Metric Calculation Methods
  // ==========================================

  /**
   * Calculate all metrics for a query evaluation
   *
   * @private
   * @param {string[]} resultIds - Retrieved memory IDs
   * @param {string[]} relevantIds - Ground truth relevant IDs
   * @param {number} latencyMs - Query latency in milliseconds
   * @returns {Object} Calculated metrics
   */
  calculateMetrics(resultIds, relevantIds, latencyMs) {
    const relevantSet = new Set(relevantIds);
    const rankSignals = this.calculateRankSignals(resultIds, relevantIds);

    return {
      precisionAt5: this.calculatePrecision(resultIds, relevantIds, 5),
      precisionAt10: this.calculatePrecision(resultIds, relevantIds, 10),
      precisionAt20: this.calculatePrecision(resultIds, relevantIds, 20),
      recallAt5: this.calculateRecall(resultIds, relevantIds, 5),
      recallAt10: this.calculateRecall(resultIds, relevantIds, 10),
      recallAt20: this.calculateRecall(resultIds, relevantIds, 20),
      f1At5: this.calculateF1(resultIds, relevantIds, 5),
      f1At10: this.calculateF1(resultIds, relevantIds, 10),
      f1At20: this.calculateF1(resultIds, relevantIds, 20),
      ndcgAt5: this.calculateNDCG(resultIds, relevantIds, 5),
      ndcgAt10: this.calculateNDCG(resultIds, relevantIds, 10),
      ndcgAt20: this.calculateNDCG(resultIds, relevantIds, 20),
      mrr: this.calculateMRR(resultIds, relevantIds),
      latencyMs,
      ...rankSignals,
      // Additional metrics
      truePositivesAt10: resultIds.slice(0, 10).filter(id => relevantSet.has(id)).length,
      falsePositivesAt10: resultIds.slice(0, 10).filter(id => !relevantSet.has(id)).length,
      falseNegativesAt10: relevantIds.filter(id => !resultIds.slice(0, 10).includes(id)).length
    };
  }

  /**
   * Calculate rank-based retrieval signals.
   *
   * @private
   * @param {string[]} resultIds - Retrieved memory IDs
   * @param {string[]} relevantIds - Ground truth relevant IDs
   * @returns {Object} Rank signals
   */
  calculateRankSignals(resultIds, relevantIds) {
    if (!resultIds.length || !relevantIds.length) {
      return {
        firstRelevantRank: null,
        relevantHitsAt1: 0,
        relevantHitsAt5: 0,
        relevantHitsAt10: 0,
        relevantHitsAt20: 0
      };
    }

    const relevantSet = new Set(relevantIds);
    const relevantRanks = [];

    for (let i = 0; i < resultIds.length; i++) {
      if (relevantSet.has(resultIds[i])) {
        relevantRanks.push(i + 1);
      }
    }

    const countAt = (limit) => relevantRanks.filter(rank => rank <= limit).length;

    return {
      firstRelevantRank: relevantRanks.length > 0 ? relevantRanks[0] : null,
      relevantHitsAt1: countAt(1),
      relevantHitsAt5: countAt(5),
      relevantHitsAt10: countAt(10),
      relevantHitsAt20: countAt(20)
    };
  }

  /**
   * Calculate Precision@K
   *
   * Precision = |Relevant ∩ Retrieved| / |Retrieved|
   *
   * @param {string[]} resultIds - Retrieved memory IDs
   * @param {string[]} relevantIds - Ground truth relevant IDs
   * @param {number} k - Cutoff rank
   * @returns {number} Precision@K (0-1)
   */
  calculatePrecision(resultIds, relevantIds, k) {
    if (k <= 0) return 0;

    const topK = resultIds.slice(0, k);
    if (topK.length === 0) return 0;

    const relevantSet = new Set(relevantIds);
    const relevantRetrieved = topK.filter(id => relevantSet.has(id)).length;

    return relevantRetrieved / topK.length;
  }

  /**
   * Calculate Recall@K
   *
   * Recall = |Relevant ∩ Retrieved| / |Relevant|
   *
   * @param {string[]} resultIds - Retrieved memory IDs
   * @param {string[]} relevantIds - Ground truth relevant IDs
   * @param {number} k - Cutoff rank
   * @returns {number} Recall@K (0-1)
   */
  calculateRecall(resultIds, relevantIds, k) {
    if (relevantIds.length === 0) return 0;

    const topK = resultIds.slice(0, k);
    const relevantSet = new Set(relevantIds);
    const relevantRetrieved = topK.filter(id => relevantSet.has(id)).length;

    return relevantRetrieved / relevantIds.length;
  }

  /**
   * Calculate F1 Score@K
   *
   * F1 = 2 * (Precision * Recall) / (Precision + Recall)
   *
   * @param {string[]} resultIds - Retrieved memory IDs
   * @param {string[]} relevantIds - Ground truth relevant IDs
   * @param {number} k - Cutoff rank
   * @returns {number} F1 Score@K (0-1)
   */
  calculateF1(resultIds, relevantIds, k) {
    const precision = this.calculatePrecision(resultIds, relevantIds, k);
    const recall = this.calculateRecall(resultIds, relevantIds, k);

    if (precision + recall === 0) return 0;

    return (2 * precision * recall) / (precision + recall);
  }

  /**
   * Calculate NDCG@K (Normalized Discounted Cumulative Gain)
   *
   * DCG = Σ (2^relevance - 1) / log2(i + 1)
   * IDCG = Ideal DCG (perfect ranking)
   * NDCG = DCG / IDCG
   *
   * @param {string[]} resultIds - Retrieved memory IDs
   * @param {string[]} relevantIds - Ground truth relevant IDs
   * @param {number} k - Cutoff rank
   * @returns {number} NDCG@K (0-1)
   */
  calculateNDCG(resultIds, relevantIds, k) {
    if (relevantIds.length === 0 || resultIds.length === 0) return 0;

    const relevantSet = new Set(relevantIds);
    const topK = resultIds.slice(0, k);

    // Calculate DCG
    let dcg = 0;
    for (let i = 0; i < topK.length; i++) {
      const relevance = relevantSet.has(topK[i]) ? 1 : 0;
      // Position is 1-indexed, so i + 1
      const position = i + 1;
      // log2(position + 1) because position 1 should have denominator log2(2) = 1
      dcg += relevance / Math.log2(position + 1);
    }

    // Calculate IDCG (ideal DCG with all relevant items at top)
    let idcg = 0;
    const numRelevant = Math.min(relevantIds.length, k);
    for (let i = 0; i < numRelevant; i++) {
      const position = i + 1;
      idcg += 1 / Math.log2(position + 1);
    }

    if (idcg === 0) return 0;

    return dcg / idcg;
  }

  /**
   * Calculate MRR (Mean Reciprocal Rank)
   *
   * MRR = 1 / rank_of_first_relevant
   * If no relevant results, MRR = 0
   *
   * @param {string[]} resultIds - Retrieved memory IDs
   * @param {string[]} relevantIds - Ground truth relevant IDs
   * @returns {number} MRR (0-1)
   */
  calculateMRR(resultIds, relevantIds) {
    if (relevantIds.length === 0 || resultIds.length === 0) return 0;

    const relevantSet = new Set(relevantIds);

    // Find first relevant result
    for (let i = 0; i < resultIds.length; i++) {
      if (relevantSet.has(resultIds[i])) {
        return 1 / (i + 1); // Position is 1-indexed
      }
    }

    return 0; // No relevant results found
  }

  /**
   * Diagnose the likely retrieval bottleneck for a query.
   *
   * @private
   * @param {Object} metrics - Calculated metrics
   * @param {Object} context - Evaluation context
   * @returns {Object} Bottleneck diagnostics
   */
  diagnoseBottlenecks(metrics, context = {}) {
    const { thresholds } = this.config;
    const bottlenecks = [];

    const add = (type, severity, reason, evidence = {}) => {
      bottlenecks.push({ type, severity, reason, evidence });
    };

    if (metrics.latencyMs > thresholds.latencyP99) {
      add('latency', 'high', 'Query exceeded the latency budget', {
        latencyMs: metrics.latencyMs,
        thresholdMs: thresholds.latencyP99
      });
    }

    if (metrics.semanticGapAt5 >= 0.25 && metrics.semanticPrecisionAt5 >= 0.5) {
      add('label_alignment', 'medium', 'Semantic matches are stronger than exact-label matches', {
        precisionAt5: metrics.precisionAt5,
        semanticPrecisionAt5: metrics.semanticPrecisionAt5,
        gapAt5: metrics.semanticGapAt5
      });
    }

    if (metrics.recallAt10 === 0) {
      add('coverage', 'high', 'No relevant memory appeared in the top 10', {
        firstRelevantRank: metrics.firstRelevantRank,
        relevantCount: context.relevantCount || 0
      });
    } else if (metrics.firstRelevantRank !== null && metrics.firstRelevantRank > 10) {
      add('ranking', 'medium', 'Relevant memory was found but ranked too low', {
        firstRelevantRank: metrics.firstRelevantRank,
        recallAt10: metrics.recallAt10,
        mrr: metrics.mrr
      });
    }

    if (metrics.precisionAt5 < thresholds.precisionAt5 && metrics.recallAt10 >= thresholds.recallAt10) {
      add('noise', 'medium', 'Top-k retrieval is noisy despite reasonable recall', {
        precisionAt5: metrics.precisionAt5,
        recallAt10: metrics.recallAt10
      });
    }

    if (metrics.ndcgAt10 < thresholds.ndcgAt10 && metrics.recallAt10 > 0) {
      add('ordering', 'medium', 'Relevant memories are being surfaced, but the ordering is weak', {
        ndcgAt10: metrics.ndcgAt10,
        recallAt10: metrics.recallAt10
      });
    }

    if (bottlenecks.length === 0) {
      add('healthy', 'low', 'Query met all benchmark thresholds', {
        precisionAt5: metrics.precisionAt5,
        recallAt10: metrics.recallAt10,
        mrr: metrics.mrr
      });
    }

    const severityRank = { high: 0, medium: 1, low: 2 };
    bottlenecks.sort((a, b) => {
      const severityDelta = severityRank[a.severity] - severityRank[b.severity];
      if (severityDelta !== 0) return severityDelta;
      return a.type.localeCompare(b.type);
    });

    return {
      primary: bottlenecks[0],
      bottlenecks
    };
  }

  // ==========================================
  // Threshold Checking
  // ==========================================

  /**
   * Check if metrics meet quality thresholds
   *
   * @private
   * @param {Object} metrics - Calculated metrics
   * @returns {Object} Threshold check results
   */
  checkThresholds(metrics) {
    const { thresholds } = this.config;

    const checks = {
      precisionAt5: metrics.precisionAt5 >= thresholds.precisionAt5,
      recallAt10: metrics.recallAt10 >= thresholds.recallAt10,
      f1At10: metrics.f1At10 >= thresholds.f1Score,
      ndcgAt10: metrics.ndcgAt10 >= thresholds.ndcgAt10,
      mrr: metrics.mrr >= thresholds.mrr,
      latency: metrics.latencyMs <= thresholds.latencyP99
    };

    const allPassed = Object.values(checks).every(v => v);

    return {
      allPassed,
      checks,
      thresholds
    };
  }

  // ==========================================
  // Batch Evaluation
  // ==========================================

  /**
   * Evaluate multiple queries in batch
   *
   * @param {Array} testQueries - Array of test query objects
   * @param {Object} options - Evaluation options
   * @returns {Promise<Object>} Batch evaluation results
   */
  async evaluateBatch(testQueries, options = {}) {
    const {
      userId,
      orgId,
      methods = ['hybrid'],
      warmup = true,
      dataset = 'default'
    } = options;

    const evaluationId = crypto.randomUUID();
    const startTime = Date.now();

    logger.info('Starting batch evaluation', {
      evaluationId,
      queryCount: testQueries.length,
      methods
    });

    // Warmup phase
    if (warmup && testQueries.length > 0) {
      logger.info('Running warmup queries...');
      for (let i = 0; i < Math.min(this.config.defaults.warmupQueries, testQueries.length); i++) {
        try {
          await this.executeSearch(testQueries[i].query, {
            userId,
            orgId,
            method: methods[0],
            limit: 10
          });
        } catch (error) {
          logger.warn('Warmup query failed', { error: error.message });
        }
      }
    }

    // Evaluate each query with each method
    const results = [];
    const failedQueries = [];

    for (const testQuery of testQueries) {
      for (const method of methods) {
        try {
          const evaluation = await this.evaluateQuery(
            testQuery.query,
            testQuery.relevantMemories,
            {
              userId,
              orgId,
              method,
              category: testQuery.category,
              limit: 20
            }
          );

          results.push(evaluation);

          if (!evaluation.passed?.allPassed) {
            failedQueries.push({
              query: testQuery.query,
              method,
              reason: evaluation.error || evaluation.diagnostics?.primary?.type || 'Thresholds not met',
              bottleneck: evaluation.diagnostics?.primary?.type || null
            });
          }
        } catch (error) {
          logger.error('Evaluation failed for query', {
            query: testQuery.query,
            method,
            error: error.message
          });

          failedQueries.push({
            query: testQuery.query,
            method,
            reason: error.message
          });
        }
      }
    }

    const duration = Date.now() - startTime;

    // Aggregate results
    const report = this.generateReport(results, {
      evaluationId,
      duration,
      testQueries,
      dataset,
      methods,
      failedQueries
    });

    // Store in history
    this.evaluationHistory.push(report);

    logger.info('Batch evaluation completed', {
      evaluationId,
      duration,
      totalQueries: results.length,
      passedQueries: results.filter(r => r.passed?.allPassed).length
    });

    return report;
  }

  // ==========================================
  // Report Generation
  // ==========================================

  /**
   * Generate comprehensive evaluation report
   *
   * @param {Array} results - Individual query results
   * @param {Object} metadata - Evaluation metadata
   * @returns {Object} Comprehensive report
   */
  generateReport(results, metadata) {
    const {
      evaluationId,
      duration,
      methods,
      failedQueries,
      dataset = 'default',
      testQueries = []
    } = metadata;

    // Filter out failed evaluations
    const successfulResults = results.filter(r => !r.error && r.metrics);

    if (successfulResults.length === 0) {
      return {
        schemaVersion: '2026-03-19',
        kind: 'hivemind.retrieval-evaluation-report',
        timestamp: new Date().toISOString(),
        evaluationId,
        dataset,
        duration,
        methods,
        summary: {
          totalQueries: results.length,
          successfulQueries: 0,
          failedQueries: failedQueries.length,
          qualityScore: 0,
          precisionAt5: { mean: 0, min: 0, max: 0, median: 0 },
          semanticPrecisionAt5: { mean: 0, min: 0, max: 0, median: 0 },
          semanticGapAt5: { mean: 0, min: 0, max: 0, median: 0 },
          recallAt10: { mean: 0, min: 0, max: 0, median: 0 },
          f1At10: { mean: 0, min: 0, max: 0, median: 0 },
          ndcgAt10: { mean: 0, min: 0, max: 0, median: 0 },
          mrr: { mean: 0, min: 0, max: 0, median: 0 },
          latencyP99: 0,
          latencyP95: 0,
          latencyP50: 0
        },
        latency_benchmark: {
          p50_ms: 0,
          p95_ms: 0,
          p99_ms: 0,
          target_p99_ms: this.config.thresholds.latencyP99 || 300,
          pass: false
        },
        relevance_benchmark: {
          precision_at_5: 0,
          semantic_precision_at_5: 0,
          semantic_gap_at_5: 0,
          recall_at_10: 0,
          ndcg_at_10: 0,
          mrr: 0,
          targets: {
            precision_at_5: 0.5,
            semantic_precision_at_5: 0.5,
            recall_at_10: 0.4,
            ndcg_at_10: 0.4,
            mrr: 0.3
          },
          pass: false
        },
        byCategory: {},
        bySearchMethod: {},
        queryMetadata: testQueries.map(query => ({
          query: query.query,
          category: query.category || 'general',
          difficulty: query.difficulty || 'unknown',
          relevantCount: query.relevantMemories?.length || 0,
          tags: query.tags || []
        })),
        error: 'No successful evaluations',
        failedQueries,
        bottleneckSummary: this.aggregateBottlenecks(successfulResults),
        targets: this.config.thresholds,
        rawResults: []
      };
    }

    // Calculate summary statistics
    const summary = this.calculateSummary(successfulResults);

    // Calculate by category
    const byCategory = this.aggregateByCategory(successfulResults);

    // Calculate by search method
    const bySearchMethod = this.aggregateByMethod(successfulResults);

    // Diagnose bottlenecks across the full batch
    const bottleneckSummary = this.aggregateBottlenecks(successfulResults);

    // Calculate latency percentiles
    const latencies = successfulResults.map(r => r.latencyMs).sort((a, b) => a - b);
    const latencyP99 = this.calculatePercentile(latencies, 0.99);
    const latencyP95 = this.calculatePercentile(latencies, 0.95);
    const latencyP50 = this.calculatePercentile(latencies, 0.50);

    // Overall quality score
    const qualityScore = this.calculateQualityScore(summary, latencyP99);

    // Separate latency vs relevance benchmarks
    const latencyBenchmark = {
      p50_ms: latencyP50,
      p95_ms: latencyP95,
      p99_ms: latencyP99,
      target_p99_ms: this.config.thresholds.latencyP99 || 300,
      pass: latencyP99 <= (this.config.thresholds.latencyP99 || 300),
    };

    const relevanceBenchmark = {
      precision_at_5: summary.precisionAt5?.mean || 0,
      semantic_precision_at_5: summary.semanticPrecisionAt5?.mean || 0,
      semantic_gap_at_5: summary.semanticGapAt5?.mean || 0,
      recall_at_10: summary.recallAt10?.mean || 0,
      ndcg_at_10: summary.ndcgAt10?.mean || 0,
      mrr: summary.mrr?.mean || 0,
      targets: {
        precision_at_5: 0.5,
        semantic_precision_at_5: 0.5,
        recall_at_10: 0.4,
        ndcg_at_10: 0.4,
        mrr: 0.3,
      },
      pass: (summary.precisionAt5?.mean || 0) >= 0.5
        && (summary.recallAt10?.mean || 0) >= 0.4,
    };

    return {
      schemaVersion: '2026-03-19',
      kind: 'hivemind.retrieval-evaluation-report',
      timestamp: new Date().toISOString(),
      evaluationId,
      dataset,
      duration,
      summary: {
        ...summary,
        latencyP99,
        latencyP95,
        latencyP50,
        qualityScore,
        totalQueries: results.length,
        successfulQueries: successfulResults.length,
        failedQueries: failedQueries.length
      },
      latency_benchmark: latencyBenchmark,
      relevance_benchmark: relevanceBenchmark,
      byCategory,
      bySearchMethod,
      queryMetadata: testQueries.map(query => ({
        query: query.query,
        category: query.category || 'general',
        difficulty: query.difficulty || 'unknown',
        relevantCount: query.relevantMemories?.length || 0,
        tags: query.tags || []
      })),
      failedQueries,
      bottleneckSummary,
      targets: this.config.thresholds,
      methods,
      rawResults: successfulResults
    };
  }

  /**
   * Calculate summary statistics across all results
   *
   * @private
   * @param {Array} results - Successful evaluation results
   * @returns {Object} Summary statistics
   */
  calculateSummary(results) {
    const metrics = ['precisionAt5', 'precisionAt10', 'recallAt10', 'f1At10', 'ndcgAt10', 'mrr', 'semanticPrecisionAt5', 'semanticGapAt5', 'firstRelevantRank'];
    const summary = {};

    for (const metric of metrics) {
      const values = results
        .map(r => r.metrics[metric])
        .filter(v => typeof v === 'number' && Number.isFinite(v));

      if (values.length === 0) {
        summary[metric] = {
          mean: 0,
          min: 0,
          max: 0,
          median: 0
        };
        continue;
      }

      summary[metric] = {
        mean: values.reduce((a, b) => a + b, 0) / values.length,
        min: Math.min(...values),
        max: Math.max(...values),
        median: this.calculateMedian(values)
      };
    }

    return summary;
  }

  /**
   * Aggregate results by category
   *
   * @private
   * @param {Array} results - Evaluation results
   * @returns {Object} Aggregated by category
   */
  aggregateByCategory(results) {
    const categories = {};

    for (const result of results) {
      const category = result.category || 'general';
      if (!categories[category]) {
        categories[category] = [];
      }
      categories[category].push(result);
    }

    const aggregated = {};
    for (const [category, catResults] of Object.entries(categories)) {
      const latencies = catResults.map(result => result.latencyMs).sort((a, b) => a - b);
      aggregated[category] = {
        count: catResults.length,
        metrics: this.calculateSummary(catResults),
        latencyP95: this.calculatePercentile(latencies, 0.95)
      };
    }

    return aggregated;
  }

  /**
   * Aggregate results by search method
   *
   * @private
   * @param {Array} results - Evaluation results
   * @returns {Object} Aggregated by method
   */
  aggregateByMethod(results) {
    const methods = {};

    for (const result of results) {
      const method = result.method || 'unknown';
      if (!methods[method]) {
        methods[method] = [];
      }
      methods[method].push(result);
    }

    const aggregated = {};
    for (const [method, methodResults] of Object.entries(methods)) {
      const latencies = methodResults.map(r => r.latencyMs).sort((a, b) => a - b);
      aggregated[method] = {
        count: methodResults.length,
        metrics: this.calculateSummary(methodResults),
        latencyP99: this.calculatePercentile(latencies, 0.99),
        latencyP95: this.calculatePercentile(latencies, 0.95),
        latencyP50: this.calculatePercentile(latencies, 0.50)
      };
    }

    return aggregated;
  }

  /**
   * Aggregate bottlenecks across a batch.
   *
   * @private
   * @param {Array} results - Successful evaluation results
   * @returns {Object} Bottleneck summary
   */
  aggregateBottlenecks(results) {
    const counts = {};
    const examples = {};
    let healthyCount = 0;

    for (const result of results) {
      const primary = result.diagnostics?.primary?.type || 'unknown';
      if (primary === 'healthy') healthyCount++;

      const bottlenecks = result.diagnostics?.bottlenecks || [];
      if (bottlenecks.length === 0) {
        counts.unknown = (counts.unknown || 0) + 1;
        if (!examples.unknown) examples.unknown = [];
        if (examples.unknown.length < 3) examples.unknown.push(result.query);
        continue;
      }

      for (const bottleneck of bottlenecks) {
        counts[bottleneck.type] = (counts[bottleneck.type] || 0) + 1;
        if (!examples[bottleneck.type]) examples[bottleneck.type] = [];
        if (examples[bottleneck.type].length < 3) {
          examples[bottleneck.type].push(result.query);
        }
      }
    }

    const total = results.length || 1;
    const top = Object.entries(counts)
      .map(([type, count]) => ({
        type,
        count,
        share: Math.round((count / total) * 1000) / 10,
        examples: examples[type] || []
      }))
      .sort((a, b) => {
        if (a.type === 'healthy' && b.type !== 'healthy') return 1;
        if (b.type === 'healthy' && a.type !== 'healthy') return -1;
        if (b.count !== a.count) return b.count - a.count;
        return a.type.localeCompare(b.type);
      });

    return {
      totalQueries: results.length,
      healthyQueries: healthyCount,
      counts,
      top,
      examples
    };
  }

  /**
   * Calculate quality score based on metrics
   *
   * @private
   * @param {Object} summary - Summary statistics
   * @param {number} latencyP99 - P99 latency
   * @returns {number} Quality score (0-100)
   */
  calculateQualityScore(summary, latencyP99) {
    const { weights, thresholds } = this.config;

    // Normalize each metric against threshold (1.0 = meets threshold)
    // Use semantic P@5 if available (fairer than UUID-only matching), fallback to UUID-based
    const effectivePrecision = summary.semanticPrecisionAt5?.mean || summary.precisionAt5.mean;
    const precisionScore = Math.min(effectivePrecision / thresholds.precisionAt5, 1);
    const recallScore = Math.min(summary.recallAt10.mean / thresholds.recallAt10, 1);
    const ndcgScore = Math.min(summary.ndcgAt10.mean / thresholds.ndcgAt10, 1);
    const mrrScore = Math.min(summary.mrr.mean / thresholds.mrr, 1);

    // Latency score (inverse - lower is better)
    const latencyScore = latencyP99 <= thresholds.latencyP99 ? 1 : thresholds.latencyP99 / latencyP99;

    // Weighted average
    const score = (
      precisionScore * weights.precision +
      recallScore * weights.recall +
      ndcgScore * weights.ndcg +
      mrrScore * weights.mrr +
      latencyScore * weights.latency
    ) * 100;

    return Math.round(score);
  }

  // ==========================================
  // Utility Methods
  // ==========================================

  /**
   * Calculate median of values
   *
   * @private
   * @param {number[]} values - Array of values
   * @returns {number} Median value
   */
  calculateMedian(values) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /**
   * Calculate percentile of values
   *
   * @private
   * @param {number[]} sortedValues - Sorted array of values
   * @param {number} percentile - Percentile (0-1)
   * @returns {number} Percentile value
   */
  calculatePercentile(sortedValues, percentile) {
    if (sortedValues.length === 0) return 0;
    const index = Math.ceil(sortedValues.length * percentile) - 1;
    return sortedValues[Math.max(0, index)];
  }

  /**
   * Get evaluation history
   *
   * @returns {Array} Previous evaluation reports
   */
  getEvaluationHistory() {
    return this.evaluationHistory;
  }

  /**
   * Get latest evaluation report
   *
   * @returns {Object|null} Latest report or null
   */
  getLatestReport() {
    return this.evaluationHistory.length > 0
      ? this.evaluationHistory[this.evaluationHistory.length - 1]
      : null;
  }

  /**
   * Compare two evaluation reports
   *
   * @param {Object} baseline - Baseline report
   * @param {Object} current - Current report
   * @returns {Object} Comparison results
   */
  compareReports(baseline, current) {
    const comparison = {
      timestamp: new Date().toISOString(),
      improvements: {},
      regressions: {},
      unchanged: {}
    };

    const metrics = ['precisionAt5', 'semanticPrecisionAt5', 'recallAt10', 'f1At10', 'ndcgAt10', 'mrr'];

    for (const metric of metrics) {
      const baselineValue = baseline.summary[metric]?.mean || 0;
      const currentValue = current.summary[metric]?.mean || 0;
      const delta = currentValue - baselineValue;
      const deltaPercent = baselineValue > 0 ? (delta / baselineValue) * 100 : 0;

      const change = {
        baseline: baselineValue,
        current: currentValue,
        delta,
        deltaPercent: Math.round(deltaPercent * 100) / 100
      };

      if (Math.abs(deltaPercent) < 1) {
        comparison.unchanged[metric] = change;
      } else if (delta > 0) {
        comparison.improvements[metric] = change;
      } else {
        comparison.regressions[metric] = change;
      }
    }

    // Overall assessment
    const improvementCount = Object.keys(comparison.improvements).length;
    const regressionCount = Object.keys(comparison.regressions).length;

    if (improvementCount > regressionCount) {
      comparison.assessment = 'improved';
    } else if (regressionCount > improvementCount) {
      comparison.assessment = 'regressed';
    } else {
      comparison.assessment = 'stable';
    }

    comparison.overall = {
      assessment: comparison.assessment,
      qualityScore: {
        baseline: baseline.summary?.qualityScore || 0,
        current: current.summary?.qualityScore || 0,
        delta: (current.summary?.qualityScore || 0) - (baseline.summary?.qualityScore || 0)
      },
      latencyP99: {
        baseline: baseline.summary?.latencyP99 || 0,
        current: current.summary?.latencyP99 || 0,
        delta: (current.summary?.latencyP99 || 0) - (baseline.summary?.latencyP99 || 0)
      }
    };

    return comparison;
  }
}

// ==========================================
// Convenience Functions
// ==========================================

/**
 * Create RetrievalEvaluator with default configuration
 *
 * @param {Object} options - Configuration options
 * @returns {RetrievalEvaluator} Configured instance
 */
export function createRetrievalEvaluator(options = {}) {
  return new RetrievalEvaluator(options);
}

/**
 * Quick evaluation function for single query
 *
 * @param {string} query - Search query
 * @param {string[]} relevantIds - Ground truth relevant IDs
 * @param {Object} options - Evaluation options
 * @returns {Promise<Object>} Evaluation results
 */
export async function evaluateRetrieval(query, relevantIds, options = {}) {
  const evaluator = createRetrievalEvaluator(options);
  return evaluator.evaluateQuery(query, relevantIds, options);
}

/**
 * Run full evaluation suite
 *
 * @param {Array} testQueries - Test queries
 * @param {Object} options - Evaluation options
 * @returns {Promise<Object>} Full evaluation report
 */
export async function runEvaluationSuite(testQueries, options = {}) {
  const evaluator = createRetrievalEvaluator(options);
  return evaluator.evaluateBatch(testQueries, options);
}

// ==========================================
// Export
// ==========================================

export default {
  RetrievalEvaluator,
  createRetrievalEvaluator,
  evaluateRetrieval,
  runEvaluationSuite,
  CONFIG
};
