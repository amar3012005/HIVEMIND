import crypto from 'node:crypto';
import { computeTokenSimilarity } from './conflict-detector.js';
import { normalizeRelationshipType } from './relationship-semantics.js';
import { normalizeTagsArray } from './entity-normalize.js';
import { signMemory, sha256Hex, canonical as pqcCanonical } from '../security/pqc-signer.js';
import { isMnemeOrg, orgIsRemote, amrLexical, amrLexicalRemote, amrRecall, withAmrLock, amrAddEdge, amrWrite, amrUpdate, mnemeMode, amrMemEdgeCounts } from '../vector/mneme/driver.js';
import { pgUrlFor, remoteHydrate, remoteList } from '../vector/mneme/remote-backend.js';
import { currentOrg } from '../db/prisma.js';

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

// Map an agent (hm.memories) row → the same snake_case shape mapMemoryRecord emits, so remote-org
// reads (getMemory/getMemories/listMemories) are shape-identical to central reads. The agent owns the
// row; we only reshape what crossed the link.
function mapAgentRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    user_id: r.user_id || null,
    owner: r.user_id ? { id: r.user_id, name: null } : null,
    owner_name: null,
    org_id: r.org_id || null,
    project: r.project || null,
    project_id: (Array.isArray(r.project_ids) && r.project_ids[0]) || null,
    project_ids: r.project_ids || [],
    visibility: r.visibility || 'private',
    scope: r.scope || 'personal',
    primary_team_id: r.primary_team_id || null,
    content: r.content || '',
    title: r.title || null,
    tags: r.tags || [],
    memory_type: r.memory_type || 'fact',
    is_latest: r.is_latest ?? true,
    layer: r.layer || 'memory',
    cognitive_layer_role: r.cognitive_layer_role || null,
    importance_score: r.confidence ?? 0.5,
    created_at: r.created_at,
    updated_at: r.created_at,
    valid_from: r.valid_from || null,
    document_date: r.document_date || null,
    metadata: r.metadata || {},
    // Provenance is folded into the agent's `metadata` jsonb on write (createMemory
    // remote branch). Surface it as the canonical source_metadata shape so remote
    // reads match central reads. Falls back to a top-level field if the agent ever
    // gains a dedicated column.
    source_metadata: r.source_metadata || (r.metadata && r.metadata.source_metadata) || {},
  };
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

  // Owner attribution — surface a human name when the User relation was joined
  // (listMemories/getMemory include it). Falls back to displayName → email → null.
  const ownerName = record.user
    ? (record.user.displayName || record.user.email || null)
    : null;

  return {
    id: record.id,
    user_id: record.userId,
    owner: record.userId ? { id: record.userId, name: ownerName } : null,
    owner_name: ownerName,
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
    valid_from: record.validFrom instanceof Date ? record.validFrom.toISOString() : (record.validFrom || null),
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
    created_by: record.createdBy || null,
    metadata: record.metadata || {}
  };
}

