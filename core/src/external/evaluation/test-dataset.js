/**
 * Test Dataset for Retrieval Quality Evaluation
 *
 * Pre-defined enterprise-like queries with ground truth relevance judgments.
 * Covers technical, business, and personal memory categories.
 *
 * @module evaluation/test-dataset
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ==========================================
// Test Query Dataset
// ==========================================

/**
 * Enterprise-like test queries with ground truth relevance judgments.
 * Each query includes:
 * - query: The search query text
 * - relevantMemories: Array of memory UUIDs that should be retrieved
 * - category: Memory category (technical, business, personal)
 * - difficulty: Query difficulty (easy, medium, hard)
 * - description: Human-readable description of the query intent
 */
export const TEST_QUERIES = [
  // ==========================================
  // Technical Queries
  // ==========================================
  {
    query: "What was the decision about the database migration?",
    relevantMemories: [
      '550e8400-e29b-41d4-a716-446655440001',
      '550e8400-e29b-41d4-a716-446655440002'
    ],
    category: 'technical',
    difficulty: 'medium',
    description: 'Finds decisions related to database migration planning',
    tags: ['database', 'migration', 'architecture', 'decision']
  },
  {
    query: "Show me all project Alpha related memories",
    relevantMemories: [
      '550e8400-e29b-41d4-a716-446655440003',
      '550e8400-e29b-41d4-a716-446655440004',
      '550e8400-e29b-41d4-a716-446655440005'
    ],
    category: 'technical',
    difficulty: 'easy',
    description: 'Retrieves all memories associated with Project Alpha',
    tags: ['project-alpha', 'technical', 'overview']
  },
  {
    query: "What did we discuss about the API rate limits?",
    relevantMemories: [
      '550e8400-e29b-41d4-a716-446655440006'
    ],
    category: 'technical',
    difficulty: 'medium',
    description: 'Finds discussions about API rate limiting implementation',
    tags: ['api', 'rate-limits', 'backend', 'discussion']
  },
  {
    query: "How do we handle authentication in the microservices?",
    relevantMemories: [
      '550e8400-e29b-41d4-a716-446655440007',
      '550e8400-e29b-41d4-a716-446655440008',
      '550e8400-e29b-41d4-a716-446655440009'
    ],
    category: 'technical',
    difficulty: 'medium',
    description: 'Retrieves authentication patterns for microservices architecture',
    tags: ['authentication', 'microservices', 'security', 'architecture']
  },
  {
    query: "What is the caching strategy for Redis?",
    relevantMemories: [
      '550e8400-e29b-41d4-a716-446655440010',
      '550e8400-e29b-41d4-a716-446655440011'
    ],
    category: 'technical',
    difficulty: 'easy',
    description: 'Finds Redis caching implementation details',
    tags: ['redis', 'caching', 'performance', 'infrastructure']
  },
  {
    query: "Show me the error handling patterns we use",
    relevantMemories: [
      '550e8400-e29b-41d4-a716-446655440012',
      '550e8400-e29b-41d4-a716-446655440013',
      '550e8400-e29b-41d4-a716-446655440014',
      '550e8400-e29b-41d4-a716-446655440015'
    ],
    category: 'technical',
    difficulty: 'medium',
    description: 'Retrieves error handling and exception management patterns',
    tags: ['error-handling', 'patterns', 'best-practices']
  },
  {
    query: "What monitoring tools are we using for production?",
    relevantMemories: [
      '550e8400-e29b-41d4-a716-446655440016',
      '550e8400-e29b-41d4-a716-446655440017'
    ],
    category: 'technical',
    difficulty: 'easy',
    description: 'Finds production monitoring and observability setup',
    tags: ['monitoring', 'production', 'observability', 'tools']
  },
  {
    query: "Explain the event-driven architecture decisions",
    relevantMemories: [
      '550e8400-e29b-41d4-a716-446655440018',
      '550e8400-e29b-41d4-a716-446655440019',
      '550e8400-e29b-41d4-a716-446655440020'
    ],
    category: 'technical',
    difficulty: 'hard',
    description: 'Retrieves architectural decisions about event-driven design',
    tags: ['architecture', 'event-driven', 'design-decisions', 'messaging']
  },
  {
    query: "What are the deployment procedures for the backend?",
    relevantMemories: [
      '550e8400-e29b-41d4-a716-446655440021',
      '550e8400-e29b-41d4-a716-446655440022'
    ],
    category: 'technical',
    difficulty: 'medium',
    description: 'Finds deployment and CI/CD procedures',
    tags: ['deployment', 'backend', 'ci-cd', 'procedures']
  },
  {
    query: "How do we manage database connections in the application?",
    relevantMemories: [
      '550e8400-e29b-41d4-a716-446655440023',
      '550e8400-e29b-41d4-a716-446655440024'
    ],
    category: 'technical',
    difficulty: 'medium',
    description: 'Retrieves connection pooling and database management patterns',
    tags: ['database', 'connections', 'pooling', 'performance']
  },

  // ==========================================
  // Business Queries
  // ==========================================
  {
    query: "What are the Q3 revenue targets?",
    relevantMemories: [
      '550e8400-e29b-41d4-a716-446655440025',
      '550e8400-e29b-41d4-a716-446655440026'
    ],
    category: 'business',
    difficulty: 'easy',
    description: 'Finds quarterly revenue targets and goals',
    tags: ['revenue', 'q3', 'targets', 'business']
  },
  {
    query: "Show me the customer feedback from last month",
    relevantMemories: [
      '550e8400-e29b-41d4-a716-446655440027',
      '550e8400-e29b-41d4-a716-446655440028',
      '550e8400-e29b-41d4-a716-446655440029',
      '550e8400-e29b-41d4-a716-446655440030'
    ],
    category: 'business',
    difficulty: 'medium',
    description: 'Retrieves recent customer feedback and reviews',
    tags: ['customer-feedback', 'reviews', 'business', 'last-month']
  },
  {
    query: "What was discussed in the product roadmap meeting?",
    relevantMemories: [
      '550e8400-e29b-41d4-a716-446655440031',
      '550e8400-e29b-41d4-a716-446655440032'
    ],
    category: 'business',
    difficulty: 'medium',
    description: 'Finds product roadmap discussions and decisions',
    tags: ['product-roadmap', 'meeting', 'planning', 'business']
  },
  {
    query: "Who are our main competitors and their strengths?",
    relevantMemories: [
      '550e8400-e29b-41d4-a716-446655440033',
      '550e8400-e29b-41d4-a716-446655440034',
      '550e8400-e29b-41d4-a716-446655440035'
    ],
    category: 'business',
    difficulty: 'medium',
    description: 'Retrieves competitive analysis and market research',
    tags: ['competitors', 'market-analysis', 'business', 'strategy']
  },
  {
    query: "What are the key metrics for user engagement?",
    relevantMemories: [
      '550e8400-e29b-41d4-a716-446655440036',
      '550e8400-e29b-41d4-a716-446655440037'
    ],
    category: 'business',
    difficulty: 'easy',
    description: 'Finds user engagement KPIs and metrics definitions',
    tags: ['metrics', 'user-engagement', 'kpi', 'analytics']
  },
  {
    query: "Show me the budget allocation for marketing",
    relevantMemories: [
      '550e8400-e29b-41d4-a716-446655440038',
      '550e8400-e29b-41d4-a716-446655440039'
    ],
    category: 'business',
    difficulty: 'easy',
    description: 'Retrieves marketing budget and allocation details',
    tags: ['budget', 'marketing', 'finance', 'allocation']
  },
  {
    query: "What partnerships are we exploring this quarter?",
    relevantMemories: [
      '550e8400-e29b-41d4-a716-446655440040',
      '550e8400-e29b-41d4-a716-446655440041',
      '550e8400-e29b-41d4-a716-446655440042'
    ],
    category: 'business',
    difficulty: 'medium',
    description: 'Finds partnership opportunities and discussions',
    tags: ['partnerships', 'business-development', 'quarterly', 'strategy']
  },
  {
    query: "What are the hiring plans for the engineering team?",
    relevantMemories: [
      '550e8400-e29b-41d4-a716-446655440043',
      '550e8400-e29b-41d4-a716-446655440044'
    ],
    category: 'business',
    difficulty: 'easy',
    description: 'Retrieves hiring and recruitment plans',
    tags: ['hiring', 'engineering', 'recruitment', 'team-growth']
  },
  {
    query: "Show me the contract terms with our biggest client",
    relevantMemories: [
      '550e8400-e29b-41d4-a716-446655440045'
    ],
    category: 'business',
    difficulty: 'hard',
    description: 'Finds specific contract details for major client',
    tags: ['contract', 'client', 'legal', 'business']
  },
  {
    query: "What was the outcome of the board meeting?",
    relevantMemories: [
      '550e8400-e29b-41d4-a716-446655440046',
      '550e8400-e29b-41d4-a716-446655440047'
    ],
    category: 'business',
    difficulty: 'medium',
    description: 'Retrieves board meeting outcomes and decisions',
    tags: ['board-meeting', 'outcomes', 'decisions', 'governance']
  },

  // ==========================================
  // Personal/Productivity Queries
  // ==========================================
  {
    query: "What are my action items from yesterday's standup?",
    relevantMemories: [
      '550e8400-e29b-41d4-a716-446655440048',
      '550e8400-e29b-41d4-a716-446655440049'
    ],
    category: 'personal',
    difficulty: 'medium',
    description: 'Finds personal action items from team meetings',
    tags: ['action-items', 'standup', 'tasks', 'personal']
  },
  {
    query: "Show me notes from the one-on-one with my manager",
    relevantMemories: [
      '550e8400-e29b-41d4-a716-446655440050',
      '550e8400-e29b-41d4-a716-446655440051'
    ],
    category: 'personal',
    difficulty: 'easy',
    description: 'Retrieves 1:1 meeting notes and discussions',
    tags: ['one-on-one', 'manager', 'notes', 'career']
  },
  {
    query: "What conferences am I planning to attend this year?",
    relevantMemories: [
      '550e8400-e29b-41d4-a716-446655440052',
      '550e8400-e29b-41d4-a716-446655440053'
    ],
    category: 'personal',
    difficulty: 'easy',
    description: 'Finds conference and event planning notes',
    tags: ['conferences', 'events', 'planning', 'professional-development']
  },
  {
    query: "What books were recommended by the team?",
    relevantMemories: [
      '550e8400-e29b-41d4-a716-446655440054',
      '550e8400-e29b-41d4-a716-446655440055',
      '550e8400-e29b-41d4-a716-446655440056'
    ],
    category: 'personal',
    difficulty: 'medium',
    description: 'Retrieves book recommendations from team discussions',
    tags: ['books', 'recommendations', 'learning', 'team']
  },
  {
    query: "What are my goals for this quarter?",
    relevantMemories: [
      '550e8400-e29b-41d4-a716-446655440057',
      '550e8400-e29b-41d4-a716-446655440058'
    ],
    category: 'personal',
    difficulty: 'easy',
    description: 'Finds personal quarterly goals and objectives',
    tags: ['goals', 'quarterly', 'objectives', 'personal-growth']
  },
  {
    query: "Show me feedback I received on my presentation",
    relevantMemories: [
      '550e8400-e29b-41d4-a716-446655440059',
      '550e8400-e29b-41d4-a716-446655440060'
    ],
    category: 'personal',
    difficulty: 'medium',
    description: 'Retrieves feedback on presentations and talks',
    tags: ['feedback', 'presentation', 'communication', 'improvement']
  },
  {
    query: "What training courses should I complete?",
    relevantMemories: [
      '550e8400-e29b-41d4-a716-446655440061',
      '550e8400-e29b-41d4-a716-446655440062',
      '550e8400-e29b-41d4-a716-446655440063'
    ],
    category: 'personal',
    difficulty: 'easy',
    description: 'Finds recommended training and learning paths',
    tags: ['training', 'courses', 'learning', 'development']
  },
  {
    query: "What are the key takeaways from the workshop?",
    relevantMemories: [
      '550e8400-e29b-41d4-a716-446655440064',
      '550e8400-e29b-41d4-a716-446655440065'
    ],
    category: 'personal',
    difficulty: 'medium',
    description: 'Retrieves workshop learnings and key points',
    tags: ['workshop', 'learnings', 'takeaways', 'training']
  },
  {
    query: "Who should I connect with about the new project?",
    relevantMemories: [
      '550e8400-e29b-41d4-a716-446655440066',
      '550e8400-e29b-41d4-a716-446655440067'
    ],
    category: 'personal',
    difficulty: 'hard',
    description: 'Finds networking and collaboration recommendations',
    tags: ['networking', 'collaboration', 'project', 'connections']
  },
  {
    query: "What time zones do my teammates work in?",
    relevantMemories: [
      '550e8400-e29b-41d4-a716-446655440068',
      '550e8400-e29b-41d4-a716-446655440069',
      '550e8400-e29b-41d4-a716-446655440070'
    ],
    category: 'personal',
    difficulty: 'easy',
    description: 'Retrieves team timezone information for scheduling',
    tags: ['timezones', 'team', 'scheduling', 'remote-work']
  }
];

