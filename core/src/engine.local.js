/**
 * HIVE-MIND Core Memory Engine (Local/In-Memory)
 * Graph-based memory with Updates, Extends, Derives triple-operator logic
 * Integrated with Qdrant for vector storage and Mistral AI for embeddings
 */

import { v4 as uuidv4 } from 'uuid';
import { getSituationalizer, ContextualPipeline } from './situationalizer.js';
import { getMistralEmbedService } from './embeddings/mistral.js';
import { getQdrantClient } from './vector/qdrant-client.js';
import { getSyntaxChunker } from './chunker.ast.js';
import { getNWSCalculator } from './ast/density.js';
import { getStateMutator } from './stateful/mutator.js';
import { getConflictResolver, resolveMemoryConflicts } from './stateful/resolver.js';

// Simple logger fallback for local engine
const logger = {
  info: (msg, data) => console.log(`[INFO] ${msg}`, data || ''),
  warn: (msg, data) => console.warn(`[WARN] ${msg}`, data || ''),
  error: (msg, data) => console.error(`[ERROR] ${msg}`, data || ''),
  debug: (msg, data) => console.debug(`[DEBUG] ${msg}`, data || '')
};

/**
 * MemoryEngine - Core memory operations (local version)
 */
export class MemoryEngine {
  constructor({ situationalizer = null, embedService = null } = {}) {
    this.memories = new Map();
    this.relationships = [];

    // Initialize contextual pipeline components
    this.situationalizer = situationalizer || getSituationalizer();
    this.embedService = embedService || getMistralEmbedService();
    this.contextualPipeline = new ContextualPipeline(this.situationalizer);
    
    // Initialize Qdrant client for vector storage
    this.qdrantClient = getQdrantClient();

    // Initialize AST-aware chunker
    this.syntaxChunker = getSyntaxChunker();
    this.nwsCalculator = getNWSCalculator();

    // Initialize stateful memory components
    this.stateMutator = getStateMutator();
    this.conflictResolver = getConflictResolver();

    // Pipeline configuration
    this.pipelineConfig = {
      useSituationalizer: process.env.USE_SITUATIONALIZER !== 'false', // Default: true
      useContextualEmbedding: process.env.USE_CONTEXTUAL_EMBEDDING !== 'false', // Default: true
      useASTChunking: process.env.USE_AST_CHUNKING !== 'false', // Default: true
      useQdrantStorage: process.env.USE_QDRANT_STORAGE !== 'false', // Default: true
      maxDocumentSize: 5000,
      chunkSize: 1500,
      chunkOverlap: 100,
      minNwsDensity: 0.7 // Minimum NWS density for high-quality chunks
    };
  }

  _filterScopedMemories({ user_id, org_id, project } = {}) {
    let memories = Array.from(this.memories.values());

    if (user_id) {
      memories = memories.filter(memory => memory.user_id === user_id);
    }
    if (org_id) {
      memories = memories.filter(memory => memory.org_id === org_id);
    }
    if (project) {
      memories = memories.filter(memory => memory.project === project);
    }

    return memories;
  }

  _keywordScore(memory, query = '') {
    if (!query) return 0;
    const lowered = query.toLowerCase();
    const tokens = lowered.split(/\s+/).filter(Boolean);
    const haystacks = [
      memory.content || '',
      memory.project || '',
      memory.source || '',
      ...(memory.tags || []),
      ...this._getScopeChain(memory.metadata?.ast_metadata),
      memory.metadata?.ast_metadata?.signature || '',
      ...(memory.metadata?.ast_metadata?.imports || [])
    ].join(' ').toLowerCase();

    const directHit = haystacks.includes(lowered) ? 1 : 0;
    const tokenHits = tokens.filter(token => haystacks.includes(token)).length;
    return directHit * 2 + tokenHits;
  }

  _getScopeChain(astMetadata = {}) {
    if (Array.isArray(astMetadata?.scopeChain)) {
      return astMetadata.scopeChain;
    }
    if (typeof astMetadata?.scopeChain === 'string' && astMetadata.scopeChain.trim()) {
      return [astMetadata.scopeChain];
    }
    return [];
  }

