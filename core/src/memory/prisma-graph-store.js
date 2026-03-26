import { computeTokenSimilarity } from './conflict-detector.js';

function mapMemoryRecord(record) {
  if (!record) return null;

  return {
    id: record.id,
    user_id: record.userId,
    org_id: record.orgId,
    project: record.project,
    content: record.content,
    tags: record.tags || [],
    is_latest: record.isLatest,
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
      ...(record.codeMetadata ? {
        ast_metadata: {
          scopeChain: record.codeMetadata.scopeChain,
          signature: record.codeMetadata.signatures?.[0] || null,
          imports: record.codeMetadata.imports || []
        },
        filepath: record.codeMetadata.filepath,
        language: record.codeMetadata.language
      } : {})
    }
  };
}

function mapRelationshipRecord(record) {
  return {
    id: record.id,
    from_id: record.fromId,
    to_id: record.toId,
    type: record.type,
    confidence: record.confidence,
    created_at: record.createdAt instanceof Date ? record.createdAt.toISOString() : record.createdAt,
    metadata: record.metadata || {}
  };
}

function scopedMemoryWhere({ user_id, org_id, project }) {
  return {
    userId: user_id,
    orgId: org_id,
    project: project || undefined,
    deletedAt: null
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
    });
  }

  async transaction(fn) {
    if (this.inTransaction) {
      return fn(this);
    }

    return this.client.$transaction(async tx => {
      return fn(new PrismaGraphStore(tx, { inTransaction: true }));
    });
  }

  async createMemory(memory) {
    const created = await this.client.memory.create({
      data: {
        id: memory.id,
        userId: memory.user_id,
        orgId: memory.org_id,
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
        title: memory.title || null
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

    return mapMemoryRecord(created);
  }

  async updateMemory(id, patch) {
    const updated = await this.client.memory.update({
      where: { id },
      data: {
        isLatest: patch.is_latest,
        updatedAt: patch.updated_at ? new Date(patch.updated_at) : undefined,
        project: patch.project,
        content: patch.content,
        tags: patch.tags,
        sourcePlatform: patch.source_metadata?.source_platform,
        sourceMessageId: patch.source_metadata?.source_id
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

    return mapMemoryRecord(updated);
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

  async listLatestMemories({ user_id, org_id, project }) {
    const records = await this.client.memory.findMany({
      where: { ...scopedMemoryWhere({ user_id, org_id, project }), isLatest: true },
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

  async listMemories({ user_id, org_id, project, memory_type, tags, is_latest, limit = 50, offset = 0 }) {
    const records = await this.client.memory.findMany({
      where: {
        ...scopedMemoryWhere({ user_id, org_id, project }),
        memoryType: memory_type || undefined,
        isLatest: typeof is_latest === 'boolean' ? is_latest : undefined,
        tags: tags?.length ? { hasSome: tags } : undefined,
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

  async searchMemories({ query, user_id, org_id, project, memory_type, tags, is_latest, n_results = 10, created_after, created_before, source_platform }) {
    const records = await this.client.memory.findMany({
      where: {
        ...scopedMemoryWhere({ user_id, org_id, project }),
        memoryType: memory_type || undefined,
        sourcePlatform: source_platform || undefined,
        isLatest: typeof is_latest === 'boolean' ? is_latest : undefined,
        tags: tags?.length ? { hasSome: tags } : undefined,
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
          score: query ? computeTokenSimilarity(query, memory.content) : 1
        };
      })
      .filter(result => !query || result.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, n_results);
  }

  async listRelationships({ user_id, org_id, project, relationship_types, limit = 2000 }) {
    const records = await this.client.relationship.findMany({
      where: {
        type: relationship_types?.length ? { in: relationship_types } : undefined,
        fromMemory: scopedMemoryWhere({ user_id, org_id, project }),
        toMemory: scopedMemoryWhere({ user_id, org_id, project })
      },
      orderBy: { createdAt: 'desc' },
      take: limit
    });

    return records.map(mapRelationshipRecord);
  }

  async getRelatedMemories(memoryId, { maxDepth = 2, minConfidence = 0 } = {}) {
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
          fromMemory: { deletedAt: null },
          toMemory: { deletedAt: null }
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

  async createRelationship(edge) {
    const created = await this.client.relationship.create({
      data: {
        id: edge.id,
        fromId: edge.from_id,
        toId: edge.to_id,
        type: edge.type,
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