export const CROSS_CLIENT_TEST_QUERIES = [
  {
    query: 'Groq API',
    relevantMemories: ['cross-client-groq-001'],
    category: 'cross-client',
    difficulty: 'medium',
    description: 'Antigravity-saved semantic note should be recalled in Claude quick search',
    tags: ['antigravity', 'claude', 'semantic', 'groq', 'cross-platform']
  },
  {
    query: 'session security cleanup',
    relevantMemories: ['cross-client-security-001'],
    category: 'cross-client',
    difficulty: 'easy',
    description: 'Cross-platform recall should prefer the correct session summary over unrelated context',
    tags: ['session', 'security', 'cross-platform', 'distractor-resistance']
  },
  {
    query: 'what did antigravity save about inference endpoints',
    relevantMemories: ['cross-client-inference-001', 'cross-client-inference-002'],
    category: 'cross-client',
    difficulty: 'hard',
    description: 'Multi-memory cross-client recall should preserve semantic and platform context',
    tags: ['antigravity', 'semantic', 'inference', 'multi-hop', 'cross-platform']
  }
];

const DATASET_REGISTRY = {
  default: TEST_QUERIES,
  'cross-client': CROSS_CLIENT_TEST_QUERIES,
  all: [...TEST_QUERIES, ...CROSS_CLIENT_TEST_QUERIES]
};