  _sortByRelevance(memories, query) {
    return memories
      .map(memory => ({
        memory,
        score: this._keywordScore(memory, query)
      }))
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return new Date(right.memory.created_at) - new Date(left.memory.created_at);
      });
  }

  _findRelevantMemories({ query, user_id, org_id, project, include_all = false } = {}) {
    const scoped = this._filterScopedMemories({ user_id, org_id, project });
    const scored = this._sortByRelevance(scoped, query);
    const filtered = include_all ? scored : scored.filter(item => item.score > 0);
    return filtered.map(item => item.memory);
  }

  _getRelationshipsForMemory(memoryId, types = []) {
    return this.relationships.filter(relationship => {
      const matchesMemory = relationship.from_id === memoryId || relationship.to_id === memoryId;
      const matchesType = types.length === 0 || types.includes(relationship.type);
      return matchesMemory && matchesType;
    });
  }

  _getAdjacentMemoryIds(memoryId, relationshipTypes = []) {
    return this._getRelationshipsForMemory(memoryId, relationshipTypes).map(relationship =>
      relationship.from_id === memoryId ? relationship.to_id : relationship.from_id
    );
  }

  _buildVersionTimeline(memory) {
    const lineage = [memory];
    const visited = new Set([memory.id]);
    let current = memory;

    while (current) {
      const previousUpdate = this.relationships.find(relationship =>
        relationship.type === 'Updates' &&
        relationship.from_id === current.id &&
        !visited.has(relationship.to_id)
      );

      if (!previousUpdate) {
        break;
      }

      const previousMemory = this.memories.get(previousUpdate.to_id);
      if (!previousMemory) {
        break;
      }

      lineage.push(previousMemory);
      visited.add(previousMemory.id);
      current = previousMemory;
    }

    return lineage.sort((left, right) => new Date(left.created_at) - new Date(right.created_at));
  }

  _normalizeMemoryRecord({ content, user_id, org_id, project, tags = [], source, metadata = {}, document_date, event_dates }) {
    const now = new Date().toISOString();
    const sourceObject = typeof source === 'string' ? { type: source } : (source || {});
    const normalizedEventDates = Array.isArray(event_dates) ? event_dates : [];
    const eventTime = normalizedEventDates[0] || document_date || null;

    return {
      id: uuidv4(),
      content,
      user_id,
      org_id,
      project,
      tags,
      is_latest: true,
      strength: 1.0,
      recall_count: 0,
      last_confirmed: now,
      created_at: now,
      updated_at: now,
      record_time: now,
      event_time: eventTime,
      document_date: document_date || null,
      event_dates: normalizedEventDates,
      source: sourceObject.type || source || null,
      source_metadata: {
        source_type: sourceObject.type || 'manual',
        source_id: sourceObject.id || null,
        source_label: sourceObject.label || null,
        source_platform: sourceObject.platform || metadata.source_platform || null,
        source_url: sourceObject.url || metadata.original_url || null
      },
      metadata: metadata || {},
      version: 1
    };
  }

  /**
   * Store a new memory with triple-operator relationship support
   * Uses state mutator for automatic isLatest mutation
   * Automatically stores vector embedding in Qdrant
   */
  async storeMemory({ content, user_id, org_id, project, tags = [], source, metadata = {}, relationship, document_date, event_dates }) {
    const id = uuidv4();
    const now = new Date().toISOString();

    const memory = {
      id,
      content,
      user_id,
      org_id,
      project,
      tags,
      is_latest: true,
      strength: 1.0,
      recall_count: 0,
      last_confirmed: now,
      created_at: now,
      updated_at: now,
      document_date: document_date || null,
      event_dates: event_dates || [],
      source: source || null,
      metadata: metadata || {},
      version: 1
    };

    this.memories.set(id, memory);

    // Store in Qdrant for vector search
    if (this.pipelineConfig.useQdrantStorage && this.qdrantClient) {
      try {
        await this.qdrantClient.storeMemory(memory);
      } catch (error) {
        console.error('Failed to store in Qdrant:', error.message);
      }
    }

    // Handle relationship with state mutator
    if (relationship && relationship.target_id) {
      const rel = this.createRelationship({
        from_id: id,
        to_id: relationship.target_id,
        type: relationship.type,
        confidence: 1.0
      });

      // Use state mutator for automatic state mutation
      const oldMemory = this.memories.get(relationship.target_id);
      const mutation = this.stateMutator.applyMutation({
        relationship: { type: relationship.type, confidence: 1.0 },
        oldMemory,
        newMemory: memory,
        memories: this.memories
      });

      // Log mutation if it was successfully created
      if (mutation && mutation.type) {
        logger.info('State mutation applied', {
          type: mutation.type,
          changes: mutation.changes,
          timestamp: mutation.timestamp
        });
      }

      return { memory, relationships: [rel], mutation };
    }

    return { memory, relationships: [], mutation: null };
  }

  /**
   * Create relationship between memories
   */
  createRelationship({ from_id, to_id, type, confidence = 1.0, metadata = {} }) {
    const rel = {
      id: uuidv4(),
      from_id,
      to_id,
      type,
      confidence,
      created_at: new Date().toISOString(),
      metadata: metadata || {}
    };
    this.relationships.push(rel);
    return rel;
  }

  /**
   * Search memories with hybrid search (vector + keyword)
   * Uses Qdrant for vector similarity when available
   */
  async searchMemories({ query, user_id, org_id, n_results = 10, filter = {} }) {
    // Try Qdrant vector search first
    if (this.pipelineConfig.useQdrantStorage && this.qdrantClient && query) {
      try {
        const qdrantResults = await this.qdrantClient.hybridSearch(query, {
          user_id,
          org_id,
          project: filter.project,
          is_latest: filter.is_latest !== undefined ? filter.is_latest : true,
          limit: n_results,
          score_threshold: 0.5
        });

        if (qdrantResults && qdrantResults.length > 0) {
          // Convert Qdrant results to memory format
          return qdrantResults.map(result => ({
            ...result.payload,
            score: result.score,
            vector_match: true
          }));
        }
      } catch (error) {
        console.warn('Qdrant search failed, falling back to keyword search:', error.message);
      }
    }

    // Fallback to keyword search
    let results = Array.from(this.memories.values());

    if (user_id) {
      results = results.filter(m => m.user_id === user_id);
    }
    if (org_id) {
      results = results.filter(m => m.org_id === org_id);
    }
    if (filter.project) {
      results = results.filter(m => m.project === filter.project);
    }
    if (filter.is_latest !== undefined) {
      results = results.filter(m => m.is_latest === filter.is_latest);
    }

    if (query) {
      const q = query.toLowerCase();
      results = results.filter(m =>
        m.content.toLowerCase().includes(q) ||
        m.tags.some(t => t.toLowerCase().includes(q))
      );
    }

    // Simple scoring
    const scored = results.map(m => {
      let score = 0;
      if (query) {
        const q = query.toLowerCase();
        if (m.content.toLowerCase().includes(q)) score += 0.7;
        score += m.tags.some(t => t.toLowerCase().includes(q)) ? 0.3 : 0;
      }
      return { memory: m, score };
    });

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, n_results)
      .map(r => r.memory);
  }

  /**
   * Get memory by ID with relationships
   */
  getMemory(id) {
    const memory = this.memories.get(id);
    if (!memory) return null;

    const relationships = this.relationships.filter(r =>
      r.from_id === id || r.to_id === id
    );

    return { memory, relationships };
  }

  /**
   * Traverse graph from starting memory
   */
  traverse({ start_id, depth = 3, relationship_types = ['Updates', 'Extends', 'Derives'] }) {
    const visited = new Set();
    const queue = [{ id: start_id, depth: 0, path: [] }];
    const nodes = [];
    const edges = [];
    const allPaths = [];

    while (queue.length > 0) {
      const { id, depth: currentDepth, path } = queue.shift();
      if (visited.has(id) || currentDepth > depth) continue;
      visited.add(id);

      const memory = this.memories.get(id);
      if (memory) {
        nodes.push(memory);
        allPaths.push(path);
      }

      const related = this.relationships.filter(r =>
        (r.from_id === id || r.to_id === id) && relationship_types.includes(r.type)
      );

      for (const rel of related) {
        const otherId = rel.from_id === id ? rel.to_id : rel.from_id;
        edges.push(rel);
        if (!visited.has(otherId)) {
          queue.push({
            id: otherId,
            depth: currentDepth + 1,
            path: [...path, { memory, relationship: rel }]
          });
        }
      }
    }

    return { nodes, edges, paths: allPaths };
  }

  /**
   * Calculate memory decay using Ebbinghaus curve
   * Formula: P = e^(-t/s)
   */
  calculateDecay(memoryId) {
    const memory = this.memories.get(memoryId);
    if (!memory) return null;

    const now = new Date();
    const lastConfirmed = new Date(memory.last_confirmed);
    const t = (now - lastConfirmed) / (1000 * 60 * 60 * 24); // days
    const s = memory.strength * (1 + Math.log(memory.recall_count + 1));
    const probability = Math.exp(-t / s);
    const halfLife = s * Math.log(2);

    let status;
    if (probability > 0.3) status = 'active';
    else if (probability > 0.1) status = 'decaying';
    else status = 'forgotten';

    return { memory_id: memoryId, recall_probability: probability, status, half_life_days: halfLife };
  }

  /**
   * Reinforce memory on recall
   */
  reinforceMemory(memoryId) {
    const memory = this.memories.get(memoryId);
    if (!memory) return null;

    memory.strength = memory.strength * 1.1;
    memory.recall_count = memory.recall_count + 1;
    memory.last_confirmed = new Date().toISOString();
    memory.updated_at = memory.last_confirmed;

    return this.getMemory(memoryId);
  }

  /**
   * Auto-recall: Get relevant memories for context
   */
  /**
   * Auto-recall memories with vector search
   * Uses Qdrant for semantic similarity when available
   */
  async autoRecall({ query_context, user_id, max_memories = 5, weights = { similarity: 0.5, recency: 0.3, importance: 0.2 } }) {
    let topMemories = [];

    // Try Qdrant vector search first
    if (this.pipelineConfig.useQdrantStorage && this.qdrantClient) {
      try {
        const qdrantResults = await this.qdrantClient.hybridSearch(query_context, {
          user_id,
          is_latest: true,
          limit: max_memories,
          score_threshold: 0.5
        });

        if (qdrantResults && qdrantResults.length > 0) {
          topMemories = qdrantResults.map(result => ({
            memory: {
              ...result.payload,
              score: result.score,
              vector_match: true
            },
            score: result.score
          }));
        }
      } catch (error) {
        console.warn('Qdrant recall failed, falling back to keyword search:', error.message);
      }
    }

    // Fallback to keyword-based recall
    if (topMemories.length === 0) {
      const keywords = query_context.toLowerCase().split(/\s+/).filter(w => w.length > 3);

      let memories = Array.from(this.memories.values());
      if (user_id) {
        memories = memories.filter(m => m.user_id === user_id);
      }

      const scored = memories.map(memory => {
        const content = memory.content.toLowerCase();

        // Keyword matching score
        const keywordMatches = keywords.filter(k => content.includes(k)).length;
        const similarityScore = keywordMatches / Math.max(keywords.length, 1);

        // Recency score (decay over 30 days)
        const now = new Date().getTime();
        const created = new Date(memory.created_at).getTime();
        const daysAgo = (now - created) / (1000 * 60 * 60 * 24);
        const recencyScore = Math.exp(-daysAgo / 30);

        // Importance score
        const importanceScore = memory.strength;

        const weightedScore = (
          weights.similarity * similarityScore +
          weights.recency * recencyScore +
          weights.importance * importanceScore
        );

        return { memory, score: weightedScore };
      });

      topMemories = scored
        .sort((a, b) => b.score - a.score)
        .slice(0, max_memories)
        .map(s => ({ memory: s.memory, score: s.score }));
    }

    const injectionText = `<relevant-memories>\n${topMemories.map(m => `- ${m.memory.content}`).join('\n')}\n</relevant-memories>`;

    return { 
      memories: topMemories.map(m => m.memory), 
      injectionText,
      search_method: topMemories[0]?.memory.vector_match ? 'vector' : 'keyword'
    };
  }

  /**
   * Session end: Auto-capture decisions and lessons
   */
  sessionEndHook({ session_content, user_id, org_id }) {
    const decisionKeywords = ['decided', 'decision', 'chose', 'will use', 'going with', 'settled on', 'agreed to'];
    const lessonKeywords = ['lesson', 'learned', 'takeaway', 'important', 'remember', 'note that'];

    const sentences = session_content.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 10);
    const captured = [];

    for (const sentence of sentences) {
      const lower = sentence.toLowerCase();

      for (const keyword of decisionKeywords) {
        if (lower.includes(keyword)) {
          const result = this.storeMemory({
            content: `Decision: ${sentence}`,
            user_id,
            org_id,
            tags: ['decision', 'auto-captured'],
            metadata: { source: 'session_end_hook', keyword }
          });
          captured.push({ type: 'decision', ...result });
          break;
        }
      }

      for (const keyword of lessonKeywords) {
        if (lower.includes(keyword)) {
          const result = this.storeMemory({
            content: `Lesson: ${sentence}`,
            user_id,
            org_id,
            tags: ['lesson', 'auto-captured'],
            metadata: { source: 'session_end_hook', keyword }
          });
          captured.push({ type: 'lesson', ...result });
          break;
        }
      }
    }

    return { captured, count: captured.length };
  }

  // ==========================================
  // Contextual Retrieval Pipeline Methods
  // ==========================================

  /**
   * Chunk document into manageable pieces
   * Uses AST-aware chunking for code files, falls back to text-based for others
   * @param {string} content - Document content
   * @param {string} source - Document source
   * @returns {Array} Array of chunk objects
   */
  _chunkDocument({ content, source }) {
    // Detect if this is a code file based on source
    const isCodeFile = this._isCodeFile(source);

    if (isCodeFile && this.pipelineConfig.useASTChunking) {
      // Use AST-aware chunking for code files
      const language = this._detectLanguage(source);
      return this._chunkDocumentAST({ content, source, language });
    }

    // Fallback: standard text-based chunking
    return this._chunkDocumentText({ content, source });
  }

  /**
   * Check if file is a code file based on extension
   * @param {string} source - File source/path
   * @returns {boolean} True if code file
   */
  _isCodeFile(source) {
    if (!source) return false;
    const extensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.cs'];
    return extensions.some(ext => source.endsWith(ext));
  }

  /**
   * Detect language from file source
   * @param {string} source - File source/path
   * @returns {string} Language identifier
   */
  _detectLanguage(source) {
    if (!source) return 'javascript';

    const ext = source.split('.').pop().toLowerCase();

    const extMap = {
      js: 'javascript',
      mjs: 'javascript',
      cjs: 'javascript',
      ts: 'typescript',
      jsx: 'javascript',
      tsx: 'typescript',
      py: 'python',
      go: 'go',
      rs: 'rust',
      java: 'java',
      c: 'c',
      h: 'c',
      cpp: 'cpp',
      cc: 'cpp',
      cs: 'csharp'
    };

    return extMap[ext] || 'javascript';
  }

  /**
   * Chunk document using AST-aware algorithm
   * @param {Object} params
   * @param {string} params.content - Document content
   * @param {string} params.source - Document source
   * @param {string} params.language - Language identifier
   * @returns {Array} Array of chunk objects with AST metadata
   */
  _chunkDocumentAST({ content, source, language }) {
    const startTime = Date.now();
    const chunks = this.syntaxChunker.chunk(content, language);

    const latencyMs = Date.now() - startTime;
    logger.info('AST-aware chunking completed', {
      source,
      chunkCount: chunks.length,
      latencyMs,
      avgDensity: chunks.reduce((a, b) => a + b.nwsDensity, 0) / chunks.length
    });

    return chunks;
  }

  /**
   * Chunk document using text-based algorithm (fallback)
   * @param {Object} params
   * @param {string} params.content - Document content
   * @param {string} params.source - Document source
   * @returns {Array} Array of chunk objects
   */
  _chunkDocumentText({ content, source }) {
    const chunks = [];
    const chunkSize = this.pipelineConfig.chunkSize;
    const overlap = this.pipelineConfig.chunkOverlap;

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
   * Process document through contextual pipeline
   * Generates situational context and embeddings for document chunks
   * @param {Object} params
   * @param {string} params.content - Document content
   * @param {string} params.source - Document source
   * @param {string} params.userId - User ID
   * @param {string} params.orgId - Organization ID
   * @param {string} params.project - Project name
   * @param {Object} [params.metadata={}] - Additional metadata
   * @returns {Promise<Array>} Array of contextualized chunks with embeddings
   */
  async processDocumentWithContext({ content, source, userId, orgId, project, metadata = {} }) {
    if (!this.pipelineConfig.useSituationalizer) {
      // Fallback: process without situationalizer
      return this._processDocumentWithoutContext({ content, source, userId, orgId, project, metadata });
    }

    const startTime = Date.now();
    const chunks = this._chunkDocument({ content, source });

    // Generate situational context for each chunk
    const contextualizedChunks = await Promise.all(
      chunks.map((chunk, index) =>
        this.contextualPipeline.processChunk({
          chunk: chunk.text,
          fullDocument: content.substring(0, this.pipelineConfig.maxDocumentSize),
          source,
          chunkIndex: index
        })
      )
    );

    // Generate embeddings for contextualized text
    const textsToEmbed = contextualizedChunks.map(c => c.contextualizedText);
    const embeddingResult = await this.embedService.embedBatch(textsToEmbed);

    // Combine results with AST metadata
    const results = contextualizedChunks.map((chunk, index) => ({
      ...chunk,
      embedding: embeddingResult.embeddings[index],
      embeddingDimension: this.embedService.getModelInfo().dimension,
      userId,
      orgId,
      project,
      metadata: {
        ...metadata,
        chunkIndex: chunk.chunkIndex,
        source,
        contextGeneratedAt: new Date().toISOString(),
        pipeline: 'contextual',
        // Include AST metadata if available
        ast_metadata: this._extractASTMetadata(chunk, content, source)
      }
    }));

    const latencyMs = Date.now() - startTime;
    logger.info('Document processed through contextual pipeline', {
      source,
      chunkCount: chunks.length,
      latencyMs,
      embeddingDimension: this.embedService.getModelInfo().dimension
    });

    return results;
  }

  /**
   * Extract AST metadata for a chunk
   * @param {Object} chunk - Chunk object
   * @param {string} content - Source content
   * @param {string} source - File source
   * @returns {Object|null} AST metadata object or null
   */
  _extractASTMetadata(chunk, content, source) {
    if (!this._isCodeFile(source)) {
      return null;
    }

    try {
      const language = this._detectLanguage(source);
      const rootNode = this.syntaxChunker.astParser.parse(content, language);
      const scopes = this.syntaxChunker.scopeBuilder.buildAllScopes(rootNode, language);

      return {
        scopeChain: this.syntaxChunker._getScopeForChunk(chunk, scopes),
        signature: this.syntaxChunker._extractSignature(chunk, content, language),
        imports: this.syntaxChunker._extractImports(rootNode, content, language),
        docstrings: this.syntaxChunker._extractDocstrings(rootNode, chunk, language),
        nwsDensity: this.nwsCalculator.calculateChunkDensity(chunk).density,
        astNodeCount: this.syntaxChunker._countASTNodes(chunk, content, language)
      };
    } catch (error) {
      logger.warn('Failed to extract AST metadata', { source, error: error.message });
      return null;
    }
  }

  /**
   * Process document without situationalizer (fallback)
   * @param {Object} params
   * @param {string} params.content - Document content
   * @param {string} params.source - Document source
   * @param {string} params.userId - User ID
   * @param {string} params.orgId - Organization ID
   * @param {string} params.project - Project name
   * @param {Object} [params.metadata={}] - Additional metadata
   * @returns {Promise<Array>} Array of chunks with embeddings
   */
  async _processDocumentWithoutContext({ content, source, userId, orgId, project, metadata = {} }) {
    const chunks = this._chunkDocument({ content, source });
    const textsToEmbed = chunks.map(c => c.text);
    const embeddingResult = await this.embedService.embedBatch(textsToEmbed);

    return chunks.map((chunk, index) => ({
      ...chunk,
      embedding: embeddingResult.embeddings[index],
      embeddingDimension: this.embedService.getModelInfo().dimension,
      userId,
      orgId,
      project,
      metadata: {
        ...metadata,
        chunkIndex: chunk.chunkIndex,
        source,
        contextGeneratedAt: null,
        pipeline: 'standard',
        // Include AST metadata if available
        ast_metadata: this._extractASTMetadata(chunk, content, source)
      }
    }));
  }

  /**
   * Store memory with optional contextual processing
   * @param {Object} params
   * @param {string} params.content - Memory content
   * @param {string} params.user_id - User ID
   * @param {string} params.org_id - Organization ID
   * @param {string} params.project - Project name
   * @param {string[]} [params.tags=[]] - Tags
   * @param {string} [params.source] - Source
   * @param {Object} [params.metadata={}] - Metadata
   * @param {Object} [params.relationship] - Relationship
   * @param {string} [params.document_date] - Document date
   * @param {Array} [params.event_dates] - Event dates
   * @param {boolean} [params.useContextual=false] - Use contextual pipeline
   * @returns {Object} Stored memory and relationships
   */
  storeMemory({ content, user_id, org_id, project, tags = [], source, metadata = {}, relationship, document_date, event_dates, useContextual = false }) {
    // If using contextual pipeline, process document first
    if (useContextual && source) {
      return this._storeContextualMemory({
        content,
        user_id,
        org_id,
        project,
        tags,
        source,
        metadata,
        relationship,
        document_date,
        event_dates
      });
    }

    // Standard memory storage
    const memory = this._normalizeMemoryRecord({
      content,
      user_id,
      org_id,
      project,
      tags,
      source,
      metadata,
      document_date,
      event_dates
    });

    this.memories.set(memory.id, memory);

    // Handle relationship
    if (relationship && relationship.target_id) {
      const rel = this.createRelationship({
        from_id: memory.id,
        to_id: relationship.target_id,
        type: relationship.type,
        confidence: 1.0
      });

      const oldMemory = this.memories.get(relationship.target_id);
      const mutation = this.stateMutator.applyMutation({
        relationship: { type: relationship.type, confidence: 1.0 },
        oldMemory,
        newMemory: memory,
        memories: this.memories
      });

      return { memory, relationships: [rel], mutation };
    }

    return { memory, relationships: [], mutation: null };
  }

  /**
   * Store memory using contextual pipeline
   * @param {Object} params
   * @returns {Promise<Object>} Stored memories and relationships
   */
  async _storeContextualMemory({ content, user_id, org_id, project, tags, source, metadata, relationship, document_date, event_dates }) {
    // Process document through contextual pipeline
    const contextualizedChunks = await this.processDocumentWithContext({
      content,
      source,
      userId: user_id,
      orgId: org_id,
      project,
      metadata
    });

    // Store each chunk as a separate memory
    const storedMemories = [];
    const relationships = [];

    for (const chunk of contextualizedChunks) {
      const baseMemory = this._normalizeMemoryRecord({
        content: chunk.contextualizedText,
        user_id,
        org_id,
        project,
        tags: [...(tags || []), 'contextual'],
        source,
        document_date,
        event_dates,
        metadata: {
          ...chunk.metadata,
          originalChunk: chunk.chunk,
          context: chunk.context,
          chunkIndex: chunk.chunkIndex
        }
      });
      const memory = baseMemory;

      this.memories.set(memory.id, memory);
      storedMemories.push(memory);

      // Create relationship between chunks
      if (chunk.chunkIndex > 0) {
        const prevMemory = storedMemories[chunk.chunkIndex - 1];
        const rel = this.createRelationship({
          from_id: memory.id,
          to_id: prevMemory.id,
          type: 'Extends',
          confidence: 1.0
        });
        relationships.push(rel);
      }
    }

    // Handle relationship to existing memory
    if (relationship && relationship.target_id) {
      for (const memory of storedMemories) {
        const rel = this.createRelationship({
          from_id: memory.id,
          to_id: relationship.target_id,
          type: relationship.type,
          confidence: 1.0
        });
        relationships.push(rel);
      }

      const oldMemory = this.memories.get(relationship.target_id);
      this.stateMutator.applyMutation({
        relationship: { type: relationship.type, confidence: 1.0 },
        oldMemory,
        newMemory: storedMemories[0],
        memories: this.memories
      });
    }

    return { memories: storedMemories, relationships };
  }

  ingestCodeMemory({ content, filepath, language, user_id, org_id, project, tags = [], source_metadata = {}, metadata = {} }) {
    const source = filepath;
    const chunks = this._chunkDocument({ content, source });
    const memories = [];

    for (const chunk of chunks) {
      const astMetadata = this._extractASTMetadata(chunk, content, source);
      const memory = this._normalizeMemoryRecord({
        content: chunk.text,
        user_id,
        org_id,
        project,
        tags: [...new Set(['code', ...tags])],
        source,
        metadata: {
          ...metadata,
          filepath,
          language: language || this._detectLanguage(filepath),
          chunk_index: chunk.chunkIndex,
          chunk_start: chunk.start,
          chunk_end: chunk.end,
          source_metadata,
          ast_metadata: astMetadata
        }
      });
      memory.source_metadata = {
        ...memory.source_metadata,
        ...source_metadata
      };

      this.memories.set(memory.id, memory);
      memories.push(memory);
    }

    return {
      memories,
      indexed_files: [filepath],
      chunk_count: memories.length
    };
  }

  getCurrentStateSummary({ query, user_id, org_id, project, limit = 5 } = {}) {
    const activeMemories = this._filterScopedMemories({ user_id, org_id, project })
      .filter(memory => memory.is_latest);
    const matches = this._sortByRelevance(activeMemories, query)
      .slice(0, limit)
      .map(item => item.memory);

    return matches.map(memory => ({
      current: memory,
      history: this._buildVersionTimeline(memory)
    }));
  }

  searchByEventTime({ query, user_id, org_id, project, event_date, start_date, end_date, limit = 20 } = {}) {
    const scoped = this._filterScopedMemories({ user_id, org_id, project });
    const exactDate = event_date ? new Date(event_date) : null;
    const start = start_date ? new Date(start_date) : null;
    const end = end_date ? new Date(end_date) : null;

    const filtered = scoped.filter(memory => {
      const eventCandidates = [memory.event_time, memory.document_date, ...(memory.event_dates || [])]
        .filter(Boolean)
        .map(value => new Date(value));

      if (eventCandidates.length === 0) return false;

      return eventCandidates.some(eventTime => {
        if (exactDate) {
          return eventTime.toISOString().slice(0, 10) === exactDate.toISOString().slice(0, 10);
        }
        if (start && end) {
          return eventTime >= start && eventTime <= end;
        }
        if (start) {
          return eventTime >= start;
        }
        if (end) {
          return eventTime <= end;
        }
        return true;
      });
    });

    return this._sortByRelevance(filtered, query)
      .slice(0, limit)
      .map(item => item.memory);
  }

  searchRefinements({ query, root_memory_id, user_id, org_id, project } = {}) {
    const rootMemory = root_memory_id
      ? this.memories.get(root_memory_id)
      : this._findRelevantMemories({ query, user_id, org_id, project })[0];

    if (!rootMemory) {
      return null;
    }

    const refinementIds = this.relationships
      .filter(relationship => relationship.type === 'Extends' && relationship.to_id === rootMemory.id)
      .map(relationship => relationship.from_id);

    return {
      root: rootMemory,
      refinements: refinementIds.map(id => this.memories.get(id)).filter(Boolean)
    };
  }

  searchInferredConnections({ query, person, topic, user_id, org_id, project, depth = 2 } = {}) {
    const seedQuery = [person, topic, query].filter(Boolean).join(' ');
    const seeds = this._findRelevantMemories({ query: seedQuery, user_id, org_id, project });
    const connections = [];
    const seen = new Set();

    for (const seed of seeds) {
      const traversal = this.traverse({
        start_id: seed.id,
        depth,
        relationship_types: ['Derives', 'Extends', 'Updates']
      });

      for (const node of traversal.nodes) {
        if (node.id === seed.id || seen.has(node.id)) continue;
        seen.add(node.id);
        connections.push(node);
      }
    }

    return {
      seeds,
      connections: this._sortByRelevance(connections, seedQuery).map(item => item.memory)
    };
  }

  searchStructuralImplementation({ symbol, filepath, user_id, org_id, project, limit = 10 } = {}) {
    const scoped = this._filterScopedMemories({ user_id, org_id, project });
    const filtered = scoped.filter(memory => {
      const ast = memory.metadata?.ast_metadata;
      if (!ast) return false;
      const haystack = [
        ast.signature || '',
        ...this._getScopeChain(ast),
        ...(ast.imports || []),
        memory.source || ''
      ].join(' ').toLowerCase();
      const matchesSymbol = symbol ? haystack.includes(symbol.toLowerCase()) : true;
      const matchesPath = filepath ? (memory.source || '').includes(filepath) : true;
      return matchesSymbol && matchesPath;
    });

    return this._sortByRelevance(filtered, symbol || filepath)
      .slice(0, limit)
      .map(item => ({
        ...item.memory,
        scope_context: this._getScopeChain(item.memory.metadata?.ast_metadata),
        signature: item.memory.metadata?.ast_metadata?.signature || null
      }));
  }

  analyzeCodeImpact({ filepath, symbol, user_id, org_id, project, limit = 20 } = {}) {
    const scoped = this._filterScopedMemories({ user_id, org_id, project });
    const impacted = scoped.filter(memory => {
      const ast = memory.metadata?.ast_metadata;
      if (!ast) return false;
      const imports = ast.imports || [];
      const scopeChain = this._getScopeChain(ast);
      const signature = ast.signature || '';
      const source = memory.source || '';

      const hitsFile = filepath ? source.includes(filepath) || imports.some(item => item.includes(filepath)) : false;
      const hitsSymbol = symbol ? signature.toLowerCase().includes(symbol.toLowerCase()) || scopeChain.some(item => item.toLowerCase().includes(symbol.toLowerCase())) || imports.some(item => item.toLowerCase().includes(symbol.toLowerCase())) : false;

      return hitsFile || hitsSymbol;
    });

    return this._sortByRelevance(impacted, [filepath, symbol].filter(Boolean).join(' '))
      .slice(0, limit)
      .map(item => item.memory);
  }

  findEvidence({ query, user_id, org_id, project, source_type, limit = 10 } = {}) {
    const relevant = this._findRelevantMemories({ query, user_id, org_id, project })
      .filter(memory => !source_type || memory.source_metadata?.source_type === source_type)
      .slice(0, limit);

    return relevant.map(memory => ({
      memory,
      evidence: {
        source: memory.source,
        source_metadata: memory.source_metadata,
        record_time: memory.record_time,
        event_time: memory.event_time
      }
    }));
  }

  findCrossPlatformThread({ query, project, user_id, org_id, limit = 20 } = {}) {
    const relevant = this._findRelevantMemories({ query, user_id, org_id, project, include_all: true })
      .filter(memory => this._keywordScore(memory, query) > 0)
      .slice(0, limit);

    const grouped = relevant.reduce((accumulator, memory) => {
      const sourceType = memory.source_metadata?.source_type || memory.source || 'unknown';
      if (!accumulator[sourceType]) {
        accumulator[sourceType] = [];
      }
      accumulator[sourceType].push(memory);
      return accumulator;
    }, {});

    return {
      query,
      project: project || null,
      sources: grouped
    };
  }

  queryMemories({ pattern, user_id, org_id, project, ...params }) {
    switch (pattern) {
      case 'state_of_union':
        return this.getCurrentStateSummary({ user_id, org_id, project, ...params });
      case 'event_time':
        return this.searchByEventTime({ user_id, org_id, project, ...params });
      case 'refinement':
        return this.searchRefinements({ user_id, org_id, project, ...params });
      case 'inferred_connection':
        return this.searchInferredConnections({ user_id, org_id, project, ...params });
      case 'structural_implementation':
        return this.searchStructuralImplementation({ user_id, org_id, project, ...params });
      case 'impact_analysis':
        return this.analyzeCodeImpact({ user_id, org_id, project, ...params });
      case 'evidence':
        return this.findEvidence({ user_id, org_id, project, ...params });
      case 'cross_platform_thread':
        return this.findCrossPlatformThread({ user_id, org_id, project, ...params });
      default:
        throw new Error(`Unsupported query pattern: ${pattern}`);
    }
  }

  /**
   * Get contextual pipeline statistics
   * @returns {Object} Pipeline statistics
   */
  getPipelineStats() {
    return {
      situationalizer: this.situationalizer.getStats(),
      embedService: this.embedService.getUsageStats(),
      pipelineConfig: this.pipelineConfig
    };
  }

  /**
   * Get all memories
   */
  getAllMemories(user_id, org_id) {
    return Array.from(this.memories.values())
      .filter(m => (!user_id || m.user_id === user_id) && (!org_id || m.org_id === org_id))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  /**
   * Get stats
   */
  getStats(user_id, org_id) {
    const all = this.getAllMemories(user_id, org_id);
    const total = all.length;
    const active = all.filter(m => m.is_latest).length;
    const rels = this.relationships.filter(r => {
      const fromMem = this.memories.get(r.from_id);
      return fromMem && fromMem.user_id === user_id && fromMem.org_id === org_id;
    }).length;

    return {
      total_memories: total,
      active_memories: active,
      relationships: rels
    };
  }

  /**
   * Initialize/reset engine
   */
  reset() {
    this.memories.clear();
    this.relationships = [];
    this.situationalizer.clearCache();
    this.embedService.clearCache();
    this.syntaxChunker = getSyntaxChunker();
    this.nwsCalculator = getNWSCalculator();
  }

  /**
   * Get AST-aware chunking statistics
   * @returns {Object} AST chunking statistics
   */
  getASTStats() {
    return {
      useASTChunking: this.pipelineConfig.useASTChunking,
      minNwsDensity: this.pipelineConfig.minNwsDensity,
      chunkSize: this.pipelineConfig.chunkSize,
      overlap: this.pipelineConfig.chunkOverlap
    };
  }

  // ==========================================
  // STATEFUL MEMORY METHODS
  // ==========================================

  /**
   * Get version history for a memory
   * @param {string} memoryId - Memory ID
   * @returns {Array} Version history
   */
  getVersionHistory(memoryId) {
    return this.stateMutator.getVersionHistory(memoryId);
  }

  /**
   * Get state of a memory
   * @param {string} memoryId - Memory ID
   * @returns {Object|null} Memory state or null
   */
  getMemoryState(memoryId) {
    return this.stateMutator.getMemoryState(memoryId, this.memories);
  }

  /**
   * Get all memory versions
   * @param {string} memoryId - Memory ID
   * @returns {Array} All versions of the memory
   */
  getMemoryVersions(memoryId) {
    const history = this.stateMutator.getVersionHistory(memoryId);
    const memory = this.memories.get(memoryId);
    if (!memory) return [];

    return history.map((h, index) => ({
      version: index + 1,
      timestamp: h.timestamp,
      changes: h.changes,
      reason: h.reason,
      content: memory.content
    }));
  }

  /**
   * Resolve conflicts in memories
   * @param {Object} params
   * @param {string} [params.strategy='latest'] - Resolution strategy
   * @returns {Object} Resolution result
   */
  resolveConflicts({ strategy = 'latest' } = {}) {
    const memories = Array.from(this.memories.values());
    return resolveMemoryConflicts({ memories, strategy });
  }

  /**
   * Get state mutator statistics
   * @returns {Object} Mutator stats
   */
  getMutatorStats() {
    return this.stateMutator.getStats();
  }

  /**
   * Get conflict resolver statistics
   * @returns {Object} Resolver stats
   */
  getResolverStats() {
    return this.conflictResolver.getStats();
  }

  /**
   * Get all stateful memory stats
   * @param {string} user_id - User ID
   * @param {string} org_id - Organization ID
   * @returns {Object} Combined stats
   */
  getStatefulStats(user_id, org_id) {
    const all = this.getAllMemories(user_id, org_id);
    const total = all.length;
    const active = all.filter(m => m.is_latest).length;

    // Count relationships by type
    const rels = this.relationships.filter(r => {
      const fromMem = this.memories.get(r.from_id);
      return fromMem && fromMem.user_id === user_id && fromMem.org_id === org_id;
    });

    const updates = rels.filter(r => r.type === 'Updates').length;
    const extendsCount = rels.filter(r => r.type === 'Extends').length;
    const derives = rels.filter(r => r.type === 'Derives').length;

    // Count memories with version history
    const memoriesWithHistory = Array.from(this.memories.keys()).filter(id =>
      this.stateMutator.getVersionHistory(id).length > 0
    ).length;

    return {
      total_memories: total,
      active_memories: active,
      relationships: rels.length,
      updates,
      extends: extendsCount,
      derives,
      memories_with_history: memoriesWithHistory,
      mutator_stats: this.stateMutator.getStats(),
      resolver_stats: this.conflictResolver.getStats()
    };
  }

  /**
   * Get logger helper
   */
  get logger() {
    return logger;
  }
}

// Export for ES modules
export default MemoryEngine;