export function scopedMemoryWhere({ user_id, org_id, project, scope = 'personal', access_context = null, owner_only = false }) {
  const base = {
    orgId: org_id,
    project: project || undefined,
    deletedAt: null,
    // owner_only: restrict to the caller's OWN rows across whatever tiers are
    // visible. KB doc-summaries are scope='organization' but user-owned, so the
    // Documents "past docs" list must show only what THIS user uploaded — not
    // every org member's shared docs. Intersects with the tier OR below.
    ...(owner_only ? { userId: user_id } : {}),
  };

  // Explicit single-tier scopes (FE scope switcher: ALL / Org / Project /
  // Personal). These take precedence over access_context — the caller is
  // asking for ONE tier of the hierarchy, not the merged visible set.
  //   tier:personal     → the user's private memories only
  //   tier:organization → org-wide memories (admin-published, all members see)
  //   tier:project      → memories in projects the user can access
  if (scope === 'tier:personal') {
    return { ...base, userId: user_id, scope: 'personal' };
  }
  if (scope === 'tier:organization') {
    return { ...base, scope: 'organization' };
  }
  if (scope === 'tier:project') {
    const pIds = Array.isArray(access_context?.projectIds) ? access_context.projectIds : [];
    return {
      ...base,
      scope: 'project',
      memoryProjects: { some: { projectId: { in: pIds.length ? pIds : ['00000000-0000-0000-0000-000000000000'] } } },
    };
  }

  // V2 path: caller supplies the user's accessible team/project IDs from
  // TeamStore. Build a multi-tier OR clause that respects Memory.scope.
  if (access_context && (access_context.projectIds || access_context.teamIds)) {
    const projectIds = Array.isArray(access_context.projectIds) ? access_context.projectIds : [];
    const teamIds = Array.isArray(access_context.teamIds) ? access_context.teamIds : [];
    const tiers = [
      { userId: user_id, scope: 'personal' },
    ];
    // Hierarchy: org GUESTS (project-scoped invitees, often from another org)
    // see their own memories + their projects' memories — never the org-wide tier.
    if (access_context.orgRole !== 'guest') {
      tiers.push({ scope: 'organization', orgId: org_id });
    }
    if (projectIds.length > 0) {
      tiers.push({ scope: 'project', memoryProjects: { some: { projectId: { in: projectIds } } } });
    }
    if (teamIds.length > 0) {
      tiers.push({ scope: 'team', primaryTeamId: { in: teamIds } });
    }
    // M2b: exclude cross-project syntheses for guests (always — a cross-project
    // bridge can carry one of their projects' ids), and for ALL users when the org
    // has cross_project disabled. crossProject defaults true (fail-open).
    if (access_context.orgRole === 'guest' || access_context.crossProject === false) {
      return { ...base, OR: tiers, NOT: { tags: { has: 'scope:cross-project' } } };
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

  async advisoryLock(userId, fn, orgId) {
    // .amr org: no Postgres to pg_advisory_lock against. Serialize per-user IN-PROCESS and run the
    // body directly against the routing client (the .amr writes apply immediately). No PG tx opened.
    if (orgId && (orgIsRemote(orgId) || pgUrlFor(orgId) || (isMnemeOrg(orgId) && mnemeMode() === 'sole'))) {
      return withAmrLock(orgId, `mem:${userId}`, () => fn(new PrismaGraphStore(this.client, { inTransaction: true })));
    }
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

  // A store flagged inTransaction so a nested transaction()/advisoryLock runs the body directly
  // (no PG tx). Used by the .amr write path to stay Postgres-free for a pure insert.
  inProcessTx() {
    return new PrismaGraphStore(this.client, { inTransaction: true });
  }

  async transaction(fn, orgId) {
    if (this.inTransaction) {
      return fn(this);
    }
    // .amr org: no Postgres transaction — run against the routing client (the .amr store is not part
    // of a PG ACID tx anyway; writes apply immediately). Removes the empty-PG-tx dependency so an
    // .amr org functions with Postgres entirely absent.
    if (orgId && (orgIsRemote(orgId) || pgUrlFor(orgId) || (isMnemeOrg(orgId) && mnemeMode() === 'sole'))) {
      return fn(new PrismaGraphStore(this.client, { inTransaction: true }));
    }

    return this.client.$transaction(async tx => {
      return fn(new PrismaGraphStore(tx, { inTransaction: true }));
    }, { timeout: 180000 });
  }

  async createMemory(memory) {
    // RESIDENCY: agent-org rows are NOT written centrally. Push the row to the org's agent NOW (vector
    // is added later by storeMemory → same-id upsert) so mid-ingest reads (getMemory in extends/versions)
    // find it on the agent. Central keeps identity only. Managed/personal (orgIsRemote=false) → unchanged.
    if (orgIsRemote(memory.org_id)) {
      await amrWrite(memory.org_id, {
        id: memory.id, orgId: memory.org_id, userId: memory.user_id || null,
        content: stripNullBytes(memory.content), title: stripNullBytes(memory.title) || null,
        tags: memory.tags || [], memoryType: memory.memory_type || 'fact', isLatest: memory.is_latest ?? true,
        layer: memory.layer || (memory.cognitive_layer_role ? 'cognitive' : 'memory'),
        cognitiveLayerRole: memory.cognitive_layer_role || null, confidence: memory.importance_score ?? null,
        createdAt: memory.created_at || new Date().toISOString(),
        project: memory.project || null, projectIds: memory.project_ids || [],
        // Scope + team parity: the agent now has scope / primary_team_id columns,
        // so a project/team-scoped memory round-trips on self-host like central.
        scope: memory.scope || null, primaryTeamId: memory.primary_team_id || null,
        validFrom: memory.valid_from || null, documentDate: memory.document_date || null,
        // Provenance round-trip: the agent persists a `metadata` jsonb (no
        // dedicated source columns), so fold source_metadata into it. Without
        // this, remote-org reads return source_metadata:{} (the structured
        // provenance was captured only in tags). mapAgentRow reads it back.
        metadata: {
          ...(memory.metadata && typeof memory.metadata === 'object' ? memory.metadata : {}),
          ...(memory.source_metadata ? { source_metadata: memory.source_metadata } : {}),
        },
      }, null, []);
      return;
    }
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
        // Canonical chokepoint: EVERY ingest path (ingestMemory, MCP save, KB
        // promote/tree, connectors, autopilot, governance, deep-research) lands
        // here. Normalizing entity: tags at persist makes canonicalization
        // universal + bypass-proof, regardless of source or whether the LLM
        // entity-linker ran. Idempotent + only touches entity: tags.
        tags: normalizeTagsArray(memory.tags),
        isLatest: memory.is_latest,
        sourcePlatform: memory.source_metadata?.source_platform || null,
        sourceSessionId: memory.source_metadata?.source_session_id || null,
        sourceMessageId: memory.source_metadata?.source_id || null,
        sourceUrl: memory.source_metadata?.source_url || null,
        documentDate: memory.document_date ? new Date(memory.document_date) : null,
        // Bi-temporal lower bound — when the fact became TRUE in the world.
        // Default to document_date (KB facts carry it 100%) so time-travel
        // (valid_at) has a real inception instead of a dead NULL column.
        validFrom: memory.valid_from ? new Date(memory.valid_from) : (memory.document_date ? new Date(memory.document_date) : null),
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
    // Remote (self-host) orgs have NO central row — the memory lives on the agent. Route the
    // supported partial-update fields (tags / is_latest / memory_type) over HTTP instead of hitting
    // central Postgres (which throws "record not found"). This is the seam the entity-link tag/type
    // upgrades + supersession is_latest flips go through for remote orgs.
    const _remoteUpdOrg = currentOrg();
    if (_remoteUpdOrg && orgIsRemote(_remoteUpdOrg)) {
      const remotePatch = {};
      if (patch.tags !== undefined) remotePatch.tags = normalizeTagsArray(patch.tags);
      const rIsLatest = patch.isLatest ?? patch.is_latest;
      if (rIsLatest !== undefined) remotePatch.is_latest = rIsLatest;
      if (patch.memoryType !== undefined) remotePatch.memory_type = patch.memoryType;
      if (Object.keys(remotePatch).length) await amrUpdate(_remoteUpdOrg, id, remotePatch);
      return this.getMemory(id);
    }
    const data = {};
    const isLatestVal = patch.isLatest ?? patch.is_latest;
    if (isLatestVal !== undefined) data.isLatest = isLatestVal;
    if (patch.updated_at) data.updatedAt = new Date(patch.updated_at);
    if (patch.project !== undefined) data.project = patch.project;
    if (patch.content !== undefined) data.content = patch.content;
    if (patch.tags !== undefined) data.tags = normalizeTagsArray(patch.tags);
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
    const _org = currentOrg();
    if (_org && orgIsRemote(_org)) {
      const rows = await remoteHydrate(_org, [id]);
      return rows.length ? mapAgentRow(rows[0]) : null;
    }
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

  // Batch hydrate by ids — ONE findMany instead of N concurrent getMemory()
  // findUnique calls. The vector lane fans out ~150 ids; doing them as a
  // Promise.all of findUnique slams the Prisma pool (under full-pipeline
  // concurrency most returned null → the vector lane silently collapsed to ~1
  // candidate). Returns Map<id, mappedMemory>; ids absent from PG are simply
  // omitted (same as getMemory→null). Includes memoryProjects so project_ids
  // populate (getMemory omitted it).
  async getMemories(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return new Map();
    const uniq = [...new Set(ids.filter(Boolean))];
    const _org = currentOrg();
    if (_org && orgIsRemote(_org)) {
      const rows = await remoteHydrate(_org, uniq);
      const out = new Map();
      for (const r of rows) out.set(r.id, mapAgentRow(r));
      return out;
    }
    const records = await this.client.memory.findMany({
      where: { id: { in: uniq } },
      include: {
        sourceMetadata: true,
        codeMetadata: true,
        memoryProjects: true,
        versions: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    const out = new Map();
    for (const r of records) {
      const mapped = mapMemoryRecord(r);
      if (mapped && mapped.id) out.set(mapped.id, mapped);
    }
    return out;
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
    // RESIDENCY: remote (self-host) orgs keep their latest-memory set on the agent, not central.
    // Without this branch latestMemories=[] for remote → contradiction reconciliation (graph-engine
    // 1427) and conflictDetector candidate paths never fire → self-host loses Contradicts edges and
    // the algorithmic Updates supersession, leaving only the co-mention LLM. Route to the agent so the
    // full relationship machinery runs identically for all org types. Bounded to the most-recent latest
    // rows (recency-biased, matching how conflictDetector ranks candidates) to keep the save hot path cheap.
    const _org = org_id || currentOrg();
    if (_org && orgIsRemote(_org)) {
      const filter = { is_latest: true };
      if (user_id) filter.user_id = user_id;
      const REMOTE_LATEST_CAP = Number(process.env.REMOTE_LATEST_CAP || 500);
      const { memories } = await remoteList(_org, filter, null, REMOTE_LATEST_CAP, 0);
      return (memories || []).map(mapAgentRow);
    }
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

  async listMemories({ user_id, org_id, project, project_id, memory_type, tags, is_latest, include_children = false, hide_noise = false, limit = 50, offset = 0, scope = 'personal', access_context = null, owner_only = false }) {
    // RESIDENCY: agent-org memory rows live on the org's agent, not central → enumerate from the agent.
    const _org = org_id || currentOrg();
    if (_org && orgIsRemote(_org)) {
      const filter = {};
      if (memory_type) filter.memory_type = Array.isArray(memory_type) ? memory_type : [memory_type];
      if (is_latest !== undefined) filter.is_latest = is_latest;
      if (user_id) filter.user_id = user_id;
      // Pass offset so the FE's offset-based "load more" actually pages through the agent (was stuck on
      // page 1 — agent ignored offset and the FE doesn't use cursors).
      const { memories } = await remoteList(_org, filter, null, limit, offset);
      const mapped = memories.map(mapAgentRow);
      // Enrich with edge counts (in/out) in a single batched call so the FE "linked N" chip is correct.
      // Central orgs compute edges_in_count / edges_out_count via Prisma _count; remote orgs query the
      // agent's relationships table. On failure we degrade gracefully (counts stay 0).
      if (mapped.length) {
        try {
          const edgeMap = await amrMemEdgeCounts(_org, mapped.map((m) => m.id));
          if (edgeMap && typeof edgeMap === 'object') {
            for (const m of mapped) {
              const e = edgeMap[m.id];
              if (e) { m.edges_in_count = e.in || 0; m.edges_out_count = e.out || 0; }
            }
          }
        } catch { /* degrade gracefully — FE uses || 0 fallback */ }
      }
      return { memories: mapped, total: mapped.length };
    }
    // Phase P.3: prefer formal projectId FK when caller passes it; falls back
    // to legacy free-text `project` string.
    const baseWhere = scopedMemoryWhere({ user_id, org_id, project, scope, access_context, owner_only });
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
    // Governance audit-reflection noise — the cron's "Faraday scanned N memories"
    // rows. All four tags co-occur; hide the whole class. Cognitive-layer OUTPUTS
    // (canonical-summary / synthesis:* / principle / bridge) carry none of these,
    // so they stay visible.
    if (!callerWantsAudit) hiddenTags.push('internal-audit', 'governance', 'reflection');
    if (!callerWantsRoomDecisions) hiddenTags.push('room-decision', 'hyper-rooms', 'hyper-room');
    // TARA voice activity belongs in Call History, NOT the memory list — hide
    // ALL of it including the per-call `tara-call-log` summary. Caller opts in
    // by passing any tara-* tag.
    // TARA voice activity + config/skills belong in /tara Call History, not the
    // memory list. Exclude by TAG (tara-*) — NOT by `NOT project startsWith
    // 'tara/'`, which drops every project=NULL memory (SQL NULL LIKE semantics).
    const callerWantsTara = Array.isArray(tags) && tags.some((t) => typeof t === 'string' && t.startsWith('tara-'));
    if (!callerWantsTara) hiddenTags.push('tara-turn', 'tara-insight', 'tara-session', 'tara-call-log', 'tara-config', 'tara-skill');
    // Distilled KB facts (extracted-fact) are first-class memories — counted +
    // listed everywhere, never hidden as "children". Only genuine noise
    // (audit/governance/tara/room) is hidden above. (include_children retained
    // for API compatibility; no longer gates the KB facts.)
    void include_children;
    // hide_noise — connector ingests the user has flagged as low-signal.
    // Newsletters / promotions / social / forums / notifications get
    // hidden from the default Memories list. Recall-side score demotion
    // (persisted-retrieval) still applies regardless.
    if (hide_noise) hiddenTags.push(
      'updates', 'label:updates',
      'promotions', 'label:promotions',
      'social', 'label:social',
      'forums', 'label:forums',
      'newsletter', 'notification', 'automated', 'no-reply',
    );
    // Cognitive-layer DREAMS (canonical/bridge/principle syntheses) inherit ALL
    // their cluster members' tags — including 'extracted-fact' — but they are NOT
    // child sub-units; they're first-class synthesized memories the user should
    // see (the 🌙 Dream badge marks them). Exempt the dream roles from the
    // hidden-tag exclusion so they surface in the list. Governance reflection /
    // compression roles get NO exemption (stay hidden as before — count-reconciled).
    const auditExclusion = hiddenTags.length
      ? {
          OR: [
            { cognitiveLayerRole: { in: ['canonical', 'bridge', 'principle'] } },
            { NOT: { tags: { hasSome: hiddenTags } } },
          ],
        }
      : {};
    // Default to current memories only (is_latest=true) unless the caller
    // explicitly asks for superseded versions. Was undefined → counted every
    // historical version, inflating the list total vs the graph/overview.
    const isLatestFilter = is_latest === false ? false : true;
    const records = await this.client.memory.findMany({
      where: {
        ...baseWhere,
        ...auditExclusion,
        memoryType: memory_type || undefined,
        isLatest: isLatestFilter,
        tags: tags?.length ? { hasEvery: tags } : undefined,
      },
      include: {
        sourceMetadata: true,
        codeMetadata: true,
        user: { select: { id: true, displayName: true, email: true } },
        versions: {
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      },
      orderBy: [
        { documentDate: 'desc' },
        { createdAt: 'desc' }
      ],
      skip: offset,
      take: limit
    });

    // Count must use the SAME scope (scope + access_context + project join) as
    // the findMany above — previously it dropped both, so the total counted a
    // different set than the rows it returned.
    const countWhere = scopedMemoryWhere({ user_id, org_id, project, scope, access_context, owner_only });
    if (project_id) {
      if (baseWhere.memoryProjects) { delete countWhere.OR; delete countWhere.userId; countWhere.memoryProjects = { some: { projectId: project_id } }; }
      else countWhere.projectId = project_id;
    }
    const total = await this.client.memory.count({
      where: {
        ...countWhere,
        ...auditExclusion,
        memoryType: memory_type || undefined,
        isLatest: isLatestFilter,
        tags: tags?.length ? { hasEvery: tags } : undefined
      }
    });

    return {
      memories: records.map(mapMemoryRecord),
      total
    };
  }

  async searchMemories({ query, user_id, org_id, project, memory_type, tags, is_latest, n_results = 10, created_after, created_before, source_platform, scope = 'personal', access_context = null }) {
    // .amr org: there is no Postgres to run to_tsvector against. The lexical (keyword) leg of hybrid
    // recall runs over the org's .amr records instead — same scope, term-overlap scoring. Without
    // this the lexical leg would $queryRaw-passthrough to central Postgres (PG=0 for this org) and
    // silently return nothing, leaving recall vector-only.
    if (query && isMnemeOrg(org_id) && mnemeMode() === 'sole') {
      return amrLexical(org_id, query, { org_id, user_id, scope, is_latest, project, created_after, created_before }, n_results * 3) || [];
    }
    // REMOTE agent org (push model): recall lives on the org's agent, not central. Embed the query here
    // and vector-search the agent (amrRecall → POST /v1/recall); content rides in the hit payload.
    if (query && orgIsRemote(org_id)) {
      try {
        const { getEmbedService } = await import('../embeddings/factory.js');
        const vec = await getEmbedService().embedOne(query).catch(() => null);
        if (!vec) return [];
        const filter = { must: [{ key: 'org_id', match: { value: org_id } }] };
        if (is_latest !== undefined) filter.must.push({ key: 'is_latest', match: { value: is_latest } });
        // HYBRID: vector (semantic) + lexical (exact-term FTS over the agent's Postgres). The lexical
        // leg surfaces buried exact terms that cosine rank misses — without it self-host recall was
        // vector-only. Union by id; keep the higher score (lexical hits ride at their ts_rank).
        const lexFilter = { is_latest: is_latest !== undefined ? is_latest : true };
        const [hits, lex] = await Promise.all([
          amrRecall(org_id, vec, filter, n_results * 3, 0).then((r) => r || []),
          (amrLexicalRemote(org_id, query, lexFilter, n_results * 3) || Promise.resolve([])).then((r) => r || []),
        ]);
        const byId = new Map();
        for (const h of [...hits, ...lex]) {
          const p = h.payload || {};
          const id = p.memory_id || h.id;
          if (!id) continue;
          const score = typeof h.score === 'number' ? h.score : 0.5;
          const existing = byId.get(id);
          if (existing && existing.score >= score) continue;
          byId.set(id, {
            id, content: p.content || '', title: p.title || null, tags: p.tags || [],
            memory_type: p.memory_type || 'fact', project: null,
            importance_score: score, is_latest: p.is_latest ?? true,
            created_at: p.created_at || null, updated_at: p.created_at || null,
            score, cognitive_layer_role: p.cognitive_layer_role || null,
          });
        }
        return Array.from(byId.values()).sort((a, b) => (b.score || 0) - (a.score || 0));
      } catch (e) {
        console.warn('[recall] remote agent search failed:', e.message);
        return [];
      }
    }
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
          // Build parameterized WHERE fragments. $1=tsQuery, $2=limit are
          // already fixed; additional bound values are appended here and
          // referenced as $3, $4, … so NO user-supplied value is ever
          // string-interpolated into the query.
          const ftsParams = [tsQuery, n_results * 3];
          // nextParam() is called AFTER pushing the value, so length already
          // reflects the newly-added element — no +1 needed.
          const nextParam = () => `$${ftsParams.length}`;

          let scopeWhere;
          if (access_context && (Array.isArray(access_context.projectIds) || Array.isArray(access_context.teamIds))) {
            const projectIds = Array.isArray(access_context.projectIds) ? access_context.projectIds : [];
            const teamIds = Array.isArray(access_context.teamIds) ? access_context.teamIds : [];

            // personal tier — always present
            ftsParams.push(user_id);
            const userParam = `$${ftsParams.length}`;
            const tiers = [
              `(m.user_id = ${userParam}::uuid AND m.scope = 'personal')`,
            ];

            // Guest gate mirrors scopedMemoryWhere: org guests (project-scoped
            // invitees) never get the org-wide tier — keyword search included.
            if (access_context.orgRole !== 'guest') {
              ftsParams.push(org_id);
              const orgTierParam = `$${ftsParams.length}`;
              tiers.push(`(m.scope = 'organization' AND m.org_id = ${orgTierParam}::uuid)`);
            }

            if (projectIds.length > 0) {
              const placeholders = projectIds.map(id => {
                ftsParams.push(id);
                return `$${ftsParams.length}::uuid`;
              }).join(',');
              tiers.push(`(m.scope = 'project' AND EXISTS (SELECT 1 FROM memory_projects mp WHERE mp.memory_id = m.id AND mp.project_id IN (${placeholders})))`);
            }

            if (teamIds.length > 0) {
              const placeholders = teamIds.map(id => {
                ftsParams.push(id);
                return `$${ftsParams.length}::uuid`;
              }).join(',');
              tiers.push(`(m.scope = 'team' AND m.primary_team_id IN (${placeholders}))`);
            }

            // Always require org scope match for safety
            ftsParams.push(org_id);
            const orgScopeParam = `$${ftsParams.length}`;
            scopeWhere = `AND m.org_id = ${orgScopeParam}::uuid AND (${tiers.join(' OR ')})`;
            // M2b: drop cross-project syntheses for guests (always) and for all users
            // when the org disabled cross_project (parameterized, no interpolation).
            if (access_context.orgRole === 'guest' || access_context.crossProject === false) {
              ftsParams.push('scope:cross-project');
              scopeWhere += ` AND NOT (${'$' + ftsParams.length} = ANY(m.tags))`;
            }
          } else {
            if (scope === 'personal') {
              ftsParams.push(user_id);
              const userParam = `$${ftsParams.length}`;
              // LOW-1: also scope by org_id in personal branch (matches Prisma fallback)
              ftsParams.push(org_id);
              const orgParam = `$${ftsParams.length}`;
              scopeWhere = `AND m.user_id = ${userParam}::uuid AND m.org_id = ${orgParam}::uuid`;
            } else {
              ftsParams.push(org_id);
              const orgParam = `$${ftsParams.length}`;
              scopeWhere = `AND m.org_id = ${orgParam}::uuid`;
            }
          }

          const projectWhere = project
            ? (ftsParams.push(project), `AND m.project = ${nextParam()}`)
            : '';
          const latestWhere = typeof is_latest === 'boolean'
            ? (ftsParams.push(is_latest), `AND m.is_latest = ${nextParam()}`)
            : '';
          const dateAfterWhere = created_after
            ? (ftsParams.push(new Date(created_after).toISOString()), `AND m.created_at >= ${nextParam()}::timestamptz`)
            : '';
          const dateBeforeWhere = created_before
            ? (ftsParams.push(new Date(created_before).toISOString()), `AND m.created_at <= ${nextParam()}::timestamptz`)
            : '';

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
          `, ...ftsParams);

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
    // RESIDENCY: remote-org edges live on the agent (no central memory rows to FK to). Push the typed
    // edge to the agent and skip the central upsert. Managed/personal → central upsert below.
    const _remoteOrg = edge.org_id || currentOrg();
    if (orgIsRemote(_remoteOrg)) {
      amrAddEdge({ id: edge.id, fromId: edge.from_id, toId: edge.to_id, type, confidence: edge.confidence ?? 1.0, orgId: _remoteOrg });
      return mapRelationshipRecord({ id: edge.id, fromId: edge.from_id, toId: edge.to_id, type, confidence: edge.confidence ?? 1.0, metadata: edge.metadata || {} });
    }
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

    // Dual mode: PG has the row (above); mirror the typed edge into the .amr shard for graph-recall.
    // No-op when no .amr org / sole mode (sole already routes the upsert to .amr via the proxy).
    if (mnemeMode() === 'dual') {
      amrAddEdge({ id: created.id, fromId: edge.from_id, toId: edge.to_id, type, confidence: edge.confidence ?? 1.0, orgId: edge.org_id || currentOrg() });
    }

    return mapRelationshipRecord(created);
  }

  async createMemoryVersion(version) {
    if (orgIsRemote(currentOrg())) return null; // remote-org versions live on the agent, not central
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
    // RESIDENCY: remote-org subgraph children are not written centrally (no central parent row to FK to);
    // they travel with the push envelope to the agent. Managed/personal unchanged.
    if (orgIsRemote(currentOrg())) return;
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
    // RESIDENCY: derivation jobs are a CENTRAL-only async-derivation feature whose FK points at memory
    // rows. For a remote (self-host) org the memory lives on the agent, so a central create() throws
    // (Invalid prisma.derivationJob.create invocation — FK to a row central doesn't have) and aborts KB
    // promotion. Skip for remote; the agent-side graph (tags + edges via the co-mention linker) is the
    // self-host equivalent.
    if (orgIsRemote(currentOrg())) return null;
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
