/**
 * Search Filters
 *
 * Implements filtering for tag, project, and user-based searches
 * Supports complex filter combinations for precise recall
 *
 * @module search/filters
 */

// ==========================================
// Configuration
// ==========================================

const CONFIG = {
  // Filter limits
  limits: {
    maxTags: 10,
    maxProjects: 10,
    maxUsers: 100
  },

  // Default filter values
  defaults: {
    limit: 20,
    offset: 0,
    minScore: 0,
    includeDeleted: false
  },

  // Filter operators
  operators: {
    and: 'and',
    or: 'or',
    not: 'not'
  }
};

// ==========================================
// Logger
// ==========================================

const logger = {
  info: (msg, ctx) => console.log(`[FILTERS INFO] ${msg}`, ctx || {}),
  warn: (msg, ctx) => console.warn(`[FILTERS WARN] ${msg}`, ctx || {}),
  error: (msg, ctx) => console.error(`[FILTERS ERROR] ${msg}`, ctx || {}),
  debug: (msg, ctx) => console.debug(`[FILTERS DEBUG] ${msg}`, ctx || {})
};

// ==========================================
// Filter Types
// ==========================================

/**
 * Filter object structure
 *
 * @typedef {object} Filter
 * @property {string} type - Filter type
 * @property {string|Array} value - Filter value(s)
 * @property {string} operator - Logical operator (and/or/not)
 */

// ==========================================
// Tag Filters
// ==========================================

/**
 * Create tag filter
 *
 * @param {string|Array} tags - Tag(s) to filter by
 * @param {object} options - Filter options
 * @returns {object} Tag filter
 */
function createTagFilter(tags, options = {}) {
  const {
    operator = CONFIG.operators.and,
    caseSensitive = false
  } = options;

  const tagArray = Array.isArray(tags) ? tags : [tags];

  if (tagArray.length > CONFIG.limits.maxTags) {
    logger.warn('Tag filter exceeds maximum', {
      count: tagArray.length,
      max: CONFIG.limits.maxTags
    });
  }

  return {
    type: 'tags',
    value: caseSensitive ? tagArray : tagArray.map(t => t.toLowerCase()),
    operator,
    caseSensitive,
    timestamp: Date.now()
  };
}

/**
 * Apply tag filter to results
 *
 * @param {Array} results - Search results
 * @param {object} filter - Tag filter
 * @returns {Array} Filtered results
 */
function applyTagFilter(results, filter) {
  if (!filter.value || filter.value.length === 0) {
    return results;
  }

  const tagArray = filter.caseSensitive ? filter.value : filter.value.map(t => t.toLowerCase());

  return results.filter(result => {
    const resultTags = (result.tags || []).map(t =>
      filter.caseSensitive ? t : t.toLowerCase()
    );

    if (filter.operator === CONFIG.operators.or) {
      // At least one tag matches
      return tagArray.some(tag => resultTags.includes(tag));
    } else if (filter.operator === CONFIG.operators.not) {
      // No tags match
      return !tagArray.some(tag => resultTags.includes(tag));
    } else {
      // All tags must match (default: and)
      return tagArray.every(tag => resultTags.includes(tag));
    }
  });
}

// ==========================================
// Project Filters
// ==========================================

/**
 * Create project filter
 *
 * @param {string|Array} projects - Project(s) to filter by
 * @param {object} options - Filter options
 * @returns {object} Project filter
 */
function createProjectFilter(projects, options = {}) {
  const {
    operator = CONFIG.operators.and,
    caseSensitive = false
  } = options;

  const projectArray = Array.isArray(projects) ? projects : [projects];

  if (projectArray.length > CONFIG.limits.maxProjects) {
    logger.warn('Project filter exceeds maximum', {
      count: projectArray.length,
      max: CONFIG.limits.maxProjects
    });
  }

  return {
    type: 'projects',
    value: caseSensitive ? projectArray : projectArray.map(p => p.toLowerCase()),
    operator,
    caseSensitive,
    timestamp: Date.now()
  };
}

/**
 * Apply project filter to results
 *
 * @param {Array} results - Search results
    * @param {object} filter - Project filter
 * @returns {Array} Filtered results
 */
