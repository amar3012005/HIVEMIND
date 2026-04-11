import crypto from 'node:crypto';
import { computeTokenSimilarity } from './conflict-detector.js';
import { normalizeRelationshipType } from './relationship-semantics.js';

function mapMemoryRecord(record) {
  if (!record) return null;

  const latestVersionMetadata = record.versions?.[0]?.metadata || {};
  const sourceMetadataPayload = record.sourceMetadata?.metadata || {};
  const codeMetadataPayload = record.codeMetadata ? {
    ast_metadata: {
      scopeChain: record.codeMetadata.scopeChain,
      signature: record.codeMetadata.signatures?.[0] || null,
      imports: record.codeMetadata.imports || []
    },
    filepath: record.codeMetadata.filepath,
    language: record.codeMetadata.language
  } : {};

  return {
    id: record.id,
    user_id: record.userId,
    org_id: record.orgId,
    project: record.project,
    visibility: record.visibility,
    content: record.content,
    tags: record.tags || [],
    is_latest: record.isLatest,
    importance_score: record.importanceScore,
    supersedes_id: record.supersedesId,
    version: record.versions?.[0]?.version || 1,
    created_at: record.createdAt instanceof Date ? record.createdAt.toISOString() : record.createdAt,
    updated_at: record.updatedAt instanceof Date ? record.updatedAt.toISOString() : record.updatedAt,
    document_date: record.documentDate instanceof Date ? record.documentDate.toISOString() : record.documentDate,
    event_dates: (record.eventDates || []).map(value => value instanceof Date ? value.toISOString() : value),
    memory_type: record.memoryType,
    title: record.title,
    source: record.sourcePlatform,
    source_metadata: record.sourceMetadata ? {
      source_type: record.sourceMetadata.sourceType,
      source_id: record.sourceMetadata.sourceId,
      source_platform: record.sourceMetadata.sourcePlatform,
      source_url: record.sourceMetadata.sourceUrl,
      thread_id: record.sourceMetadata.threadId,
      parent_message_id: record.sourceMetadata.parentMessageId
    } : {
      source_type: record.sourcePlatform || 'manual',
      source_id: record.sourceMessageId || record.sourceSessionId || null,
      source_platform: record.sourcePlatform || null,
      source_url: record.sourceUrl || null
    },
    metadata: {
      ...latestVersionMetadata,
      ...sourceMetadataPayload,
      ...codeMetadataPayload
    }
  };
}

function mapRelationshipRecord(record) {
  return {
    id: record.id,
    from_id: record.fromId,
    to_id: record.toId,
    type: normalizeRelationshipType(record.type) || record.type,
    confidence: record.confidence,
    created_at: record.createdAt instanceof Date ? record.createdAt.toISOString() : record.createdAt,
    metadata: record.metadata || {}
  };
}

function scopedMemoryWhere({ user_id, org_id, project, scope = 'personal' }) {
  const base = {
    orgId: org_id,
    project: project || undefined,
    deletedAt: null,
  };

  if (scope === 'organization') {
    return {
      ...base,
      visibility: 'organization',
    };
  }

  if (scope === 'all') {
    return {
      ...base,
      OR: [
        { userId: user_id, visibility: 'private' },
        { visibility: 'organization' },
      ],
    };
  }

  return {
    ...base,
    userId: user_id,
  };
}

export class PrismaGraphStore {
  constructor(client, { inTransaction = false } = {}) {
    this.client = client;
    this.inTransaction = inTransaction;
  }

  async advisoryLock(userId, fn) {
    if (this.inTransaction) {
      await this.client.$executeRawUnsafe('SELECT acquire_memory_user_lock($1::uuid)', userId);
      return fn(this);
    }

    return this.client.$transaction(async tx => {
      await tx.$executeRawUnsafe('SELECT acquire_memory_user_lock($1::uuid)', userId);
      const scopedStore = new PrismaGraphStore(tx, { inTransaction: true });
      return fn(scopedStore);
    }, { timeout: 60000 });
  }

