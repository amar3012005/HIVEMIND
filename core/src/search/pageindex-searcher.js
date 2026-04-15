/**
 * PageIndex Searcher — Hierarchical + Semantic Hybrid Search
 *
 * Search flow:
 * 1. Try PageIndex lookup (50ms timeout) — fast, topic-scoped
 * 2. Parallel: Direct hybrid search (PostgreSQL + VectorDB) — fallback
 * 3. Fuse results — deduplicate, rank by combined score
 *
 * Never fails — gracefully degrades to direct hybrid if PageIndex unavailable.
 */

export class PageIndexSearcher {
  constructor({ prisma, vectorDB, logger = console }) {
    this.prisma = prisma;
    this.vectorDB = vectorDB;
    this.logger = logger;
    this.timeoutMs = 50; // 50ms timeout for PageIndex lookup
  }

  /**
   * Search with PageIndex + fallback to direct hybrid.
   * Never throws — always returns results (even if degraded).
   *
   * @param {string} query - User's search query
   * @param {object} options - { userId, orgId, project?, rootPath?, limit = 20 }
   * @returns {Promise<Array>} Search results with full memory data
   */
  async search(query, options = {}) {
    const { userId, orgId, project = null, rootPath = null, limit = 20 } = options;
    const startTime = Date.now();

    const effectiveRootPath = await this._resolveRootPath({ userId, project, rootPath });

    // Try PageIndex first (with timeout)
    const pageIndexPromise = this._searchPageIndex(query, { userId, orgId, project, rootPath: effectiveRootPath, limit })
      .then(results => ({ source: 'pageindex', results, error: null }))
      .catch(err => {
        this.logger.warn('[PageIndexSearcher] PageIndex failed, using fallback:', err.message);
        return { source: 'pageindex-failed', error: err.message, results: [] };
      });

    // Set timeout for PageIndex
    const pageIndexWithTimeout = Promise.race([
      pageIndexPromise,
      new Promise(resolve =>
        setTimeout(() => resolve({ source: 'pageindex-timeout', results: [], error: 'timeout' }), this.timeoutMs)
      ),
    ]);

    // Always run direct hybrid search in parallel (fallback)
    const directPromise = this._directHybridSearch(query, { userId, orgId, project, limit })
      .then(results => ({ source: 'direct-hybrid', results, error: null }))
      .catch(err => {
        this.logger.error('[PageIndexSearcher] Direct hybrid failed:', err.message);
        return { source: 'direct-failed', error: err.message, results: [] };
      });

    // Wait for both
    const [pageIndexResult, directResult] = await Promise.all([
      pageIndexWithTimeout,
      directPromise,
    ]);

    // Merge and deduplicate results
    const merged = this._mergeResults(pageIndexResult.results, directResult.results);

    this.logger.log(
      `[search] "${query}" → ${merged.length} results ` +
      `(PageIndex: ${pageIndexResult.source}, Direct: ${directResult.source}, ${Date.now() - startTime}ms)`
    );

    return merged;
  }

