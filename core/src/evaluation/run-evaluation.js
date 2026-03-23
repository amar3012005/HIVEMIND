#!/usr/bin/env node
/**
 * Evaluation Runner CLI
 *
 * Command-line tool for running retrieval quality evaluations.
 * Supports multiple search methods, report generation, and benchmark comparison.
 *
 * Usage:
 *   node run-evaluation.js [options]
 *
 * Options:
 *   --method, -m       Search method (quick, panorama, insight, hybrid, recall, all)
 *   --category, -c     Filter by category (technical, business, personal)
 *   --difficulty, -d   Filter by difficulty (easy, medium, hard)
 *   --sample, -s       Run on sample of N queries
 *   --output, -o       Output file for report (JSON)
 *   --compare, -b      Compare with baseline report
 *   --user-id, -u      User ID for evaluation
 *   --org-id, -o       Organization ID for evaluation
 *   --verbose, -v      Verbose output
 *   --help, -h         Show help
 *
 * @module evaluation/run-evaluation
 */

import { RetrievalEvaluator } from './retrieval-evaluator.js';
import {
  TEST_QUERIES,
  getDatasetNames,
  getDatasetStats,
  getQueriesForDataset,
  getQueriesByCategory,
  getQueriesByDifficulty,
  getSampleQueries
} from './test-dataset.js';
import { getQdrantClient } from '../vector/qdrant-client.js';
import { getPrismaClient } from '../db/prisma.js';
import { PrismaGraphStore } from '../memory/prisma-graph-store.js';
import { getGroqClient } from '../../config/groq.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==========================================
// Configuration
// ==========================================

const CONFIG = {
  defaultUserId: process.env.HIVEMIND_DEFAULT_USER_ID || '00000000-0000-4000-8000-000000000001',
  defaultOrgId: process.env.HIVEMIND_DEFAULT_ORG_ID || '00000000-0000-4000-8000-000000000002',
  outputDir: path.join(process.cwd(), 'evaluation-reports'),
  baselineDir: path.join(process.cwd(), 'evaluation-baselines'),
  schemaVersion: '2026-03-19'
};

const DEMO_TENANT = {
  userId: '00000000-0000-4000-8000-000000000001',
  orgId: '00000000-0000-4000-8000-000000000002'
};

// ==========================================
// CLI Argument Parsing
// ==========================================

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    method: 'hybrid',
    dataset: 'default',
    category: null,
    difficulty: null,
    sample: null,
    output: null,
    compare: null,
    saveBaseline: null,
    userId: CONFIG.defaultUserId,
    orgId: CONFIG.defaultOrgId,
    userIdProvided: false,
    orgIdProvided: false,
    verbose: false,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '--method':
      case '-m':
        options.method = args[++i];
        break;
      case '--category':
      case '-c':
        options.category = args[++i];
        break;
      case '--dataset':
      case '-t':
        options.dataset = args[++i];
        break;
      case '--difficulty':
      case '-d':
        options.difficulty = args[++i];
        break;
      case '--sample':
      case '-s':
        options.sample = parseInt(args[++i], 10);
        break;
      case '--output':
      case '-o':
        options.output = args[++i];
        break;
      case '--compare':
      case '-b':
        options.compare = args[++i];
        break;
      case '--save-baseline':
        options.saveBaseline = args[++i] || 'baseline.json';
        break;
      case '--compare-baseline':
        options.compareBaseline = true;
        break;
      case '--user-id':
      case '-u':
        options.userId = args[++i];
        options.userIdProvided = true;
        break;
      case '--org-id':
        options.orgId = args[++i];
        options.orgIdProvided = true;
        break;
      case '--verbose':
      case '-v':
        options.verbose = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
    }
  }

  return options;
}