function applyProjectFilter(results, filter) {
  if (!filter.value || filter.value.length === 0) {
    return results;
  }

  const projectArray = filter.caseSensitive ? filter.value : filter.value.map(p => p.toLowerCase());

  return results.filter(result => {
    const resultProjects = (result.projects || result.project || [])
      .map(p => filter.caseSensitive ? p : p.toLowerCase());

    if (filter.operator === CONFIG.operators.or) {
      return projectArray.some(project => resultProjects.includes(project));
    } else if (filter.operator === CONFIG.operators.not) {
      return !projectArray.some(project => resultProjects.includes(project));
    } else {
      return projectArray.every(project => resultProjects.includes(project));
    }
  });
}

// ==========================================
// User Filters
// ==========================================

/**
 * Create user filter
 *
 * @param {string|Array} userIds - User ID(s) to filter by
 * @param {object} options - Filter options
 * @returns {object} User filter
 */
function createUserFilter(userIds, options = {}) {
  const {
    operator = CONFIG.operators.and
  } = options;

  const userIdArray = Array.isArray(userIds) ? userIds : [userIds];

  if (userIdArray.length > CONFIG.limits.maxUsers) {
    logger.warn('User filter exceeds maximum', {
      count: userIdArray.length,
      max: CONFIG.limits.maxUsers
    });
  }

  return {
    type: 'users',
    value: userIdArray,
    operator,
    timestamp: Date.now()
  };
}

/**
 * Apply user filter to results
 *
 * @param {Array} results - Search results
 * @param {object} filter - User filter
 * @returns {Array} Filtered results
 */
function applyUserFilter(results, filter) {
  if (!filter.value || filter.value.length === 0) {
    return results;
  }

  const userIdSet = new Set(filter.value);

  return results.filter(result => {
    const resultUserId = result.user_id || result.userId;

    if (filter.operator === CONFIG.operators.or) {
      return userIdSet.has(resultUserId);
    } else if (filter.operator === CONFIG.operators.not) {
      return !userIdSet.has(resultUserId);
    } else {
      return userIdSet.has(resultUserId);
    }
  });
}

// ==========================================
// Source Platform Filters
// ==========================================

/**
 * Create source platform filter
 *
 * @param {string|Array} platforms - Platform(s) to filter by
 * @param {object} options - Filter options
 * @returns {object} Platform filter
 */
function createPlatformFilter(platforms, options = {}) {
  const {
    operator = CONFIG.operators.and,
    caseSensitive = false
  } = options;

  const platformArray = Array.isArray(platforms) ? platforms : [platforms];

  return {
    type: 'platforms',
    value: caseSensitive ? platformArray : platformArray.map(p => p.toLowerCase()),
    operator,
    caseSensitive,
    timestamp: Date.now()
  };
}

/**
 * Apply platform filter to results
 *
 * @param {Array} results - Search results
 * @param {object} filter - Platform filter
 * @returns {Array} Filtered results
 */
function applyPlatformFilter(results, filter) {
  if (!filter.value || filter.value.length === 0) {
    return results;
  }

  const platformArray = filter.caseSensitive ? filter.value : filter.value.map(p => p.toLowerCase());

  return results.filter(result => {
    const resultPlatform = (result.source_platform || result.platform || '')
      .toLowerCase();

    if (filter.operator === CONFIG.operators.or) {
      return platformArray.includes(resultPlatform);
    } else if (filter.operator === CONFIG.operators.not) {
      return !platformArray.includes(resultPlatform);
    } else {
      return platformArray.includes(resultPlatform);
    }
  });
}

// ==========================================
// Memory Type Filters
// ==========================================

/**
 * Create memory type filter
 *
 * @param {string|Array} types - Memory type(s) to filter by
 * @param {object} options - Filter options
 * @returns {object} Memory type filter
 */
function createTypeFilter(types, options = {}) {
  const {
    operator = CONFIG.operators.and,
    validTypes = ['fact', 'preference', 'decision', 'lesson', 'goal', 'event', 'relationship']
  } = options;

  const typeArray = Array.isArray(types) ? types : [types];

  // Validate types
  const invalidTypes = typeArray.filter(t => !validTypes.includes(t));
  if (invalidTypes.length > 0) {
    logger.warn('Invalid memory types in filter', { invalidTypes });
  }

  return {
    type: 'memory_types',
    value: typeArray,
    operator,
    timestamp: Date.now()
  };
}

/**
 * Apply memory type filter to results
 *
 * @param {Array} results - Search results
 * @param {object} filter - Memory type filter
 * @returns {Array} Filtered results
 */