  async transaction(fn) {
    if (this.inTransaction) {
      return fn(this);
    }

    return this.client.$transaction(async tx => {
      return fn(new PrismaGraphStore(tx, { inTransaction: true }));
    }, { timeout: 60000 });
  }

  async createMemory(memory) {
    await this.client.memory.create({
      data: {
        id: memory.id,
        userId: memory.user_id,
        orgId: memory.org_id,
        visibility: memory.visibility || 'private',
        project: memory.project,
        content: memory.content,
        tags: memory.tags,
        isLatest: memory.is_latest,
        sourcePlatform: memory.source_metadata?.source_platform || null,
        sourceSessionId: memory.source_metadata?.source_session_id || null,
        sourceMessageId: memory.source_metadata?.source_id || null,
        sourceUrl: memory.source_metadata?.source_url || null,
        documentDate: memory.document_date ? new Date(memory.document_date) : null,
        eventDates: (memory.event_dates || []).map(value => new Date(value)),
        memoryType: memory.memory_type || 'fact',
        title: memory.title || null,
        importanceScore: memory.importance_score ?? 0.5,
        strength: memory.strength ?? 1.0,
        recallCount: memory.recall_count ?? 0,
        embeddingModel: memory.embedding_model || 'mistral-embed',
        embeddingVersion: memory.embedding_version ?? 1,
        processingBasis: memory.processing_basis || 'consent',
        sharedWithOrgs: memory.shared_with_orgs || [],
      },
    });

    if (memory.source_metadata || memory.metadata) {
      await this.createSourceMetadata({
        id: crypto.randomUUID(),
        memory_id: memory.id,
        source_type: memory.source_metadata?.source_type || 'manual',
        source_id: memory.source_metadata?.source_id || null,
        source_platform: memory.source_metadata?.source_platform || null,
        source_url: memory.source_metadata?.source_url || null,
        thread_id: memory.source_metadata?.thread_id || null,
        parent_message_id: memory.source_metadata?.parent_message_id || null,
        ingested_at: memory.created_at ? new Date(memory.created_at) : new Date(),
        metadata: memory.metadata || {}
      });
    }

    return this.getMemory(memory.id);
  }

  async updateMemory(id, patch) {
    // Build update data, accepting both camelCase (Prisma) and snake_case (legacy) field names
    const data = {};
    // isLatest: accept both patch.isLatest and patch.is_latest
    const isLatestVal = patch.isLatest ?? patch.is_latest;
    if (isLatestVal !== undefined) data.isLatest = isLatestVal;
    if (patch.updated_at) data.updatedAt = new Date(patch.updated_at);
    if (patch.project !== undefined) data.project = patch.project;
    if (patch.content !== undefined) data.content = patch.content;
    if (patch.tags !== undefined) data.tags = patch.tags;
    if (patch.source_metadata?.source_platform) data.sourcePlatform = patch.source_metadata.source_platform;
    if (patch.source_metadata?.source_id) data.sourceMessageId = patch.source_metadata.source_id;
    // CSI graph action fields — Turing uses these
    if (patch.importanceScore !== undefined) data.importanceScore = patch.importanceScore;
    if (patch.supersedesId !== undefined) data.supersedesId = patch.supersedesId;
    if (patch.memoryType !== undefined) data.memoryType = patch.memoryType;

    await this.client.memory.update({
      where: { id },
      data,
    });

    if (patch.source_metadata || patch.metadata) {
      await this.createSourceMetadata({
        id: crypto.randomUUID(),
        memory_id: id,
        source_type: patch.source_metadata?.source_type || 'manual',
        source_id: patch.source_metadata?.source_id || null,
        source_platform: patch.source_metadata?.source_platform || null,
        source_url: patch.source_metadata?.source_url || null,
        thread_id: patch.source_metadata?.thread_id || null,
        parent_message_id: patch.source_metadata?.parent_message_id || null,
        ingested_at: patch.updated_at,
        metadata: patch.metadata || {}
      });
    }

    return this.getMemory(id);
  }

