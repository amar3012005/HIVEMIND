/**
 * Search Module Index
 *
 * Central export point for all search functionality in HIVE-MIND.
 *
 * @module search
 */

// Three-Tier Retrieval Architecture
export {
  ThreeTierRetrieval,
  createThreeTierRetrieval,
  quickSearch,
  panoramaSearch,
  insightForgeSearch
} from './three-tier-retrieval.js';

// Panorama Search
export {
  PanoramaSearch,
  createPanoramaSearch,
  searchPanorama,
  getTemporalSummary
} from './panorama-search.js';

// Insight Forge
export {
  InsightForge,
  CONFIG as INSIGHT_FORGE_CONFIG,
  SUBQUERY_SYSTEM_PROMPT,
  ENTITY_EXTRACTION_PROMPT,
  ANALYSIS_PROMPT
} from './insight-forge.js';

// Hybrid Search
export {
  default as hybridSearch,
  hybridSearch as hybridSearchFn,
  vectorSearch,
  keywordSearch,
  graphSearch,
  fallbackSearch,
  combineSearchResults,
  buildQdrantFilter,
  CONFIG as HYBRID_CONFIG
} from './hybrid.js';

// Filters
export {
  default as filters,
  createTagFilter,
  createProjectFilter,
  createUserFilter,
  createPlatformFilter,
  createTypeFilter,
  createDateRangeFilter,
  createScoreFilter,
  createCombinedFilter,
  applyFilter,
  applyFilters,
  validateFilter,
  validateFilters,
  serializeFilter,
  deserializeFilter,
  CONFIG as FILTERS_CONFIG
} from './filters.js';

// Fusion
export { default as fusion } from './fusion.js';

// Default export for convenience
export { default } from './three-tier-retrieval.js';
