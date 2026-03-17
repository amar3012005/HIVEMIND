/**
 * HIVE-MIND JavaScript SDK
 * Official SDK for integrating with HIVE-MIND AI Memory Engine
 *
 * @example
 * ```javascript
 * import { HiveMindClient } from '@hivemind/sdk';
 *
 * const hivemind = new HiveMindClient({
 *   url: 'https://hivemind.davinciai.eu:8050',
 *   apiKey: 'your-api-key'
 * });
 *
 * // Save a memory
 * await hivemind.save({
 *   title: 'Meeting notes',
 *   content: 'Discussed new features...',
 *   tags: ['work', 'meeting']
 * });
 *
 * // Search memories
 * const results = await hivemind.search('docker deployment');
 * ```
 */

const DEFAULT_OPTIONS = {
  timeout: 30000,
  retries: 3,
  retryDelay: 1000,
};

/**
 * HIVE-MIND API Client
 */
export class HiveMindClient {
  /**
   * Create a new HIVE-MIND client
   * @param {Object} config - Configuration options
   * @param {string} config.url - HIVE-MIND API URL (e.g., 'https://hivemind.davinciai.eu:8050')
   * @param {string} config.apiKey - Your API key
   * @param {string} [config.userId] - Default user ID
   * @param {string} [config.orgId] - Default organization ID
   * @param {number} [config.timeout=30000] - Request timeout in ms
   * @param {number} [config.retries=3] - Number of retries
   */
  constructor(config) {
    if (!config.url) {
      throw new Error('HIVE-MIND URL is required');
    }
    if (!config.apiKey) {
      throw new Error('API key is required');
    }

    this.baseUrl = config.url.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.defaultUserId = config.userId || 'anonymous';
    this.defaultOrgId = config.orgId || 'default';
    this.timeout = config.timeout || DEFAULT_OPTIONS.timeout;
    this.retries = config.retries || DEFAULT_OPTIONS.retries;
  }