  /**
   * PageIndex-based search — fast hierarchical lookup.
   * @private
   */
  async _searchPageIndex(query, options) {
    const { userId, orgId, project, rootPath, limit } = options;

    // Check if PageIndex table exists (first-run safety)
    const tableExists = await this._checkPageIndexTableExists();
    if (!tableExists) {
      throw new Error('PageIndex table not initialized');
    }

    // 1. Keyword match on node labels, paths, AND summaries
    const where = {
      userId,
      deletedAt: null,
      ...(rootPath ? { path: { startsWith: rootPath } } : {}),
    };
    if (orgId) {
      // Some nodes may have orgId null from older data; keep them visible to the same user.
      where.OR = [
        { orgId },
        { orgId: null },
      ];
    }

    const keywordNodes = await this.prisma.pageIndexNode.findMany({
      where: {
        ...where,
        AND: [
          {
            OR: [
              { label: { contains: query, mode: 'insensitive' } },
              { path: { contains: query.toLowerCase() } },
              { summary: { contains: query, mode: 'insensitive' } },
            ],
          },
        ],
      },
      orderBy: { memoryCount: 'desc' },
      take: 10,
    });

    // 2. Collect memory IDs from matching nodes
    const memoryIdsFromPageIndex = new Set();
    for (const node of keywordNodes) {
      if (node.memoryIds && node.memoryIds.length > 0) {
        for (const id of node.memoryIds) {
          memoryIdsFromPageIndex.add(id);
        }
      }
    }

    if (memoryIdsFromPageIndex.size === 0) {
      return []; // No PageIndex matches
    }

    // 3. Fetch memories by ID
    const memories = await this.prisma.memory.findMany({
      where: {
        id: { in: [...memoryIdsFromPageIndex] },
        userId,
        ...(orgId ? { orgId } : {}),
        ...(project ? { project } : {}),
        deletedAt: null,
      },
      take: limit,
      orderBy: { createdAt: 'desc' },
    });

    // Add PageIndex score boost
    return memories.map(m => ({
      ...m,
      _pageIndexScore: 1.0,
      _source: 'pageindex',
    }));
  }

  /**
   * Direct hybrid search — PostgreSQL lexical + VectorDB semantic.
   * This is your EXISTING search logic — unchanged.
   * @private
   */
  async _directHybridSearch(query, options) {
    const { userId, orgId, project, limit } = options;

    // 1. PostgreSQL lexical search
    const lexicalResults = await this.prisma.memory.findMany({
      where: {
        userId,
        ...(orgId ? { orgId } : {}),
        ...(project ? { project } : {}),
        deletedAt: null,
        OR: [
          { content: { contains: query, mode: 'insensitive' } },
          { title: { contains: query, mode: 'insensitive' } },
          { tags: { has: query.toLowerCase() } },
        ],
      },
      take: Math.floor(limit / 2),
      orderBy: { createdAt: 'desc' },
    });

    // 2. VectorDB semantic search (Qdrant)
    let vectorResults = [];
    try {
      // Prefer the vector store's embedding pipeline to avoid dimension/provider mismatches.
      const queryEmbedding = this.vectorDB?.generateEmbedding
        ? await this.vectorDB.generateEmbedding(query)
        : await this._embedQuery(query);
      if (queryEmbedding) {
        vectorResults = await this._vectorSearch(queryEmbedding, {
          userId,
          orgId,
          project,
          limit: Math.floor(limit / 2),
        });
      }
    } catch (err) {
      this.logger.warn('[PageIndexSearcher] VectorDB search failed:', err.message);
      // Continue with lexical results only
    }

    // 3. Merge lexical + vector (deduplicate by ID)
    const seen = new Map();

    // Vector results first (higher priority for semantic match)
    for (const result of vectorResults) {
      const payload = result?.payload || null;
      const memoryId = payload?.memory_id || result?.id || null;
      if (!memoryId) continue;
      seen.set(memoryId, {
        id: memoryId,
        ...(payload || {}),
        // Keep these on the top-level for downstream compatibility.
        content: payload?.content,
        project: payload?.project,
        tags: payload?.tags,
        memoryType: payload?.memory_type,
        userId: payload?.user_id,
        orgId: payload?.org_id,
        createdAt: payload?.created_at ? new Date(payload.created_at) : undefined,
        _vectorScore: result.score || 0.5,
        _source: 'vectordb',
      });
    }

    // Lexical results (fill in gaps)
    for (const result of lexicalResults) {
      if (!seen.has(result.id)) {
        seen.set(result.id, {
          ...result,
          _lexicalScore: 1.0,
          _source: 'lexical',
        });
      }
    }

    return [...seen.values()];
  }