function showHelp() {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║         HIVE-MIND Retrieval Evaluation Runner              ║
╚════════════════════════════════════════════════════════════╝

Usage: node run-evaluation.js [options]

Options:
  --method, -m       Search method (quick, panorama, insight, hybrid, recall, all)
                     Default: hybrid

  --category, -c     Filter by category (technical, business, personal)
                     Default: all categories

  --dataset, -t      Dataset to use (default, cross-client, tenant, all)
                     Default: default
                     'tenant' requires running build-gold-dataset.js first

  --difficulty, -d   Filter by difficulty (easy, medium, hard)
                     Default: all difficulties

  --sample, -s       Run on sample of N queries
                     Default: all queries

  --output, -o       Output file for report (JSON)
                     Default: auto-generated filename

  --compare, -b      Compare with baseline report file
                     Default: none

  --save-baseline    Save this run into the baseline directory

  --user-id, -u      User ID for evaluation
                     Default: ${CONFIG.defaultUserId}

  --org-id           Organization ID for evaluation
                     Default: ${CONFIG.defaultOrgId}

  --verbose, -v      Verbose output

  --help, -h         Show this help message

Examples:
  # Run evaluation with hybrid search
  node run-evaluation.js

  # Run evaluation with specific method and category
  node run-evaluation.js --method quick --category technical

  # Run on sample of 10 queries with verbose output
  node run-evaluation.js --sample 10 --verbose

  # Compare with baseline
  node run-evaluation.js --compare evaluation-baselines/baseline-2026-03-15.json

  # Save report to specific file
  node run-evaluation.js --output my-report.json
`);
}

function validateOptions(options) {
  if (options.dataset !== 'tenant') {
    return;
  }

  const usingDemoTenant =
    options.userId === DEMO_TENANT.userId &&
    options.orgId === DEMO_TENANT.orgId;

  if (!usingDemoTenant) {
    return;
  }

  console.error('');
  console.error('Tenant evaluation is blocked for the fake demo UUIDs.');
  console.error('Generate and run the tenant dataset against the real user/org instead:');
  console.error('');
  console.error('  node src/evaluation/build-gold-dataset.js --user-id REAL_USER_ID --org-id REAL_ORG_ID');
  console.error('  node src/evaluation/run-evaluation.js --dataset tenant --user-id REAL_USER_ID --org-id REAL_ORG_ID --method quick');
  console.error('');
  process.exit(1);
}

// ==========================================
// Query Selection
// ==========================================

function selectQueries(options) {
  let queries = getQueriesForDataset(options.dataset);

  // Filter by category
  if (options.category) {
    queries = queries.filter(q => q.category === options.category);
    if (queries.length === 0) {
      console.error(`No queries found for category: ${options.category}`);
      process.exit(1);
    }
  }

  // Filter by difficulty
  if (options.difficulty) {
    queries = queries.filter(q => q.difficulty === options.difficulty);
    if (queries.length === 0) {
      console.error(`No queries found for difficulty: ${options.difficulty}`);
      process.exit(1);
    }
  }

  // Sample if requested
  if (options.sample && options.sample < queries.length) {
    queries = queries.sort(() => 0.5 - Math.random()).slice(0, options.sample);
  }

  return queries;
}

function getSearchMethods(methodOption) {
  if (methodOption === 'all') {
    return ['quick', 'panorama', 'hybrid', 'recall'];
  }
  return [methodOption];
}

// ==========================================
// Report Formatting
// ==========================================

function formatReport(report, verbose = false) {
  const lines = [];

  lines.push('');
  lines.push('╔════════════════════════════════════════════════════════════╗');
  lines.push('║              RETRIEVAL EVALUATION REPORT                   ║');
  lines.push('╚════════════════════════════════════════════════════════════╝');
  lines.push('');

  // Header
  lines.push(`Evaluation ID: ${report.evaluationId}`);
  lines.push(`Timestamp: ${report.timestamp}`);
  lines.push(`Duration: ${(report.duration / 1000).toFixed(2)}s`);
  lines.push(`Methods: ${report.methods.join(', ')}`);
  lines.push('');

  // Summary
  lines.push('┌────────────────────────────────────────────────────────────┐');
  lines.push('│ SUMMARY                                                    │');
  lines.push('└────────────────────────────────────────────────────────────┘');
  lines.push('');

  const summary = report.summary;
  lines.push(`Total Queries:      ${summary.totalQueries}`);
  lines.push(`Successful:         ${summary.successfulQueries}`);
  lines.push(`Failed:             ${summary.failedQueries}`);
  lines.push(`Quality Score:      ${summary.qualityScore}/100`);
  lines.push('');

  // Metrics
  lines.push('┌────────────────────────────────────────────────────────────┐');
  lines.push('│ METRICS (Mean Values)                                      │');
  lines.push('└────────────────────────────────────────────────────────────┘');
  lines.push('');

  const formatMetric = (name, value, threshold, suffix = '') => {
    const status = value >= threshold ? '✓' : '✗';
    const paddedName = name.padEnd(18);
    const paddedValue = (value + suffix).padStart(8);
    return `  ${status} ${paddedName}: ${paddedValue} (target: ${threshold}${suffix})`;
  };

  lines.push(formatMetric('Precision@5', summary.precisionAt5.mean.toFixed(3), report.targets.precisionAt5));
  lines.push(formatMetric('Recall@10', summary.recallAt10.mean.toFixed(3), report.targets.recallAt10));
  lines.push(formatMetric('F1@10', summary.f1At10.mean.toFixed(3), report.targets.f1Score));
  lines.push(formatMetric('NDCG@10', summary.ndcgAt10.mean.toFixed(3), report.targets.ndcgAt10));
  lines.push(formatMetric('MRR', summary.mrr.mean.toFixed(3), report.targets.mrr));
  lines.push('');

  // Latency
  lines.push('┌────────────────────────────────────────────────────────────┐');
  lines.push('│ LATENCY                                                    │');
  lines.push('└────────────────────────────────────────────────────────────┘');
  lines.push('');

  const p99Status = summary.latencyP99 <= report.targets.latencyP99 ? '✓' : '✗';
  lines.push(`  ${p99Status} P99: ${summary.latencyP99}ms (target: ${report.targets.latencyP99}ms)`);
  lines.push(`    P95: ${summary.latencyP95}ms`);
  lines.push(`    P50: ${summary.latencyP50}ms`);
  lines.push('');

  // By Category
  if (report.byCategory && Object.keys(report.byCategory).length > 0) {
    lines.push('┌────────────────────────────────────────────────────────────┐');
    lines.push('│ BY CATEGORY                                                │');
    lines.push('└────────────────────────────────────────────────────────────┘');
    lines.push('');

    for (const [category, data] of Object.entries(report.byCategory)) {
      lines.push(`  ${category.toUpperCase()} (${data.count} queries):`);
      lines.push(`    Precision@5: ${data.metrics.precisionAt5.mean.toFixed(3)}`);
      lines.push(`    Recall@10:   ${data.metrics.recallAt10.mean.toFixed(3)}`);
      lines.push(`    NDCG@10:     ${data.metrics.ndcgAt10.mean.toFixed(3)}`);
      lines.push('');
    }
  }

  // By Search Method
  if (report.bySearchMethod && Object.keys(report.bySearchMethod).length > 0) {
    lines.push('┌────────────────────────────────────────────────────────────┐');
    lines.push('│ BY SEARCH METHOD                                           │');
    lines.push('└────────────────────────────────────────────────────────────┘');
    lines.push('');

    for (const [method, data] of Object.entries(report.bySearchMethod)) {
      lines.push(`  ${method.toUpperCase()} (${data.count} queries):`);
      lines.push(`    Precision@5: ${data.metrics.precisionAt5.mean.toFixed(3)}`);
      lines.push(`    Recall@10:   ${data.metrics.recallAt10.mean.toFixed(3)}`);
      lines.push(`    NDCG@10:     ${data.metrics.ndcgAt10.mean.toFixed(3)}`);
      lines.push(`    Latency P99: ${data.latencyP99}ms`);
      lines.push('');
    }
  }

  // Failed Queries
  if (report.failedQueries && report.failedQueries.length > 0) {
    lines.push('┌────────────────────────────────────────────────────────────┐');
    lines.push('│ FAILED QUERIES                                             │');
    lines.push('└────────────────────────────────────────────────────────────┘');
    lines.push('');

    for (const failed of report.failedQueries.slice(0, 5)) {
      lines.push(`  • ${failed.query.substring(0, 60)}...`);
      lines.push(`    Method: ${failed.method}, Reason: ${failed.reason}`);
    }

    if (report.failedQueries.length > 5) {
      lines.push(`  ... and ${report.failedQueries.length - 5} more`);
    }
    lines.push('');
  }

  // Verbose: Raw Results
  if (verbose && report.rawResults) {
    lines.push('┌────────────────────────────────────────────────────────────┐');
    lines.push('│ DETAILED RESULTS                                           │');
    lines.push('└────────────────────────────────────────────────────────────┘');
    lines.push('');

    for (const result of report.rawResults.slice(0, 10)) {
      lines.push(`Query: ${result.query}`);
      lines.push(`  Method: ${result.method}, Latency: ${result.latencyMs}ms`);
      lines.push(`  Precision@5: ${result.metrics.precisionAt5.toFixed(3)}`);
      lines.push(`  Recall@10: ${result.metrics.recallAt10.toFixed(3)}`);
      lines.push(`  Passed: ${result.passed?.allPassed || false}`);
      lines.push('');
    }
  }

  // Benchmark Summary (latency vs relevance)
  if (report.latency_benchmark || report.relevance_benchmark) {
    lines.push('┌────────────────────────────────────────────────────────────┐');
    lines.push('│ BENCHMARKS                                                 │');
    lines.push('└────────────────────────────────────────────────────────────┘');
    lines.push('');

    if (report.latency_benchmark) {
      const lb = report.latency_benchmark;
      const status = lb.pass ? 'PASS' : 'FAIL';
      lines.push(`  Latency:   ${status}  (p99: ${lb.p99_ms}ms, target: <${lb.target_p99_ms}ms)`);
    }
    if (report.relevance_benchmark) {
      const rb = report.relevance_benchmark;
      const status = rb.pass ? 'PASS' : 'FAIL';
      lines.push(`  Relevance: ${status}  (P@5: ${rb.precision_at_5.toFixed(3)}, R@10: ${rb.recall_at_10.toFixed(3)}, MRR: ${rb.mrr.toFixed(3)})`);
    }
    lines.push('');
  }

  // Footer
  lines.push('╔════════════════════════════════════════════════════════════╗');
  lines.push('║  Evaluation Complete                                       ║');
  lines.push('╚════════════════════════════════════════════════════════════╝');
  lines.push('');

  return lines.join('\n');
}

function formatComparison(comparison) {
  const lines = [];

  lines.push('');
  lines.push('╔════════════════════════════════════════════════════════════╗');
  lines.push('║              BASELINE COMPARISON                           ║');
  lines.push('╚════════════════════════════════════════════════════════════╝');
  lines.push('');

  lines.push(`Assessment: ${comparison.assessment.toUpperCase()}`);
  lines.push('');

  // Improvements
  if (Object.keys(comparison.improvements).length > 0) {
    lines.push('┌────────────────────────────────────────────────────────────┐');
    lines.push('│ IMPROVEMENTS 📈                                            │');
    lines.push('└────────────────────────────────────────────────────────────┘');
    lines.push('');

    for (const [metric, change] of Object.entries(comparison.improvements)) {
      lines.push(`  ${metric}:`);
      lines.push(`    ${change.baseline.toFixed(3)} → ${change.current.toFixed(3)}`);
      lines.push(`    (+${change.deltaPercent}%)`);
      lines.push('');
    }
  }

  // Regressions
  if (Object.keys(comparison.regressions).length > 0) {
    lines.push('┌────────────────────────────────────────────────────────────┐');
    lines.push('│ REGRESSIONS 📉                                             │');
    lines.push('└────────────────────────────────────────────────────────────┘');
    lines.push('');

    for (const [metric, change] of Object.entries(comparison.regressions)) {
      lines.push(`  ${metric}:`);
      lines.push(`    ${change.baseline.toFixed(3)} → ${change.current.toFixed(3)}`);
      lines.push(`    (${change.deltaPercent}%)`);
      lines.push('');
    }
  }

  // Unchanged
  if (Object.keys(comparison.unchanged).length > 0) {
    lines.push('┌────────────────────────────────────────────────────────────┐');
    lines.push('│ UNCHANGED ➡️                                                │');
    lines.push('└────────────────────────────────────────────────────────────┘');
    lines.push('');

    for (const [metric, change] of Object.entries(comparison.unchanged)) {
      lines.push(`  ${metric}: ${change.current.toFixed(3)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ==========================================
// File Operations
// ==========================================

function ensureDirectory(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function generateReportFilename() {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `evaluation-report-${timestamp}.json`;
}

function buildReportEnvelope(report, options, comparison = null) {
  return {
    schemaVersion: CONFIG.schemaVersion,
    kind: 'hivemind.retrieval-evaluation.bundle',
    generatedAt: new Date().toISOString(),
    dataset: options.dataset,
    filters: {
      category: options.category,
      difficulty: options.difficulty,
      sample: options.sample
    },
    methods: getSearchMethods(options.method),
    environment: {
      userId: options.userId,
      orgId: options.orgId
    },
    report,
    comparison
  };
}

function saveReport(bundle, filename, { baseline = false } = {}) {
  const outputDir = baseline ? CONFIG.baselineDir : CONFIG.outputDir;
  ensureDirectory(outputDir);
  const filepath = path.isAbsolute(filename)
    ? filename
    : path.join(outputDir, filename);

  fs.writeFileSync(filepath, JSON.stringify(bundle, null, 2), 'utf-8');
  return filepath;
}

function loadBaseline(filename) {
  const filepath = path.isAbsolute(filename)
    ? filename
    : path.join(CONFIG.baselineDir, filename);

  if (!fs.existsSync(filepath)) {
    // Try without directory
    if (fs.existsSync(filename)) {
      return JSON.parse(fs.readFileSync(filename, 'utf-8'));
    }
    throw new Error(`Baseline file not found: ${filepath}`);
  }

  const parsed = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  return parsed.report || parsed;
}

// ==========================================
// Main Execution
// ==========================================

async function main() {
  const options = parseArgs();

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  validateOptions(options);

  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║         HIVE-MIND Retrieval Evaluation Runner              ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  // Show dataset stats
  const stats = getDatasetStats(options.dataset);
  console.log('Dataset Statistics:');
  console.log(`  Dataset: ${stats.dataset}`);
  console.log(`  Total Queries: ${stats.total}`);
  console.log(`  By Category: ${Object.entries(stats.byCategory).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
  console.log(`  By Difficulty: ${Object.entries(stats.byDifficulty).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
  console.log(`  Avg Relevant/Query: ${stats.avgRelevantPerQuery.toFixed(1)}`);
  console.log('');

  // Select queries
  const queries = selectQueries(options);
  console.log(`Selected ${queries.length} queries for evaluation`);
  console.log(`  Method: ${options.method}`);
  console.log(`  Dataset: ${options.dataset}`);
  console.log(`  User ID: ${options.userId}`);
  console.log(`  Org ID: ${options.orgId}`);
  console.log('');

  // Initialize evaluator
  console.log('Initializing evaluator...');
  const prisma = getPrismaClient();
  const graphStore = prisma ? new PrismaGraphStore(prisma) : null;
  const groqClient = getGroqClient();

  const evaluator = new RetrievalEvaluator({
    vectorStore: getQdrantClient(),
    graphStore,
    llmClient: groqClient?.isAvailable() ? groqClient : null
  });

  // Get search methods
  const methods = getSearchMethods(options.method);

  // Run evaluation
  console.log('Running evaluation...');
  console.log('');

  const report = await evaluator.evaluateBatch(queries, {
    userId: options.userId,
    orgId: options.orgId,
    methods,
    warmup: true,
    dataset: options.dataset
  });

  // Display report
  console.log(formatReport(report, options.verbose));

  // Compare with baseline if requested
  let comparison = null;
  const compareFile = options.compare || (options.compareBaseline ? path.join(CONFIG.baselineDir, 'baseline.json') : null);
  if (compareFile) {
    try {
      const baseline = loadBaseline(compareFile);
      comparison = evaluator.compareReports(baseline, report);
      console.log(formatComparison(comparison));
    } catch (error) {
      console.error(`Failed to load baseline: ${error.message}`);
    }
  }

  // Save report
  const bundle = buildReportEnvelope(report, options, comparison);
  const outputFile = options.output || generateReportFilename();
  const outputPath = saveReport(bundle, outputFile);
  console.log(`Report saved to: ${outputPath}`);
  if (options.saveBaseline) {
    const baselinePath = saveReport(bundle, options.saveBaseline, { baseline: true });
    console.log(`Baseline saved to: ${baselinePath}`);
  }
  console.log('');

  // Exit with appropriate code
  const allPassed = report.summary && report.summary.qualityScore >= 50;
  process.exit(allPassed ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch(error => {
    console.error('Evaluation failed:', error);
    process.exit(1);
  });
}

// ==========================================
// Export for programmatic use
// ==========================================

export {
  parseArgs,
  selectQueries,
  formatReport,
  formatComparison,
  buildReportEnvelope,
  saveReport,
  loadBaseline,
  CONFIG
};
