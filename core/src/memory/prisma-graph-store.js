import crypto from 'node:crypto';
import { computeTokenSimilarity } from './conflict-detector.js';
import { normalizeRelationshipType } from './relationship-semantics.js';

/**
 * Strip null bytes (\u0000) from strings — Postgres text columns reject them (code 22P05).
 * Common in web-scraped content from DuckDuckGo, PDF extracts, and LLM outputs.
 */
// Allowed Prisma MemoryType enum values. Keep in sync with schema.prisma.
const VALID_MEMORY_TYPES = new Set([
  'fact', 'preference', 'decision', 'lesson', 'goal',
  'event', 'relationship', 'synthesis', 'summary',
]);
// Common english synonyms LLMs emit. Map back to a valid enum value so
// the save never fails with "Invalid value for argument memoryType".
const MEMORY_TYPE_ALIAS = {
  note: 'fact', observation: 'fact', idea: 'fact', knowledge: 'fact',
  context: 'fact', insight: 'lesson', learning: 'lesson',
  todo: 'goal', task: 'goal', reminder: 'goal',
  contact: 'relationship', person: 'relationship', user: 'relationship',
  meeting: 'event', appointment: 'event', deadline: 'event',
};
function coerceMemoryType(value) {
  if (!value) return 'fact';
  const v = String(value).toLowerCase().trim();
  if (VALID_MEMORY_TYPES.has(v)) return v;
  if (MEMORY_TYPE_ALIAS[v]) return MEMORY_TYPE_ALIAS[v];
  return 'fact';
}

function stripNullBytes(val) {
  if (typeof val === 'string') {
    // Strip null bytes AND other invalid UTF-8 sequences (cause 22021 Postgres errors + garbled streaming)
    return val.replace(/\u0000/g, '').replace(/[\uFFFD]/g, '');
  }
  if (Array.isArray(val)) return val.map(stripNullBytes);
  if (val instanceof Date) return val;
  if (val && typeof val === 'object') {
    const out = {};
    for (const k of Object.keys(val)) out[k] = stripNullBytes(val[k]);
    return out;
  }
  return val;
}

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
    scope: record.scope || 'personal',
    primary_team_id: record.primaryTeamId || null,
    project_ids: Array.isArray(record.memoryProjects)
      ? record.memoryProjects.map(mp => mp.projectId)
      : undefined,
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