  async getMemory(id) {
    const record = await this.client.memory.findUnique({
      where: { id },
      include: {
        sourceMetadata: true,
        codeMetadata: true,
        versions: {
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      }
    });

    return mapMemoryRecord(record);
  }

  async deleteMemory(id) {
    const deleted = await this.client.memory.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        isLatest: false,
        updatedAt: new Date()
      },
      include: {
        sourceMetadata: true,
        codeMetadata: true,
        versions: {
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      }
    });

    return mapMemoryRecord(deleted);
  }

  async listLatestMemories({ user_id, org_id, project, scope = 'personal' }) {
    const records = await this.client.memory.findMany({
      where: { ...scopedMemoryWhere({ user_id, org_id, project, scope }), isLatest: true },
      include: {
        sourceMetadata: true,
        codeMetadata: true,
        versions: {
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    return records.map(mapMemoryRecord);
  }

  async listMemories({ user_id, org_id, project, memory_type, tags, is_latest, limit = 50, offset = 0, scope = 'personal' }) {
    const records = await this.client.memory.findMany({
      where: {
        ...scopedMemoryWhere({ user_id, org_id, project, scope }),
        memoryType: memory_type || undefined,
        isLatest: typeof is_latest === 'boolean' ? is_latest : undefined,
        tags: tags?.length ? { hasEvery: tags } : undefined,
      },
      include: {
        sourceMetadata: true,
        codeMetadata: true,
        versions: {
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      },
      orderBy: { createdAt: 'desc' },
      skip: offset,
      take: limit
    });

    const total = await this.client.memory.count({
      where: {
        ...scopedMemoryWhere({ user_id, org_id, project }),
        memoryType: memory_type || undefined,
        isLatest: typeof is_latest === 'boolean' ? is_latest : undefined,
        tags: tags?.length ? { hasSome: tags } : undefined
      }
    });

    return {
      memories: records.map(mapMemoryRecord),
      total
    };
  }

  async searchMemories({ query, user_id, org_id, project, memory_type, tags, is_latest, n_results = 10, created_after, created_before, source_platform, scope = 'personal' }) {
    // Try PostgreSQL full-text search with stemming (like code-review-graph's FTS5 + Porter)
    // Only run outside transactions — $queryRawUnsafe corrupts Prisma interactive transactions
    if (query && this.client.$queryRawUnsafe && !this.inTransaction) {
      try {
        const tsQuery = query.trim().split(/\s+/).filter(w => w.length > 1).map(w => w + ':*').join(' & ');
        if (tsQuery) {
          const scopeWhere = scope === 'personal'
            ? `AND m.user_id = '${user_id}'::uuid`
            : `AND m.org_id = '${org_id}'::uuid`;
          const projectWhere = project ? `AND m.project = '${project}'` : '';
          const latestWhere = typeof is_latest === 'boolean' ? `AND m.is_latest = ${is_latest}` : '';
          const dateAfterWhere = created_after ? `AND m.created_at >= '${new Date(created_after).toISOString()}'` : '';
          const dateBeforeWhere = created_before ? `AND m.created_at <= '${new Date(created_before).toISOString()}'` : '';

          const ftsResults = await this.client.$queryRawUnsafe(`
            SELECT m.id, m.content, m.title, m.tags, m.memory_type, m.project,
                   m.importance_score, m.is_latest, m.created_at, m.updated_at,
                   m.document_date, m.event_dates, m.source, m.visibility,
                   ts_rank(to_tsvector('english', COALESCE(m.content, '') || ' ' || COALESCE(m.title, '')),
                           to_tsquery('english', $1)) as fts_score
            FROM memories m
            WHERE m.deleted_at IS NULL
              ${scopeWhere} ${projectWhere} ${latestWhere} ${dateAfterWhere} ${dateBeforeWhere}
              AND to_tsvector('english', COALESCE(m.content, '') || ' ' || COALESCE(m.title, ''))
                  @@ to_tsquery('english', $1)
            ORDER BY fts_score DESC
            LIMIT $2
          `, tsQuery, n_results * 3);

          if (ftsResults.length > 0) {
            return ftsResults.map(r => ({
              id: r.id,
              content: r.content,
              title: r.title,
              tags: r.tags || [],
              memory_type: r.memory_type,
              project: r.project,
              importance_score: Number(r.importance_score) || 0.5,
              is_latest: r.is_latest,
              created_at: r.created_at?.toISOString?.() || r.created_at,
              updated_at: r.updated_at?.toISOString?.() || r.updated_at,
              document_date: r.document_date?.toISOString?.() || r.document_date,
              source: r.source,
              visibility: r.visibility,
              score: Number(r.fts_score) || 0,
              _searchMethod: 'fts_tsvector',
            })).slice(0, n_results);
          }
        }
      } catch (ftsErr) {
        // FTS failed (query syntax, missing extension, etc.) — fall through to token similarity
      }
    }

    // Fallback: Prisma query + token similarity scoring
    const records = await this.client.memory.findMany({
      where: {
        ...scopedMemoryWhere({ user_id, org_id, project, scope }),
        memoryType: memory_type || undefined,
        sourcePlatform: source_platform || undefined,
        isLatest: typeof is_latest === 'boolean' ? is_latest : undefined,
        tags: tags?.length ? { hasEvery: tags } : undefined,
        createdAt: {
          gte: created_after ? new Date(created_after) : undefined,
          lte: created_before ? new Date(created_before) : undefined
        }
      },
      include: {
        sourceMetadata: true,
        codeMetadata: true,
        versions: {
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      },
      take: Math.max(n_results * 10, 50),
      orderBy: { createdAt: 'desc' }
    });

    return records
      .map(record => {
        const memory = mapMemoryRecord(record);
        return {
          ...memory,
          score: query ? computeTokenSimilarity(query, memory.content) : 1,
          _searchMethod: 'token_similarity',
        };
      })
      .filter(result => !query || result.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, n_results);
  }

  async listRelationships({ user_id, org_id, project, relationship_types, limit = 2000, scope = 'personal' }) {
    const normalizedTypes = relationship_types?.length
      ? relationship_types.map(type => normalizeRelationshipType(type) || type)
      : null;
    const records = await this.client.relationship.findMany({
      where: {
        type: normalizedTypes?.length ? { in: normalizedTypes } : undefined,
        fromMemory: scopedMemoryWhere({ user_id, org_id, project, scope }),
        toMemory: scopedMemoryWhere({ user_id, org_id, project, scope })
      },
      orderBy: { createdAt: 'desc' },
      take: limit
    });

    return records.map(mapRelationshipRecord);
  }

  async getRelatedMemories(memoryId, { maxDepth = 2, minConfidence = 0, user_id, org_id, project, scope = 'personal' } = {}) {
    const visitedMemoryIds = new Set([memoryId]);
    const visitedEdgeIds = new Set();
    const collected = [];
    let frontier = new Set([memoryId]);

    for (let depth = 0; depth < maxDepth && frontier.size > 0; depth += 1) {
      const frontierIds = Array.from(frontier);

      const records = await this.client.relationship.findMany({
        where: {
          confidence: { gte: minConfidence },
          OR: [
            { fromId: { in: frontierIds } },
            { toId: { in: frontierIds } }
          ],
          fromMemory: scopedMemoryWhere({ user_id, org_id, project, scope }),
          toMemory: scopedMemoryWhere({ user_id, org_id, project, scope })
        },
        orderBy: { createdAt: 'desc' }
      });

      const nextFrontier = new Set();

      for (const record of records) {
        if (visitedEdgeIds.has(record.id)) {
          continue;
        }

        visitedEdgeIds.add(record.id);
        const mapped = mapRelationshipRecord(record);
        collected.push(mapped);

        if (!visitedMemoryIds.has(record.fromId)) {
          visitedMemoryIds.add(record.fromId);
          nextFrontier.add(record.fromId);
        }

        if (!visitedMemoryIds.has(record.toId)) {
          visitedMemoryIds.add(record.toId);
          nextFrontier.add(record.toId);
        }
      }

      frontier = nextFrontier;
    }

    return collected;
  }

  async getRelationships(memoryId, type = null) {
    const where = {
      OR: [{ fromId: memoryId }, { toId: memoryId }],
    };
    if (type) where.type = normalizeRelationshipType(type) || type;
    const records = await this.client.relationship.findMany({ where });
    return records.map(mapRelationshipRecord);
  }

  async createRelationship(edge) {
    const created = await this.client.relationship.create({
      data: {
        id: edge.id,
        fromId: edge.from_id,
        toId: edge.to_id,
        type: normalizeRelationshipType(edge.type) || edge.type,
        confidence: edge.confidence,
        metadata: edge.metadata || {},
        createdBy: edge.created_by || 'system'
      }
    });

    return mapRelationshipRecord(created);
  }

  async createMemoryVersion(version) {
    return this.client.memoryVersion.create({
      data: {
        id: version.id,
        memoryId: version.memory_id,
        version: version.version,
        contentHash: version.content_hash,
        isLatest: version.is_latest,
        reason: version.reason,
        relatedMemoryId: version.related_memory_id || null,
        metadata: version.metadata || {},
        createdAt: version.created_at ? new Date(version.created_at) : undefined
      }
    });
  }

  async createSourceMetadata(source) {
    return this.client.sourceMetadata.upsert({
      where: { memoryId: source.memory_id },
      update: {
        sourceType: source.source_type,
        sourceId: source.source_id,
        sourcePlatform: source.source_platform,
        sourceUrl: source.source_url,
        threadId: source.thread_id,
        parentMessageId: source.parent_message_id,
        metadata: source.metadata || {}
      },
      create: {
        id: source.id,
        memoryId: source.memory_id,
        sourceType: source.source_type,
        sourceId: source.source_id,
        sourcePlatform: source.source_platform,
        sourceUrl: source.source_url,
        threadId: source.thread_id,
        parentMessageId: source.parent_message_id,
        metadata: source.metadata || {},
        ingestedAt: source.ingested_at ? new Date(source.ingested_at) : undefined
      }
    });
  }

  async createCodeMetadata(metadata) {
    return this.client.codeMemoryMetadata.upsert({
      where: { memoryId: metadata.memory_id },
      update: {
        filepath: metadata.filepath,
        language: metadata.language,
        entityType: metadata.entity_type || null,
        entityName: metadata.entity_name || null,
        startLine: metadata.start_line || null,
        endLine: metadata.end_line || null,
        scopeChain: metadata.scope_chain || [],
        signatures: metadata.signatures || [],
        imports: metadata.imports || [],
        dependencies: metadata.dependencies || [],
        nwsCount: metadata.nws_count || 0,
        metadata: metadata.metadata || {}
      },
      create: {
        id: metadata.id,
        memoryId: metadata.memory_id,
        filepath: metadata.filepath,
        language: metadata.language,
        entityType: metadata.entity_type || null,
        entityName: metadata.entity_name || null,
        startLine: metadata.start_line || null,
        endLine: metadata.end_line || null,
        scopeChain: metadata.scope_chain || [],
        signatures: metadata.signatures || [],
        imports: metadata.imports || [],
        dependencies: metadata.dependencies || [],
        nwsCount: metadata.nws_count || 0,
        metadata: metadata.metadata || {}
      }
    });
  }

  async enqueueDerivationJob(job) {
    return this.client.derivationJob.create({
      data: {
        id: job.id,
        sourceMemoryId: job.source_memory_id,
        targetMemoryId: job.target_memory_id,
        confidence: job.confidence,
        status: job.status || 'queued',
        metadata: job.metadata || {},
        createdAt: job.created_at ? new Date(job.created_at) : undefined
      }
    });
  }
}