  /**
   * Merge PageIndex + direct results, deduplicate, rank.
   * @private
   */
  _mergeResults(pageIndexResults, directResults) {
    const seen = new Map();

    // PageIndex results first (boosted priority)
    for (const result of pageIndexResults) {
      seen.set(result.id, {
        ...result,
        _combinedScore: (result._pageIndexScore || 1.0) * 1.2, // 20% boost for PageIndex matches
      });
    }

    // Direct results (fill in gaps, or update score if already present)
    for (const result of directResults) {
      const existing = seen.get(result.id);
      if (existing) {
        // Already in PageIndex results — boost score further
        seen.set(result.id, {
          ...existing,
          _combinedScore: existing._combinedScore * 1.1, // 10% boost for appearing in both
        });
      } else {
        // New result from direct search
        seen.set(result.id, {
          ...result,
          _combinedScore: (result._vectorScore || result._lexicalScore || 0.5),
        });
      }
    }

    // Sort by combined score (descending)
    return [...seen.values()].sort((a, b) => b._combinedScore - a._combinedScore);
  }

  /**
   * Check if PageIndex table exists.
   * @private
   */
  async _checkPageIndexTableExists() {
    try {
      await this.prisma.$queryRaw`SELECT 1 FROM "PageIndexNode" LIMIT 1`;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Embed query for vector search.
   * @private
   */
  async _embedQuery(query) {
    // Use your existing embedding logic
    const embeddingModel = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';

    try {
      // If using OpenAI
      if (process.env.OPENAI_API_KEY) {
        const resp = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: embeddingModel,
            input: query,
          }),
        });

        if (resp.ok) {
          const data = await resp.json();
          return data.data[0]?.embedding || null;
        }
      }

      // If using Mistral
      if (process.env.MISTRAL_API_KEY) {
        const resp = await fetch('https://api.mistral.ai/v1/embeddings', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'mistral-embed',
            input: query,
          }),
        });

        if (resp.ok) {
          const data = await resp.json();
          return data.data[0]?.embedding || null;
        }
      }

      return null;
    } catch (err) {
      this.logger.warn('[PageIndexSearcher] Embedding failed:', err.message);
      return null;
    }
  }

  /**
   * Vector search wrapper with multi-tenant + project scoping.
   * Supports QdrantClient (searchMemories) and falls back gracefully.
   * @private
   */
  async _vectorSearch(queryEmbedding, options) {
    const { userId, orgId, project, limit } = options;

    // Prefer QdrantClient API used by the rest of the codebase.
    if (this.vectorDB?.searchMemories) {
      const must = [];
      if (userId) must.push({ key: 'user_id', match: { value: userId } });
      if (orgId) must.push({ key: 'org_id', match: { value: orgId } });
      if (project) must.push({ key: 'project', match: { value: project } });
      const filter = must.length > 0 ? { must } : undefined;

      return await this.vectorDB.searchMemories({
        vector: queryEmbedding,
        filter,
        limit,
      });
    }

    // Back-compat for older vector stores.
    if (this.vectorDB?.search) {
      return await this.vectorDB.search(queryEmbedding, { userId, orgId, project, limit });
    }

    return [];
  }

  /**
   * Resolve a PageIndex rootPath for project-scoped search.
   * Uses heuristics to support both current (`/hivemind/<slug(project)>`) and
   * future (`/hivemind/projects/<slug(project)>`) layouts.
   * @private
   */
  async _resolveRootPath({ userId, project, rootPath }) {
    if (rootPath && typeof rootPath === 'string') return rootPath;
    if (!project || typeof project !== 'string') return null;

    const slug = project
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!slug) return null;

    const candidates = [
      `/hivemind/projects/${slug}`,
      `/hivemind/${slug}`,
    ];

    for (const candidate of candidates) {
      try {
        const exists = await this.prisma.pageIndexNode.findFirst({
          where: { userId, deletedAt: null, path: { startsWith: candidate } },
          select: { id: true },
        });
        if (exists) return candidate;
      } catch {
        // ignore
      }
    }

    return null;
  }
}