function applyTypeFilter(results, filter) {
  if (!filter.value || filter.value.length === 0) {
    return results;
  }

  const typeSet = new Set(filter.value);

  return results.filter(result => {
    const resultType = result.memory_type || result.type;

    if (filter.operator === CONFIG.operators.or) {
      return typeSet.has(resultType);
    } else if (filter.operator === CONFIG.operators.not) {
      return !typeSet.has(resultType);
    } else {
      return typeSet.has(resultType);
    }
  });
}

// ==========================================
// Date Range Filters
// ==========================================

/**
 * Create date range filter
 *
 * @param {object} range - Date range {start, end}
 * @param {object} options - Filter options
 * @returns {object} Date range filter
 */
function createDateRangeFilter(range, options = {}) {
  const {
    field = 'document_date'
  } = options;

  const { start, end } = range;

  return {
    type: 'date_range',
    field,
    start: start ? new Date(start).toISOString() : null,
    end: end ? new Date(end).toISOString() : null,
    timestamp: Date.now()
  };
}

/**
 * Apply date range filter to results
 *
 * @param {Array} results - Search results
 * @param {object} filter - Date range filter
 * @returns {Array} Filtered results
 */
function applyDateRangeFilter(results, filter) {
  if (!filter.start && !filter.end) {
    return results;
  }

  const startDate = filter.start ? new Date(filter.start) : null;
  const endDate = filter.end ? new Date(filter.end) : null;

  return results.filter(result => {
    const resultDate = new Date(result[filter.field] || result.document_date || result.created_at);

    if (startDate && resultDate < startDate) {
      return false;
    }

    if (endDate && resultDate > endDate) {
      return false;
    }

    return true;
  });
}

// ==========================================
// Score Filters
// ==========================================

/**
 * Create score filter
 *
 * @param {object} range - Score range {min, max}
 * @param {object} options - Filter options
 * @returns {object} Score filter
 */
function createScoreFilter(range, options = {}) {
  const { min = 0, max = 1 } = range;

  return {
    type: 'score_range',
    min,
    max,
    timestamp: Date.now()
  };
}

/**
 * Apply score filter to results
 *
 * @param {Array} results - Search results
 * @param {object} filter - Score filter
 * @returns {Array} Filtered results
 */
function applyScoreFilter(results, filter) {
  const { min = 0, max = 1 } = filter;

  return results.filter(result => {
    const score = result.score || 0;
    return score >= min && score <= max;
  });
}

// ==========================================
// Combined Filters
// ==========================================

/**
 * Create combined filter
 *
 * @param {Array} filters - Array of filter objects
 * @param {string} operator - Logical operator (and/or)
 * @returns {object} Combined filter
 */
function createCombinedFilter(filters, operator = CONFIG.operators.and) {
  return {
    type: 'combined',
    filters,
    operator,
    timestamp: Date.now()
  };
}

/**
 * Apply combined filter to results
 *
 * @param {Array} results - Search results
 * @param {object} filter - Combined filter
 * @returns {Array} Filtered results
 */
function applyCombinedFilter(results, filter) {
  let filtered = [...results];

  for (const subFilter of filter.filters) {
    filtered = applyFilter(filtered, subFilter);
  }

  return filtered;
}

// ==========================================
// Main Filter Application
// ==========================================

/**
 * Apply single filter to results
 *
 * @param {Array} results - Search results
 * @param {object} filter - Filter object
 * @returns {Array} Filtered results
 */
function applyFilter(results, filter) {
  if (!filter || !filter.type) {
    return results;
  }

  switch (filter.type) {
    case 'tags':
      return applyTagFilter(results, filter);
    case 'projects':
      return applyProjectFilter(results, filter);
    case 'users':
      return applyUserFilter(results, filter);
    case 'platforms':
      return applyPlatformFilter(results, filter);
    case 'memory_types':
      return applyTypeFilter(results, filter);
    case 'date_range':
      return applyDateRangeFilter(results, filter);
    case 'score_range':
      return applyScoreFilter(results, filter);
    case 'combined':
      return applyCombinedFilter(results, filter);
    default:
      logger.warn('Unknown filter type', { type: filter.type });
      return results;
  }
}

/**
 * Apply multiple filters to results
 *
 * @param {Array} results - Search results
 * @param {Array} filters - Array of filter objects
 * @param {string} operator - Logical operator (and/or)
 * @returns {Array} Filtered results
 */