const __filename_ds = fileURLToPath(import.meta.url);
const __dirname_ds = path.dirname(__filename_ds);

try {
  const tenantPath = path.join(__dirname_ds, '../../../evaluation-reports/tenant-dataset.generated.json');
  if (fs.existsSync(tenantPath)) {
    const tenantData = JSON.parse(fs.readFileSync(tenantPath, 'utf-8'));
    if (Array.isArray(tenantData) && tenantData.length > 0) {
      DATASET_REGISTRY.tenant = tenantData;
    }
  }
} catch {
  // Tenant dataset not generated yet.
}

// ==========================================
// Dataset Statistics
// ==========================================

/**
 * Get dataset statistics
 * @returns {Object} Statistics about the test dataset
 */
export function getDatasetStats(dataset = 'default') {
  const queries = getQueriesForDataset(dataset);
  const stats = {
    dataset,
    total: queries.length,
    byCategory: {},
    byDifficulty: {},
    totalRelevantMemories: 0,
    avgRelevantPerQuery: 0
  };

  for (const query of queries) {
    // Count by category
    stats.byCategory[query.category] = (stats.byCategory[query.category] || 0) + 1;

    // Count by difficulty
    stats.byDifficulty[query.difficulty] = (stats.byDifficulty[query.difficulty] || 0) + 1;

    // Count relevant memories
    stats.totalRelevantMemories += query.relevantMemories.length;
  }

  stats.avgRelevantPerQuery = stats.totalRelevantMemories / stats.total;

  return stats;
}

