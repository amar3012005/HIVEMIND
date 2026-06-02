import crypto from 'node:crypto';
import { computeTokenSimilarity } from './conflict-detector.js';
import { normalizeRelationshipType } from './relationship-semantics.js';
import { signMemory, sha256Hex, canonical as pqcCanonical } from '../security/pqc-signer.js';

/**
 * Strip null bytes (\u0000) from strings — Postgres text columns reject them (code 22P05).
 * Common in web-scraped content from DuckDuckGo, PDF extracts, and LLM outputs.
 */
function stripNullBytes(val) {
  if (typeof val === 'string') {
    // Strip null bytes AND other invalid UTF-8 sequences (cause 22021 Postgres errors + garbled streaming)
    return val.replace(/\u0000/g, '').replace(/\uFFFD/g, '').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '').replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');  }
  if (Array.isArray(val)) return val.map(stripNullBytes);
  if (val instanceof Date) return val;
  if (val && typeof val === 'object') {
    const out = {};
    for (const k of Object.keys(val)) out[k] = stripNullBytes(val[k]);
    return out;
  }
  return val;
}

// Bulletproof string→Postgres-safe: a UTF-8 Buffer round-trip replaces ANY
// invalid byte sequence (lone surrogates, malformed UTF-8, stray escapes) with
// U+FFFD, then stripNullBytes removes FFFD/NUL/surrogates. Catches cases the
// targeted regexes miss. Used as the self-heal retry sanitizer.
function pgSafeDeep(val) {
  if (typeof val === 'string') {
    return stripNullBytes(Buffer.from(val, 'utf8').toString('utf8'));
  }
  if (Array.isArray(val)) return val.map(pgSafeDeep);
  if (val instanceof Date) return val;
  if (val && typeof val === 'object') {
    const out = {};
    for (const k of Object.keys(val)) out[k] = pgSafeDeep(val[k]);
    return out;
  }
  return val;
}