function applyFilters(results, filters, operator = CONFIG.operators.and) {
  if (!filters || filters.length === 0) {
    return results;
  }

  if (operator === CONFIG.operators.or) {
    // OR logic: include results matching any filter
    const matchedIds = new Set();

    filters.forEach(filter => {
      const filtered = applyFilter(results, filter);
      filtered.forEach(result => matchedIds.add(result.id));
    });

    return results.filter(result => matchedIds.has(result.id));
  } else {
    // AND logic: include only results matching all filters
    let filtered = [...results];

    for (const filter of filters) {
      filtered = applyFilter(filtered, filter);
    }

    return filtered;
  }
}

// ==========================================
// Filter Validation
// ==========================================

/**
 * Validate filter object
 *
 * @param {object} filter - Filter object
 * @returns {object} Validation result
 */
function validateFilter(filter) {
  if (!filter || !filter.type) {
    return { valid: false, error: 'Filter must have a type' };
  }

  if (filter.type === 'tags' && (!filter.value || filter.value.length === 0)) {
    return { valid: false, error: 'Tags filter must have values' };
  }

  if (filter.type === 'users' && (!filter.value || filter.value.length === 0)) {
    return { valid: false, error: 'Users filter must have values' };
  }

  if (filter.type === 'score_range') {
    if (filter.min !== undefined && filter.max !== undefined && filter.min > filter.max) {
      return { valid: false, error: 'min score cannot be greater than max score' };
    }
  }

  return { valid: true };
}

/**
 * Validate multiple filters
 *
 * @param {Array} filters - Array of filter objects
 * @returns {object} Validation result
 */
function validateFilters(filters) {
  const errors = [];

  if (!filters || !Array.isArray(filters)) {
    return { valid: false, errors: ['Filters must be an array'] };
  }

  filters.forEach((filter, index) => {
    const result = validateFilter(filter);
    if (!result.valid) {
      errors.push({ index, ...result });
    }
  });

  return {
    valid: errors.length === 0,
    errors
  };
}

// ==========================================
// Filter Serialization
// ==========================================

/**
 * Serialize filter for storage/transmission
 *
 * @param {object} filter - Filter object
 * @returns {object} Serialized filter
 */
function serializeFilter(filter) {
  return {
    type: filter.type,
    value: filter.value,
    operator: filter.operator,
    ...('min' in filter ? { min: filter.min } : {}),
    ...('max' in filter ? { max: filter.max } : {}),
    ...('start' in filter ? { start: filter.start } : {}),
    ...('end' in filter ? { end: filter.end } : {}),
    ...('caseSensitive' in filter ? { caseSensitive: filter.caseSensitive } : {}),
    ...('field' in filter ? { field: filter.field } : {})
  };
}

/**
 * Deserialize filter from storage/transmission
 *
 * @param {object} serialized - Serialized filter
 * @returns {object} Filter object
 */
function deserializeFilter(serialized) {
  return {
    type: serialized.type,
    value: serialized.value,
    operator: serialized.operator || CONFIG.operators.and,
    ...(serialized.min !== undefined ? { min: serialized.min } : {}),
    ...(serialized.max !== undefined ? { max: serialized.max } : {}),
    ...(serialized.start !== undefined ? { start: serialized.start } : {}),
    ...(serialized.end !== undefined ? { end: serialized.end } : {}),
    ...(serialized.caseSensitive !== undefined ? { caseSensitive: serialized.caseSensitive } : {}),
    ...(serialized.field !== undefined ? { field: serialized.field } : {})
  };
}

// ==========================================
// Export
// ==========================================

export default {
  // Filter creation
  createTagFilter,
  createProjectFilter,
  createUserFilter,
  createPlatformFilter,
  createTypeFilter,
  createDateRangeFilter,
  createScoreFilter,
  createCombinedFilter,

  // Filter application
  applyFilter,
  applyFilters,
  applyTagFilter,
  applyProjectFilter,
  applyUserFilter,
  applyPlatformFilter,
  applyTypeFilter,
  applyDateRangeFilter,
  applyScoreFilter,
  applyCombinedFilter,

  // Validation
  validateFilter,
  validateFilters,

  // Serialization
  serializeFilter,
  deserializeFilter,

  // Configuration
  CONFIG
};