/**
 * Get queries filtered by category
 * @param {string} category - Category to filter by
 * @returns {Array} Filtered queries
 */
export function getQueriesByCategory(category) {
  return DATASET_REGISTRY.all.filter(q => q.category === category);
}

/**
 * Get queries filtered by difficulty
 * @param {string} difficulty - Difficulty to filter by
 * @returns {Array} Filtered queries
 */
export function getQueriesByDifficulty(difficulty) {
  return DATASET_REGISTRY.all.filter(q => q.difficulty === difficulty);
}

/**
 * Get a sample of queries for quick testing
 * @param {number} count - Number of queries to sample
 * @returns {Array} Sample queries
 */
export function getSampleQueries(count = 5) {
  const shuffled = [...DATASET_REGISTRY.default].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, count);
}

/**
 * Get queries by tags
 * @param {string[]} tags - Tags to match
 * @returns {Array} Queries matching any of the tags
 */
export function getQueriesByTags(tags) {
  return DATASET_REGISTRY.all.filter(q =>
    q.tags.some(tag => tags.includes(tag))
  );
}

export function getQueriesForDataset(dataset = 'default') {
  const queries = DATASET_REGISTRY[dataset];
  if (!queries) {
    throw new Error(`Unknown dataset: ${dataset}`);
  }
  return [...queries];
}

export function getDatasetNames() {
  return Object.keys(DATASET_REGISTRY);
}

// ==========================================
// Export
// ==========================================

export default {
  TEST_QUERIES,
  CROSS_CLIENT_TEST_QUERIES,
  getDatasetStats,
  getQueriesByCategory,
  getQueriesByDifficulty,
  getSampleQueries,
  getQueriesByTags,
  getQueriesForDataset,
  getDatasetNames
};