function scopedMemoryWhere({ user_id, org_id, project, scope = 'personal', access_context = null }) {
  const base = {
    orgId: org_id,
    project: project || undefined,
    deletedAt: null,
  };

  // V2 path: caller supplies the user's accessible team/project IDs from
  // TeamStore. Build a multi-tier OR clause that respects Memory.scope.
  if (access_context && (access_context.projectIds || access_context.teamIds)) {
    const projectIds = Array.isArray(access_context.projectIds) ? access_context.projectIds : [];
    const teamIds = Array.isArray(access_context.teamIds) ? access_context.teamIds : [];
    const tiers = [
      { userId: user_id, scope: 'personal' },
      { scope: 'organization', orgId: org_id },
    ];
    if (projectIds.length > 0) {
      tiers.push({ scope: 'project', memoryProjects: { some: { projectId: { in: projectIds } } } });
    }
    if (teamIds.length > 0) {
      tiers.push({ scope: 'team', primaryTeamId: { in: teamIds } });
    }
    return { ...base, OR: tiers };
  }

  // Legacy paths preserved
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
    // Strip null bytes (\u0000) — common in web-scraped content, rejected by Postgres text columns
    const content = stripNullBytes(memory.content);
    const title = stripNullBytes(memory.title) || null;
    const metadata = stripNullBytes(memory.metadata);
    await this.client.memory.create({
      data: {
        id: memory.id,
        userId: memory.user_id,
        orgId: memory.org_id,
        visibility: memory.visibility || 'private',
        scope: memory.scope || 'personal',
        primaryTeamId: memory.primary_team_id || null,
        project: memory.project,
        content,
        tags: memory.tags,
        isLatest: memory.is_latest,
        sourcePlatform: memory.source_metadata?.source_platform || null,
        sourceSessionId: memory.source_metadata?.source_session_id || null,
        sourceMessageId: memory.source_metadata?.source_id || null,
        sourceUrl: memory.source_metadata?.source_url || null,
        documentDate: memory.document_date ? new Date(memory.document_date) : null,
        eventDates: (memory.event_dates || []).map(value => new Date(value)),
        // Coerce memory_type to a valid MemoryType enum. LLM-driven callers
        // (ReAct agent tool calls, MCP save_memory from external Claude
        // sessions) often emit english-y synonyms like 'note' / 'observation'
        // / 'todo' that aren't in the Prisma enum. Map known synonyms,
        // fall back to 'fact' so the save never fails with
        // "Invalid value for argument memoryType. Expected MemoryType".
        memoryType: coerceMemoryType(memory.memory_type),
        title,
        importanceScore: memory.importance_score ?? 0.5,
        strength: memory.strength ?? 1.0,
        recallCount: memory.recall_count ?? 0,
        embeddingModel: memory.embedding_model || 'mistral-embed',
        embeddingVersion: memory.embedding_version ?? 1,
        processingBasis: memory.processing_basis || 'consent',
        sharedWithOrgs: memory.shared_with_orgs || [],
      },
    });

    // Link memory to projects (V2 Teams+Projects scope)
    if (Array.isArray(memory.project_ids) && memory.project_ids.length > 0) {
      await this.client.memoryProject.createMany({
        data: memory.project_ids.map(projectId => ({
          memoryId: memory.id,
          projectId,
          addedById: memory.user_id,
        })),
        skipDuplicates: true,
      });
    }

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
        metadata: metadata || {}
      });
    }

    return this.getMemory(memory.id);
  }

  async updateMemory(id, rawPatch) {
    // Strip null bytes from all string fields — web-scraped content contains \u0000
    const patch = stripNullBytes(rawPatch);
    const data = {};
    const isLatestVal = patch.isLatest ?? patch.is_latest;
    if (isLatestVal !== undefined) data.isLatest = isLatestVal;
    if (patch.updated_at) data.updatedAt = new Date(patch.updated_at);
    if (patch.project !== undefined) data.project = patch.project;
    if (patch.content !== undefined) data.content = patch.content;
    if (patch.tags !== undefined) data.tags = patch.tags;
    if (patch.source_metadata?.source_platform) data.sourcePlatform = patch.source_metadata.source_platform;
    if (patch.source_metadata?.source_id) data.sourceMessageId = patch.source_metadata.source_id;
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

  async listMemories({ user_id, org_id, project, memory_type, tags, is_latest, limit = 50, offset = 0, scope = 'personal', include_children = false }) {
    // Default behaviour (2026-05-21): hide auto-extracted child fact rows
    // from the flat list. They tag every legacy save with 'extracted-fact'
    // and have metadata.parent_memory_id pointing at the canonical parent.
    // Showing them bloats the list 6x and obscures the real graph. Pass
    // include_children=true (or the legacy tag filter) to opt back in.
    //
    // 2026-05-22: TARA voice sessions persist per-turn rows
    // ('tara-turn') and per-turn clinical insights ('tara-insight') so
    // the graph view can show the full conversational structure. These
    // would flood Memories.jsx — one card per turn × N turns × M
    // sessions. Same canonical exclusion pattern: hide from the flat
    // list, keep in the graph + recall pipeline. A single
    // 'tara-session-summary' memory per session anchors them on the
    // flat list and PartOf edges link the children.
    //
    // Postgres String[] columns don't support `{ tags: { not: { has } } }`
    // in Prisma — only top-level `NOT { tags: { has } }` works. So we
    // compose the exclusion as a sibling NOT clause on the where root.
    const HIDDEN_CHILD_TAGS = ['extracted-fact', 'tara-turn', 'tara-insight'];
    const childExclusion = include_children
      ? {}
      : { AND: HIDDEN_CHILD_TAGS.map(t => ({ NOT: { tags: { has: t } } })) };
    const baseWhere = {
      ...scopedMemoryWhere({ user_id, org_id, project, scope }),
      memoryType: memory_type || undefined,
      isLatest: typeof is_latest === 'boolean' ? is_latest : undefined,
      ...(tags?.length ? { tags: { hasEvery: tags } } : {}),
      ...childExclusion,
    };

    const records = await this.client.memory.findMany({
      where: baseWhere,
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

    // Count uses the same exclusion so pagination stays consistent.
    const countWhere = {
      ...scopedMemoryWhere({ user_id, org_id, project }),
      memoryType: memory_type || undefined,
      isLatest: typeof is_latest === 'boolean' ? is_latest : undefined,
      ...(tags?.length ? { tags: { hasSome: tags } } : {}),
      ...childExclusion,
    };

    const total = await this.client.memory.count({ where: countWhere });

    // Surface relationship structure so FE can show "linked to N" + a
    // preview list without an N+1 per row. One batched fetch covers
    // every memory in this page (typically ≤50). Each row gets:
    //   edges_out_count
    //   edges_in_count
    //   superseded_by  (id of newer memory if this row is is_latest=false)
    //   top_edges      (up to 4 outgoing edges with type + target id)
    const memoryIds = records.map(r => r.id);
    let edgeStats = new Map(); // id → { out, in, top: [], supersededBy }
    if (memoryIds.length > 0) {
      // Outgoing edges from these rows (this memory → others). Metadata
      // included so the FE can render shared_entities / reason chips.
      const outRels = await this.client.relationship.findMany({
        where: { fromId: { in: memoryIds } },
        select: { fromId: true, toId: true, type: true, confidence: true, createdBy: true, metadata: true },
        orderBy: [{ confidence: 'desc' }, { createdAt: 'desc' }],
      });
      // Incoming edges (others → this memory).
      const inRels = await this.client.relationship.findMany({
        where: { toId: { in: memoryIds } },
        select: { fromId: true, toId: true, type: true, confidence: true, createdBy: true, metadata: true },
        orderBy: [{ confidence: 'desc' }, { createdAt: 'desc' }],
      });
      for (const r of outRels) {
        let s = edgeStats.get(r.fromId);
        if (!s) { s = { out: 0, in: 0, top: [], supersededBy: null }; edgeStats.set(r.fromId, s); }
        s.out += 1;
        if (s.top.length < 4) {
          s.top.push({
            direction: 'out',
            target_id: r.toId,
            type: r.type,
            confidence: r.confidence,
            shared_entities: r.metadata?.shared_entities || null,
            reason: r.metadata?.reason || null,
          });
        }
        // Capture supersession: an Updates edge OUT means this row updated
        // something else (we are the newer one). The OLDER row's
        // supersededBy is filled by the IN loop below.
      }
      for (const r of inRels) {
        let s = edgeStats.get(r.toId);
        if (!s) { s = { out: 0, in: 0, top: [], supersededBy: null }; edgeStats.set(r.toId, s); }
        s.in += 1;
        if (r.type === 'Updates' && !s.supersededBy) {
          s.supersededBy = r.fromId; // the newer memory that replaced this row
        }
        if (s.top.length < 4) {
          s.top.push({
            direction: 'in',
            source_id: r.fromId,
            type: r.type,
            confidence: r.confidence,
            shared_entities: r.metadata?.shared_entities || null,
            reason: r.metadata?.reason || null,
          });
        }
      }
    }

    const memories = records.map(rec => {
      const mapped = mapMemoryRecord(rec);
      const stats = edgeStats.get(rec.id) || { out: 0, in: 0, top: [], supersededBy: null };
      mapped.edges_out_count = stats.out;
      mapped.edges_in_count = stats.in;
      mapped.superseded_by = stats.supersededBy;
      mapped.top_edges = stats.top;
      return mapped;
    });

    return {
      memories,
      total
    };
  }

  async searchMemories({ query, user_id, org_id, project, memory_type, tags, is_latest, n_results = 10, created_after, created_before, source_platform, scope = 'personal', access_context = null }) {
    // V2 (Teams + Projects) scope: skip FTS raw branch since it cannot easily
    // express the multi-tier OR; let Prisma findMany handle it below.
    if (access_context) {
      // intentional skip
    } else
    // Try PostgreSQL full-text search with stemming (like code-review-graph's FTS5 + Porter)
    // Only run outside transactions — $queryRawUnsafe corrupts Prisma interactive transactions
    if (query && this.client.$queryRawUnsafe && !this.inTransaction) {
      try {
        // Sanitize: tsquery rejects punctuation, special chars, leading
        // digits-only. Split on whitespace AND punctuation (so "Dachmarke
        // (1).pdf" → ["Dachmarke", "1", "pdf"], not ["Dachmarke", "1pdf"]),
        // lowercase, drop tokens <2 chars + pure-numeric tokens.
        const tsQuery = query.trim().toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter(w => w.length > 1 && !/^\d+$/.test(w))
          .map(w => w + ':*').join(' & ');
        if (tsQuery) {
          const scopeWhere = scope === 'personal'
            ? `AND m.user_id = '${user_id}'::uuid`
            : `AND m.org_id = '${org_id}'::uuid`;
          const projectWhere = project ? `AND m.project = '${project}'` : '';
          const latestWhere = typeof is_latest === 'boolean' ? `AND m.is_latest = ${is_latest}` : '';
          const dateAfterWhere = created_after ? `AND m.created_at >= '${new Date(created_after).toISOString()}'` : '';
          const dateBeforeWhere = created_before ? `AND m.created_at <= '${new Date(created_before).toISOString()}'` : '';

          // Use 'simple' lexer instead of 'english' so proper nouns,
          // filenames, foreign-language terms ("Dachmarke", "Solvis",
          // "Konfigurator") aren't stemmed to forms that drop the prefix
          // match. English stemming caused recall to miss
          // "Document: Dachmarke (1).pdf" because Postgres indexed
          // "dachmark" while the query "dachmarke:*" no longer prefix-
          // matched the shorter stem. 'simple' preserves tokens verbatim.
          const ftsResults = await this.client.$queryRawUnsafe(`
            SELECT m.id, m.content, m.title, m.tags, m.memory_type, m.project,
                   m.importance_score, m.is_latest, m.created_at, m.updated_at,
                   m.document_date, m.event_dates, m.source_platform AS source, m.visibility,
                   ts_rank(to_tsvector('simple', COALESCE(m.content, '') || ' ' || COALESCE(m.title, '')),
                           to_tsquery('simple', $1)) as fts_score
            FROM memories m
            WHERE m.deleted_at IS NULL
              ${scopeWhere} ${projectWhere} ${latestWhere} ${dateAfterWhere} ${dateBeforeWhere}
              AND to_tsvector('simple', COALESCE(m.content, '') || ' ' || COALESCE(m.title, ''))
                  @@ to_tsquery('simple', $1)
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
        ...scopedMemoryWhere({ user_id, org_id, project, scope, access_context }),
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
    const type = normalizeRelationshipType(edge.type) || edge.type;
    const created = await this.client.relationship.upsert({
      where: {
        fromId_toId_type: {
          fromId: edge.from_id,
          toId: edge.to_id,
          type,
        },
      },
      update: {
        confidence: edge.confidence ?? 1.0,
        metadata: edge.metadata || {},
      },
      create: {
        id: edge.id,
        fromId: edge.from_id,
        toId: edge.to_id,
        type,
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
    const s = stripNullBytes(source);
    return this.client.sourceMetadata.upsert({
      where: { memoryId: s.memory_id },
      update: {
        sourceType: s.source_type,
        sourceId: s.source_id,
        sourcePlatform: s.source_platform,
        sourceUrl: s.source_url,
        threadId: s.thread_id,
        parentMessageId: s.parent_message_id,
        metadata: s.metadata || {}
      },
      create: {
        id: s.id,
        memoryId: s.memory_id,
        sourceType: s.source_type,
        sourceId: s.source_id,
        sourcePlatform: s.source_platform,
        sourceUrl: s.source_url,
        threadId: s.thread_id,
        parentMessageId: s.parent_message_id,
        metadata: s.metadata || {},
        ingestedAt: s.ingested_at ? (() => { const d = new Date(s.ingested_at); return isNaN(d.getTime()) ? new Date() : d; })() : new Date()
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