// Instrumentation: find which field of an object carries JSONB-illegal content
// (NUL or unpaired UTF-16 surrogate). Returns { field, snippet } or null.
function findJsonbCulprit(obj) {
  const bad = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const walk = (v, path) => {
    if (typeof v === 'string') {
      const m = bad.exec(v);
      if (m) return { field: path, snippet: v.slice(Math.max(0, m.index - 20), m.index + 20), code: v.charCodeAt(m.index).toString(16) };
      return null;
    }
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      for (const k of Object.keys(v)) {
        const hit = walk(v[k], path ? `${path}.${k}` : k);
        if (hit) return hit;
      }
    }
    return null;
  };
  try { return walk(obj, ''); } catch { return null; }
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
    // Phase P.2: surface formal Project FK when populated. project (string)
    // stays for legacy free-text label compatibility.
    project_id: record.projectId || null,
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
    },
    // Phase 1+2+3 synthesis fields — required by recall-router crossClusterEntityBoost
    // + recordRecall. Missing here meant vector-path memories were dropped from
    // the cross-cluster boost set and cluster_index.recall_count_30d stayed at 0.
    synthesis_confidence:    record.synthesisConfidence != null ? Number(record.synthesisConfidence) : null,
    synthesis_cluster_hash:  record.synthesisClusterHash || null,
    synthesis_revision:      record.synthesisRevision != null ? Number(record.synthesisRevision) : 1,
    synthesis_evidence_ids:  record.synthesisEvidenceIds || [],
    // Phase B tiered cache surface fields
    tier:                    typeof record.tier === 'number' ? record.tier : 2,
    last_accessed_at:        record.lastAccessedAt instanceof Date ? record.lastAccessedAt.toISOString() : record.lastAccessedAt,
    promoted_at:             record.promotedAt instanceof Date ? record.promotedAt.toISOString() : record.promotedAt,
    // Phase 2 governance cognitive layer role
    cognitive_layer_role:    record.cognitiveLayerRole || null,
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
    }, { timeout: 180000 });
  }

  async transaction(fn) {
    if (this.inTransaction) {
      return fn(this);
    }

    return this.client.$transaction(async tx => {
      return fn(new PrismaGraphStore(tx, { inTransaction: true }));
    }, { timeout: 180000 });
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
        // Formal project FK — persist from the resolved project_id / first
        // project_ids entry so project-scoped queries that filter by projectId
        // (not just the legacy `project` string) see the memory.
        projectId: memory.project_id
          || (Array.isArray(memory.project_ids) && memory.project_ids.length > 0 ? memory.project_ids[0] : null),
        content,
        tags: memory.tags,
        isLatest: memory.is_latest,
        sourcePlatform: memory.source_metadata?.source_platform || null,
        sourceSessionId: memory.source_metadata?.source_session_id || null,
        sourceMessageId: memory.source_metadata?.source_id || null,
        sourceUrl: memory.source_metadata?.source_url || null,
        documentDate: memory.document_date ? new Date(memory.document_date) : null,
        eventDates: (memory.event_dates || []).map(value => new Date(value)),
        memoryType: memory.memory_type || 'fact',
        title,
        importanceScore: memory.importance_score ?? 0.5,
        strength: memory.strength ?? 1.0,
        recallCount: memory.recall_count ?? 0,
        embeddingModel: memory.embedding_model || 'mistral-embed',
        embeddingVersion: memory.embedding_version ?? 1,
        processingBasis: memory.processing_basis || 'consent',
        sharedWithOrgs: memory.shared_with_orgs || [],
        cognitiveLayerRole: memory.cognitive_layer_role || null,
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

    // PQC integrity (FIPS 204 ML-DSA-65): sign the immutable core fields so any
    // post-write tampering is cryptographically detectable. Stored in the
    // memory_signatures side-table (raw SQL → no ORM column / client regen).
    // ML-DSA signing is sub-millisecond; skips silently if keys/lib absent so
    // the write never breaks.
    try {
      const sigPayload = pqcCanonical({
        id: memory.id, user_id: memory.user_id, org_id: memory.org_id || null, content,
      });
      const sig = await signMemory(sigPayload);
      if (sig) {
        await this.client.$executeRawUnsafe(
          `INSERT INTO memory_signatures (memory_id, org_id, alg, payload_hash, signature)
           VALUES ($1::uuid, $2::uuid, 'ML-DSA-65', $3, $4)
           ON CONFLICT (memory_id) DO NOTHING`,
          memory.id, memory.org_id || null, sha256Hex(sigPayload), sig,
        );
      }
    } catch { /* integrity signing is best-effort — never block the write */ }

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

  /** Hard-delete memories + all FK refs (irreversible). Returns count. Caller
   *  handles Qdrant point removal. Mirrors the knowledge-delete cascade. */
  async hardDeleteMemories(ids) {
    ids = Array.from(new Set((ids || []).filter(Boolean)));
    if (ids.length === 0) return 0;
    await this.client.sourceMetadata.deleteMany({ where: { memoryId: { in: ids } } });
    await this.client.memoryVersion.updateMany({ where: { relatedMemoryId: { in: ids } }, data: { relatedMemoryId: null } });
    await this.client.memoryVersion.deleteMany({ where: { memoryId: { in: ids } } });
    await this.client.relationship.deleteMany({ where: { OR: [{ fromId: { in: ids } }, { toId: { in: ids } }] } });
    await this.client.auditLog.updateMany({ where: { resourceId: { in: ids } }, data: { resourceId: null } }).catch(() => {});
    const res = await this.client.memory.deleteMany({ where: { id: { in: ids } } });
    return res.count;
  }

  async listLatestMemories({ user_id, org_id, project, scope = 'personal', access_context = null }) {
    const records = await this.client.memory.findMany({
      where: { ...scopedMemoryWhere({ user_id, org_id, project, scope, access_context }), isLatest: true },
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

  async listMemories({ user_id, org_id, project, project_id, memory_type, tags, is_latest, limit = 50, offset = 0, scope = 'personal', access_context = null }) {
    // Phase P.3: prefer formal projectId FK when caller passes it; falls back
    // to legacy free-text `project` string.
    const baseWhere = scopedMemoryWhere({ user_id, org_id, project, scope, access_context });
    if (project_id) {
      // Narrow to a single project the caller can access. Use the M:N
      // memory_projects join so memories authored by OTHER project members
      // surface — not just the caller's own (Memory.projectId) rows.
      const accessible = !access_context
        || (Array.isArray(access_context.projectIds) && access_context.projectIds.includes(project_id));
      if (accessible) {
        delete baseWhere.OR;
        delete baseWhere.userId;
        baseWhere.memoryProjects = { some: { projectId: project_id } };
      } else {
        // Not a member of this project → restrict to the caller's own rows.
        baseWhere.projectId = project_id;
      }
    }
    // Internal-audit suppression: governance reflection rows etc. are
    // operational noise — drop from default listing. Caller opts in by
    // passing tags=['internal-audit'].
    const callerWantsAudit = Array.isArray(tags) && tags.includes('internal-audit');
    const callerWantsRoomDecisions = Array.isArray(tags) && (tags.includes('room-decision') || tags.includes('hyper-rooms'));
    // Build exclusion clause: drop internal-audit AND hyper-room decisions
    // by default. Caller opts in via tags=['internal-audit'] or
    // tags=['room-decision']/['hyper-rooms'].
    const hiddenTags = [];
    if (!callerWantsAudit) hiddenTags.push('internal-audit');
    if (!callerWantsRoomDecisions) hiddenTags.push('room-decision', 'hyper-rooms');
    const auditExclusion = hiddenTags.length
      ? { NOT: { tags: { hasSome: hiddenTags } } }
      : {};
    const records = await this.client.memory.findMany({
      where: {
        ...baseWhere,
        ...auditExclusion,
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

    const countWhere = scopedMemoryWhere({ user_id, org_id, project });
    if (project_id) countWhere.projectId = project_id;
    const total = await this.client.memory.count({
      where: {
        ...countWhere,
        ...auditExclusion,
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

  async searchMemories({ query, user_id, org_id, project, memory_type, tags, is_latest, n_results = 10, created_after, created_before, source_platform, scope = 'personal', access_context = null }) {
    // Try PostgreSQL full-text search with stemming (like code-review-graph's FTS5 + Porter)
    // Only run outside transactions — $queryRawUnsafe corrupts Prisma interactive transactions
    if (query && this.client.$queryRawUnsafe && !this.inTransaction) {
      try {
        // Sanitize: tsquery rejects punctuation, special chars, leading digits-only.
        // Strip everything except a-z0-9, lowercase, drop tokens <2 chars.
        const tsQuery = query.trim().split(/\s+/)
          .map(w => w.toLowerCase().replace(/[^a-z0-9]/g, ''))
          .filter(w => w.length > 1)
          .map(w => w + ':*').join(' & ');
        if (tsQuery) {
          // Scope predicate: V2 multi-tier OR when access_context provided,
          // else legacy personal/org single-scope. Skips FTS only if neither
          // a usable access_context nor a single-scope param is available.
          let scopeWhere;
          if (access_context && (Array.isArray(access_context.projectIds) || Array.isArray(access_context.teamIds))) {
            const projectIds = Array.isArray(access_context.projectIds) ? access_context.projectIds : [];
            const teamIds = Array.isArray(access_context.teamIds) ? access_context.teamIds : [];
            const tiers = [
              `(m.user_id = '${user_id}'::uuid AND m.scope = 'personal')`,
              `(m.scope = 'organization' AND m.org_id = '${org_id}'::uuid)`,
            ];
            if (projectIds.length > 0) {
              const idList = projectIds.map(id => `'${id}'::uuid`).join(',');
              tiers.push(`(m.scope = 'project' AND EXISTS (SELECT 1 FROM memory_projects mp WHERE mp.memory_id = m.id AND mp.project_id IN (${idList})))`);
            }
            if (teamIds.length > 0) {
              const idList = teamIds.map(id => `'${id}'::uuid`).join(',');
              tiers.push(`(m.scope = 'team' AND m.primary_team_id IN (${idList}))`);
            }
            // Always require org scope match for safety
            scopeWhere = `AND m.org_id = '${org_id}'::uuid AND (${tiers.join(' OR ')})`;
          } else {
            scopeWhere = scope === 'personal'
              ? `AND m.user_id = '${user_id}'::uuid`
              : `AND m.org_id = '${org_id}'::uuid`;
          }
          const projectWhere = project ? `AND m.project = '${project}'` : '';
          const latestWhere = typeof is_latest === 'boolean' ? `AND m.is_latest = ${is_latest}` : '';
          const dateAfterWhere = created_after ? `AND m.created_at >= '${new Date(created_after).toISOString()}'` : '';
          const dateBeforeWhere = created_before ? `AND m.created_at <= '${new Date(created_before).toISOString()}'` : '';

          const ftsResults = await this.client.$queryRawUnsafe(`
            SELECT m.id, m.content, m.title, m.tags, m.memory_type, m.project,
                   m.importance_score, m.is_latest, m.created_at, m.updated_at,
                   m.document_date, m.event_dates, m.source_platform AS source, m.visibility,
                   m.synthesis_confidence, m.synthesis_cluster_hash, m.synthesis_revision, m.synthesis_evidence_ids,
                   m.tier, m.last_accessed_at, m.promoted_at, m.cognitive_layer_role,
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
              // Phase 1 synthesis columns — needed by recall-router boost + synthesized[] shape
              synthesis_confidence: r.synthesis_confidence != null ? Number(r.synthesis_confidence) : null,
              synthesis_cluster_hash: r.synthesis_cluster_hash || null,
              synthesis_revision: r.synthesis_revision != null ? Number(r.synthesis_revision) : 1,
              synthesis_evidence_ids: Array.isArray(r.synthesis_evidence_ids) ? r.synthesis_evidence_ids : [],
              tier: typeof r.tier === 'number' ? r.tier : 2,
              last_accessed_at: r.last_accessed_at?.toISOString?.() || r.last_accessed_at || null,
              promoted_at: r.promoted_at?.toISOString?.() || r.promoted_at || null,
              cognitive_layer_role: r.cognitive_layer_role || null,
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

  async getRelatedMemories(memoryId, { maxDepth = 2, minConfidence = 0, relationship = null, user_id, org_id, project, scope = 'personal' } = {}) {
    const visitedMemoryIds = new Set([memoryId]);
    const visitedEdgeIds = new Set();
    const collected = [];
    let frontier = new Set([memoryId]);

    const normalizedRelType = relationship
      ? (normalizeRelationshipType(relationship) || relationship)
      : null;

    for (let depth = 0; depth < maxDepth && frontier.size > 0; depth += 1) {
      const frontierIds = Array.from(frontier);

      const where = {
        confidence: { gte: minConfidence },
        OR: [
          { fromId: { in: frontierIds } },
          { toId: { in: frontierIds } }
        ],
        fromMemory: scopedMemoryWhere({ user_id, org_id, project, scope }),
        toMemory: scopedMemoryWhere({ user_id, org_id, project, scope })
      };
      if (normalizedRelType) where.type = normalizedRelType;

      const records = await this.client.relationship.findMany({
        where,
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
    const buildArgs = (s) => ({
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
    const s = stripNullBytes(source);
    try {
      return await this.client.sourceMetadata.upsert(buildArgs(s));
    } catch (err) {
      // JSONB / encoding failure ("unexpected end of hex escape", 22P02, lone
      // surrogate). INSTRUMENT: name the exact field + char so we stop guessing.
      // Then SELF-HEAL: re-encode every string via a UTF-8 round-trip (pgSafeDeep)
      // which neutralizes any invalid byte sequence, and retry once. A write is
      // never silently dropped again.
      const msg = err?.message || '';
      if (/hex escape|surrogate|22P02|invalid input syntax for type json|unsupported Unicode/i.test(msg)) {
        const culprit = findJsonbCulprit({
          source_id: s.source_id, source_url: s.source_url, thread_id: s.thread_id,
          parent_message_id: s.parent_message_id, metadata: s.metadata,
        });
        console.error(`[sourceMetadata] JSONB-illegal content memory=${s.memory_id} field=${culprit?.field || '?'} charHex=${culprit?.code || '?'} snippet=${JSON.stringify(culprit?.snippet || '').slice(0, 80)} — self-healing via UTF-8 round-trip`);
        return await this.client.sourceMetadata.upsert(buildArgs(pgSafeDeep(s)));
      }
      throw err;
    }
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