  /**
   * Make an authenticated API request
   * @private
   */
  async _request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      ...options.headers,
    };

    const fetchOptions = {
      method: options.method || 'GET',
      headers,
      ...options.fetchOptions,
    };

    if (options.body) {
      fetchOptions.body = JSON.stringify(options.body);
    }

    let lastError;
    for (let attempt = 0; attempt < this.retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        fetchOptions.signal = controller.signal;

        const response = await fetch(url, fetchOptions);
        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text();
          throw new HiveMindError(
            `HTTP ${response.status}: ${errorText}`,
            response.status,
            errorText
          );
        }

        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          return await response.json();
        }
        return await response.text();
      } catch (error) {
        lastError = error;
        if (error.name === 'AbortError') {
          lastError = new HiveMindError('Request timeout', 408);
        }
        if (attempt < this.retries - 1) {
          await this._sleep(DEFAULT_OPTIONS.retryDelay * (attempt + 1));
        }
      }
    }

    throw lastError;
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Save a memory to HIVE-MIND
   * @param {Object} memory - Memory to save
   * @param {string} memory.title - Memory title
   * @param {string} memory.content - Memory content
   * @param {string} [memory.sourceType='text'] - Type: 'text', 'code', 'conversation'
   * @param {string[]} [memory.tags=[]] - Tags for categorization
   * @param {string} [memory.project] - Project name
   * @param {Object} [memory.metadata] - Additional metadata
   * @param {string} [memory.userId] - User ID (uses default if not provided)
   * @param {string} [memory.orgId] - Org ID (uses default if not provided)
   * @returns {Promise<Object>} Saved memory with ID
   */
  async save(memory) {
    const body = {
      title: memory.title,
      content: memory.content,
      source_type: memory.sourceType || memory.source_type || 'text',
      user_id: memory.userId || memory.user_id || this.defaultUserId,
      org_id: memory.orgId || memory.org_id || this.defaultOrgId,
      tags: memory.tags || [],
      project: memory.project,
      metadata: memory.metadata || {},
    };

    return this._request('/api/memories', {
      method: 'POST',
      body,
    });
  }

  /**
   * Save a code snippet
   * @param {Object} code - Code to save
   * @param {string} code.content - Code content
   * @param {string} code.filepath - File path
   * @param {string} [code.language] - Programming language
   * @param {string} [code.title] - Title (defaults to filepath)
   * @param {string[]} [code.tags=['code']] - Tags
   * @returns {Promise<Object>} Saved code memory
   */
  async saveCode(code) {
    return this.save({
      title: code.title || code.filepath,
      content: code.content,
      sourceType: 'code',
      tags: [...(code.tags || []), 'code'],
      metadata: {
        filepath: code.filepath,
        language: code.language,
      },
    });
  }

  /**
   * Save a conversation
   * @param {Object} conversation - Conversation to save
   * @param {string} conversation.title - Conversation title
   * @param {Array} conversation.messages - Array of {role, content, timestamp}
   * @param {string} [conversation.platform='generic'] - Platform (claude, cursor, etc)
   * @param {string[]} [conversation.tags=['conversation']] - Tags
   * @returns {Promise<Object>} Saved conversation
   */
  async saveConversation(conversation) {
    const content = typeof conversation.messages === 'string'
      ? conversation.messages
      : JSON.stringify(conversation.messages, null, 2);

    return this.save({
      title: conversation.title,
      content,
      sourceType: 'conversation',
      tags: [...(conversation.tags || []), 'conversation', conversation.platform || 'generic'],
      metadata: {
        platform: conversation.platform || 'generic',
        message_count: conversation.messages?.length || 0,
      },
    });
  }

  /**
   * Search memories
   * @param {string} query - Search query
   * @param {Object} [options] - Search options
   * @param {number} [options.limit=10] - Max results
   * @param {string} [options.project] - Filter by project
   * @param {string[]} [options.tags] - Filter by tags
   * @param {string} [options.userId] - Filter by user
   * @returns {Promise<Array>} Search results
   */
  async search(query, options = {}) {
    const params = new URLSearchParams();
    params.append('query', query);
    if (options.limit) params.append('limit', options.limit);
    if (options.project) params.append('project', options.project);
    if (options.tags) params.append('tags', options.tags.join(','));
    if (options.userId || this.defaultUserId) {
      params.append('user_id', options.userId || this.defaultUserId);
    }

    const result = await this._request(`/api/search?${params.toString()}`);
    return result.memories || result.results || [];
  }

  /**
   * Query memories with AI (semantic search)
   * @param {string} question - Natural language question
   * @param {Object} [options] - Query options
   * @param {number} [options.limit=5] - Number of memories to retrieve
   * @returns {Promise<Object>} Query result with answer
   */
  async query(question, options = {}) {
    const body = {
      query: question,
      user_id: options.userId || this.defaultUserId,
      org_id: options.orgId || this.defaultOrgId,
      limit: options.limit || 5,
    };

    return this._request('/api/memories/query', {
      method: 'POST',
      body,
    });
  }

  /**
   * Get a memory by ID
   * @param {string} memoryId - Memory ID
   * @returns {Promise<Object>} Memory object
   */
  async get(memoryId) {
    return this._request(`/api/memories/${memoryId}`);
  }

  /**
   * Update a memory
   * @param {string} memoryId - Memory ID
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>} Updated memory
   */
  async update(memoryId, updates) {
    return this._request(`/api/memories/${memoryId}`, {
      method: 'PUT',
      body: updates,
    });
  }

  /**
   * Delete a memory
   * @param {string} memoryId - Memory ID
   * @returns {Promise<void>}
   */
  async delete(memoryId) {
    return this._request(`/api/memories/${memoryId}`, {
      method: 'DELETE',
    });
  }

  /**
   * List all memories with pagination
   * @param {Object} [options] - List options
   * @param {number} [options.page=1] - Page number
   * @param {number} [options.limit=20] - Items per page
   * @param {string} [options.project] - Filter by project
   * @returns {Promise<Object>} Paginated results
   */
  async list(options = {}) {
    const params = new URLSearchParams();
    if (options.page) params.append('page', options.page);
    if (options.limit) params.append('limit', options.limit);
    if (options.project) params.append('project', options.project);
    if (this.defaultUserId) params.append('user_id', this.defaultUserId);

    return this._request(`/api/memories?${params.toString()}`);
  }

  /**
   * Check API health
   * @returns {Promise<Object>} Health status
   */
  async health() {
    return this._request('/health');
  }

  /**
   * Get ingestion job status
   * @param {string} jobId - Job ID
   * @returns {Promise<Object>} Job status
   */
  async getJobStatus(jobId) {
    return this._request(`/api/ingestion/jobs/${jobId}`);
  }

  /**
   * Bulk save multiple memories
   * @param {Array} memories - Array of memory objects
   * @returns {Promise<Array>} Saved memories
   */
  async bulkSave(memories) {
    return Promise.all(memories.map(m => this.save(m)));
  }
}

/**
 * Custom error class for HIVE-MIND errors
 */
export class HiveMindError extends Error {
  constructor(message, statusCode, response) {
    super(message);
    this.name = 'HiveMindError';
    this.statusCode = statusCode;
    this.response = response;
  }
}

// Default export
export default HiveMindClient;
