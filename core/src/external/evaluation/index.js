/**
 * HIVE-MIND Retrieval Quality Evaluation Module
 *
 * Comprehensive evaluation system for measuring retrieval performance
 * using standard IR metrics: Precision, Recall, F1, NDCG, MRR, and Latency.
 *
 * @module evaluation
 * @example
 * ```javascript
 * import { RetrievalEvaluator, TEST_QUERIES, runEvaluationSuite } from './evaluation/index.js';
 *
 * // Create evaluator
 * const evaluator = new RetrievalEvaluator({
 *   vectorStore: qdrantClient,
 *   graphStore: prismaStore,
 *   llmClient: groqClient
 * });
 *
 * // Evaluate single query
 * const result = await evaluator.evaluateQuery(
 *   "What was the decision about the database migration?",
 *   ['uuid-1', 'uuid-2'],
 *   { userId: 'user-123', method: 'hybrid' }
 * );
 *
 * // Run full evaluation suite
 * const report = await evaluator.evaluateBatch(TEST_QUERIES, {
 *   userId: 'user-123',
 *   methods: ['quick', 'hybrid', 'recall']
 * });
 * ```
 */

// Core evaluator
export { RetrievalEvaluator, createRetrievalEvaluator } from './retrieval-evaluator.js';

// Test dataset
export {
  TEST_QUERIES,
  getDatasetStats,
  getQueriesByCategory,
  getQueriesByDifficulty,
  getSampleQueries,
  getQueriesByTags
} from './test-dataset.js';

// Convenience functions
export { evaluateRetrieval, runEvaluationSuite } from './retrieval-evaluator.js';

// CLI runner exports
export {
  parseArgs,
  selectQueries,
  formatReport,
  formatComparison,
  saveReport,
  loadBaseline,
  CONFIG as RUNNER_CONFIG
} from './run-evaluation.js';
