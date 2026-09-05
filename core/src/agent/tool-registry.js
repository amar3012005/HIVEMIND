/**
 * Tool registry for Talk-to-HIVE ReAct agent.
 *
 * Exposes ~22 HIVEMIND tools to the LLM as OpenAI-style function definitions.
 * Each tool maps to a dispatch handler that calls the same underlying service
 * the MCP server uses — no MCP transport overhead, same security context.
 *
 * Dispatch handlers receive (args, ctx) where ctx is:
 *   { userId, orgId, prisma, persistentMemoryStore, persistentMemoryEngine,
 *     smartIngestRouter, buildRoutedIngestPayloads }
 */

import { recallPersistedMemories } from '../memory/persisted-retrieval.js';
import { resolveProjectForSave } from '../memory/project-classifier.js';
import { amrBumpRecall, orgIsRemote } from '../vector/mneme/driver.js';
import { remoteHydrate } from '../vector/mneme/remote-backend.js';
import { scopedMemoryWhere } from '../memory/prisma-graph-store.js';
import { applyProjectScopeFilter } from '../routes/recall.js';
import { loadTypedGraphEvidence, buildEvidencePacket } from '../memory/recall-router.js';
import { isStageDeadlineError, runWithStageDeadline } from '../runtime/stage-deadline.js';
import { normalizeEntity } from '../memory/entity-normalize.js';
import {
  CANONICAL_MEMORY_TYPES,
  normalizeMemoryType,
} from '../memory/memory-taxonomy.js';
import { TOOL_SCHEMAS } from './tool-schemas.js';

function temporalClaimKey(row = {}) {
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const claim = metadata.claim && typeof metadata.claim === 'object' ? metadata.claim : {};
  const explicit = metadata.claim_key || metadata.fact_key || row.claim_key || row.fact_key;
  if (explicit) return `claim:${String(explicit).normalize('NFKC').toLocaleLowerCase()}`;
  const subject = row.claimSubject || row.claim_subject || claim.subject?.name || claim.subject;
  const predicate = row.claimPredicate || row.claim_predicate || claim.predicate;
  if (subject && predicate) return `sp:${normalizeEntity(subject)}|${normalizeEntity(predicate)}`;
  const entityTags = (row.tags || []).filter((tag) => /^entity:/i.test(String(tag))).sort().join('|');
  const title = row.title || row.document_title || row.document?.title || '';
  if (entityTags || title) return `topic:${normalizeEntity(`${entityTags}|${title}`)}`;
  return `text:${normalizeEntity(String(row.content || row.snippet || '').slice(0, 240))}`;
}

function temporalRowIdentity(row = {}) {
  return row.id || row.segmentId || row.segment_id
    || `${row.documentId || row.document_id || row.document?.id || ''}:${row.segmentIndex || row.segment_index || ''}:${temporalClaimKey(row)}`;
}

function typedRetrievalFilters(args = {}) {
  return {
    ...(Array.isArray(args.entities) ? { entities: args.entities } : {}),
    ...(Array.isArray(args.memory_types) ? { memory_types: args.memory_types } : {}),
    ...(args.source_document_id ? { source_document_id: args.source_document_id } : {}),
    ...(args.source_title ? { source_title: args.source_title } : {}),
    ...(args.source_kind ? { source_kind: args.source_kind } : {}),
    ...(args.scope_filter ? { scope_filter: args.scope_filter } : {}),
    ...(Array.isArray(args.relationship_types) ? { relationship_types: args.relationship_types } : {}),
    ...(args.relationship_direction ? { relationship_direction: args.relationship_direction } : {}),
    ...(args.entity_filter_mode ? { entity_filter_mode: args.entity_filter_mode } : {}),
    ...(args.time_axis ? { temporal_axis: args.time_axis } : {}),
    ...(args.memory_id ? { target_memory_id: args.memory_id } : {}),
  };
}

function groupTemporalRows(rows = [], relationships = []) {
  const byId = new Map(rows.filter(Boolean).map((row) => [row.id, row]));
  const parent = new Map([...byId.keys()].map((id) => [id, id]));
  const find = (id) => {
    let root = parent.get(id);
    while (root && root !== parent.get(root)) root = parent.get(root);
    return root || id;
  };
  const union = (left, right) => {
    if (!parent.has(left) || !parent.has(right)) return;
    const a = find(left); const b = find(right);
    if (a !== b) parent.set(b, a);
  };
  for (const edge of relationships) {
    if (['updates', 'contradicts'].includes(String(edge.type || '').toLowerCase())) union(edge.from_id, edge.to_id);
  }
  const groups = new Map();
  for (const row of rows.filter(Boolean)) {
    const key = row.id && parent.has(row.id) ? `chain:${find(row.id)}` : temporalClaimKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].map(([claim_key, versions]) => ({
    claim_key,
    versions: versions.sort((a, b) => new Date(a.valid_from || a.known_at || a.created_at || a.createdAt || 0)
      - new Date(b.valid_from || b.known_at || b.created_at || b.createdAt || 0))
      .map((row) => ({
        ...row,
        temporal_status: row.is_latest === false || row.isLatest === false || row._superseded_predecessor
          ? 'superseded' : 'current',
      })),
  }));
}

export function findDirectEntityEdges(edges, entities, memoryIdsByEntity) {
  return edges.filter((edge) => {
    if (!edge?.from_id || !edge?.to_id || edge.from_id === edge.to_id) return false;
    return entities.some((left, leftIndex) => entities.slice(leftIndex + 1).some((right) => {
      const leftIds = memoryIdsByEntity.get(left) || new Set();
      const rightIds = memoryIdsByEntity.get(right) || new Set();
      return (leftIds.has(edge.from_id) && rightIds.has(edge.to_id))
        || (leftIds.has(edge.to_id) && rightIds.has(edge.from_id));
    }));
  });
}

function safeText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value); } catch { return ''; }
}

function legacyMetadata(row = {}) {
  const metadata = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const source = row?.source_metadata && typeof row.source_metadata === 'object' ? row.source_metadata : {};
  const nested = source?.metadata && typeof source.metadata === 'object' ? source.metadata : {};
  return { metadata, source, nested };
}

function rowSearchText(row = {}) {
  const { metadata, source, nested } = legacyMetadata(row);
  const tags = Array.isArray(row.tags) ? row.tags : [];
  const entities = [metadata.entities, source.entities, nested.entities, metadata.entity_names]
    .flatMap((value) => Array.isArray(value) ? value : (value ? [value] : []));
  return [row.title, row.content, row.snippet, row.document_title, row.filename,
    source.document_title, source.filename, metadata.source_title, metadata.filename,
    metadata.claim, source.claim, nested.claim, tags, entities]
    .map(safeText).filter(Boolean).join(' ');
}

function rowMentionsEntity(row, entity) {
  const needle = normalizeEntity(entity);
  return Boolean(needle && normalizeEntity(rowSearchText(row)).includes(needle));
}

function isUserAssertion(row = {}) {
  const { metadata, source, nested } = legacyMetadata(row);
  const tags = Array.isArray(row.tags) ? row.tags.map((tag) => String(tag).toLowerCase()) : [];
  const admission = metadata.memory_admission || source.memory_admission || nested.memory_admission;
  return admission === 'user_assertion' || tags.includes('provenance:user-assertion');
}

const RELATION_LANGUAGE = /\b(?:want(?:s|ed)?|work(?:s|ed)?\s+(?:with|for)|report(?:s|ed)?\s+to|colleague|coworker|friend|partner|married|spouse|sibling|parent|child|manager|manage(?:s|d)?|lead(?:s|ing)?|know(?:s|n)?|like(?:s|d)?|love(?:s|d)?|hate(?:s|d)?|meet(?:s|ing)?|met|spoke|speak(?:s|ing)?|sleep(?:s|ing)?\s+with|sex\s+with|fuck(?:s|ed|ing)?|related\s+to|connected\s+to|collaborat(?:e|es|ed|ing)\s+with)\b/iu;
const FIRST_PERSON = /\b(?:i|me|my|mine|myself)\b/iu;

export function findExplicitRelationClaims(rows = [], entities = [], { requesterProfile = '', requesterUserId = null } = {}) {
  const requested = [...new Set(entities.map((entity) => normalizeEntity(entity)).filter(Boolean))];
  if (requested.length < 2) return [];
  const normalizedProfile = normalizeEntity(requesterProfile);
  const requesterEntities = requested.filter((entity) => normalizedProfile.includes(entity));
  return rows.filter(Boolean).flatMap((row) => {
    const text = rowSearchText(row);
    if (!text || !RELATION_LANGUAGE.test(text)) return [];
    const normalizedText = normalizeEntity(text);
    const mentioned = requested.filter((entity) => normalizedText.includes(entity));
    const authoredByRequester = requesterUserId && row._author_user_id === requesterUserId;
    const firstPersonCandidate = mentioned.length >= 1
      && requesterEntities.some((entity) => !mentioned.includes(entity))
      && FIRST_PERSON.test(text);
    const firstPersonResolved = firstPersonCandidate && (isUserAssertion(row) || authoredByRequester);
    if (mentioned.length < 2 && !firstPersonCandidate) return [];
    return [{
      id: row.id || row.segment_id || row.segmentId || null,
      type: firstPersonResolved ? 'explicit_user_claim'
        : firstPersonCandidate ? 'legacy_unresolved_relation_claim' : 'explicit_relation_claim',
      entities,
      text: safeText(row.content || row.snippet || row.title).trim(),
      source_title: safeText(row.document_title || row.title || '').trim() || null,
      citation_status: firstPersonResolved ? 'user_assertion'
        : firstPersonCandidate ? 'legacy_unresolved_author' : 'stored_record',
      resolved_first_person: firstPersonResolved,
      unresolved_first_person: firstPersonCandidate && !firstPersonResolved,
      verified_graph_edge: false,
    }];
  }).slice(0, 12);
}

// Evidence is eligible for an as-of answer only when it carries explicit
// temporal provenance.  A semantically relevant document uploaded today is
// not proof of what was true at an earlier snapshot.  Memories already enforce
// valid/known time inside persisted retrieval; this closes the equivalent gap
// for raw evidence segments and rebuilds the packet from the filtered set.
function restrictEvidenceToTemporalSnapshot(result, { validAt = null, knownAt = null } = {}) {
  if (!result) return result;
  const validCutoff = validAt ? new Date(validAt).getTime() : null;
  const knownCutoff = knownAt ? new Date(knownAt).getTime() : null;
  if ((validCutoff == null || Number.isNaN(validCutoff))
      && (knownCutoff == null || Number.isNaN(knownCutoff))) return result;
  const temporalEvidence = (result.evidence || []).filter((row) => {
    const metadata = row?.metadata || {};
    if (validCutoff != null && !Number.isNaN(validCutoff)) {
      const start = row?.valid_from || row?.valid_at || metadata.valid_from || metadata.valid_at;
      const end = row?.valid_to || metadata.valid_to || null;
      const startMs = start ? new Date(start).getTime() : Number.NaN;
      const endMs = end ? new Date(end).getTime() : Number.NaN;
      if (!Number.isFinite(startMs) || startMs > validCutoff
          || (Number.isFinite(endMs) && endMs <= validCutoff)) return false;
    }
    if (knownCutoff != null && !Number.isNaN(knownCutoff)) {
      const known = row?.known_at || row?.knownAt || metadata.known_at || metadata.knownAt
        || row?.created_at || row?.createdAt || metadata.created_at;
      const knownMs = known ? new Date(known).getTime() : Number.NaN;
      if (!Number.isFinite(knownMs) || knownMs > knownCutoff) return false;
    }
    return true;
  });
  result.evidence = temporalEvidence;
  result.evidence_count = temporalEvidence.length;
  result.evidence_packet = buildEvidencePacket({
    memories: result.memories || [], evidence: temporalEvidence,
    graph: result.relationships || [], live: result.live || [],
    plan: result.trace?.recall_plan || {}, trace: result.trace || {},
    cutoffReason: result.trace?.cutoff_reason || null,
  });
  return result;
}

// ── Tool schemas (LLM-visible) ───────────────────────────────────────────────


// ── Dispatch handlers ────────────────────────────────────────────────────────

const TOOL_HANDLERS = {
  /**
   * Exact counting by SCAN, not sample.
   *
   * Recall answers "what is most similar" — it cannot answer "how many", because
   * top-K returns the most similar rows rather than all matching rows. Any count
   * derived from it is a guess wearing the clothes of a fact. Observed live: asked
   * "how many prospects from Hannover", the orchestrator correctly REFUSED to
   * count 5 sampled memories, because it had no tool that could scan. This is it.
   *
   * Tenant scoping is inherited from ctx (orgId/userId) exactly as every other
   * tool here does — never taken from args, so a model cannot widen its own scope
   * by asking. `complete` is the load-bearing field: false means the scan hit its
   * ceiling and the number is a LOWER BOUND. A wrong exact number is worse than an
   * honest refusal, so the count and its completeness always travel together.
   */
  /**
   * Exact tabular read. Tenant scope from ctx, never args — same rule as every
   * other tool here. Returns rows the caller can quote, not a ranked guess.
   */
  async hivemind_query_table(args, ctx) {
    if (!ctx.prisma?.documentTable) {
      return { rows: [], reason: 'table_store_unavailable' };
    }
    if (!ctx.orgId) return { rows: [], reason: 'no_tenant_scope' };
    const limit = Math.max(1, Math.min(Number(args?.limit) || 50, 200));
    try {
      const tables = await ctx.prisma.documentTable.findMany({
        where: {
          orgId: ctx.orgId,
          ...(args?.document_title
            ? { document: { title: { contains: String(args.document_title), mode: 'insensitive' } } }
            : {}),
        },
        select: { id: true, sheet: true, headers: true, rowCount: true, documentId: true },
        take: 10,
      });
      if (!tables.length) return { rows: [], tables: [], reason: 'no_matching_table' };
      const rows = await ctx.prisma.documentTableRow.findMany({
        where: { orgId: ctx.orgId, tableId: { in: tables.map((t) => t.id) } },
        orderBy: { rowIndex: 'asc' },
        take: limit * 4,
      });
      const needle = String(args?.contains || '').trim().toLowerCase();
      const col = String(args?.column || '').trim();
      const matched = needle
        ? rows.filter((r) => {
            const cells = r.cells || {};
            const vals = col ? [cells[col]] : Object.values(cells);
            return vals.some((v) => String(v ?? '').toLowerCase().includes(needle));
          })
        : rows;
      return {
        tables: tables.map((t) => ({ sheet: t.sheet, headers: t.headers, row_count: t.rowCount })),
        matched_rows: matched.length,
        complete: matched.length <= limit,
        rows: matched.slice(0, limit).map((r) => r.cells),
      };
    } catch (error) {
      return { rows: [], reason: `table_query_failed: ${error.message}` };
    }
  },

  async hivemind_count_where(args, ctx) {
    if (!ctx.prisma?.memory) {
      return { count: null, complete: false, reason: 'memory_store_unavailable', samples: [] };
    }
    const CEILING = Number(process.env.COUNT_WHERE_CEILING || 10000);
    const contains = String(args?.contains || '').trim();
    const tags = Array.isArray(args?.tags) ? args.tags.filter(Boolean).slice(0, 10) : [];
    const sampleN = Math.max(0, Math.min(Number(args?.return_samples ?? 5) || 0, 25));

    // Tenant boundary first, from ctx only.
    const where = { deletedAt: null };
    if (ctx.orgId) where.orgId = ctx.orgId;
    else if (ctx.userId) where.userId = ctx.userId;
    else return { count: null, complete: false, reason: 'no_tenant_scope', samples: [] };

    if (args?.memory_type) where.memoryType = String(args.memory_type);
    if (args?.source_platform) where.sourcePlatform = String(args.source_platform);
    if (args?.project) where.project = String(args.project);
    if (tags.length) where.tags = { hasEvery: tags };
    if (args?.created_after || args?.created_before) {
      where.createdAt = {};
      if (args.created_after) where.createdAt.gte = new Date(args.created_after);
      if (args.created_before) where.createdAt.lte = new Date(args.created_before);
    }
    if (contains) {
      where.OR = [
        { content: { contains, mode: 'insensitive' } },
        { title: { contains, mode: 'insensitive' } },
      ];
    }

    try {
      // count() is a real aggregate over the whole filtered set — no top-K, no
      // ranking, no similarity. That is the entire point of this tool.
      const count = await ctx.prisma.memory.count({ where });
      const samples = sampleN > 0
        ? await ctx.prisma.memory.findMany({
            where,
            select: { id: true, title: true, content: true, memoryType: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: sampleN,
          })
        : [];
      return {
        count,
        // Only false if the result set is implausibly large for one answer — the
        // count itself is still exact, but callers should paginate rather than
        // enumerate.
        complete: count <= CEILING,
        ceiling: CEILING,
        filter: { contains: contains || null, tags, memory_type: args?.memory_type || null,
          source_platform: args?.source_platform || null, project: args?.project || null },
        samples: samples.map((m) => ({
          id: m.id,
          title: m.title || String(m.content || '').slice(0, 60),
          preview: String(m.content || '').slice(0, 180),
          memory_type: m.memoryType,
          created_at: m.createdAt,
        })),
      };
    } catch (error) {
      // Never return a number we did not compute.
      return { count: null, complete: false, reason: `count_failed: ${error.message}`, samples: [] };
    }
  },

  async hivemind_aggregate_entities(args, ctx) {
    if (!ctx.prisma?.entity || !ctx.prisma?.entityMention) {
      return {
        count: null,
        entities: [],
        coverage: { complete: false, cutoff: false, reason: 'entity_index_unavailable' },
      };
    }
    const parentName = String(args.parent_name || '').trim();
    const parentCandidates = [...new Set([
      parentName,
      ...(Array.isArray(args.parent_candidates) ? args.parent_candidates : []),
    ].map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 12);
    const rawKind = String(args.entity_kind || '').trim().toLowerCase();
    const entityKind = rawKind.endsWith('s') ? rawKind.slice(0, -1) : rawKind;
    const limit = Math.max(1, Math.min(Number(args.limit) || 500, 1000));
    const parentForms = [...new Set(parentCandidates.flatMap((value) => [value, value.toLowerCase(), value.toUpperCase()]))];
    const parentEntities = await ctx.prisma.entity.findMany({
      where: {
        orgId: ctx.orgId,
        isActive: true,
        OR: [
          ...parentCandidates.map((value) => ({ canonicalName: { equals: value, mode: 'insensitive' } })),
          { aliases: { hasSome: parentForms } },
        ],
      },
      select: { id: true, canonicalName: true, aliases: true },
      take: 10,
    });
    if (parentEntities.length === 0) {
      return {
        count: null,
        entities: [],
        coverage: { complete: false, cutoff: false, reason: 'parent_entity_not_found' },
      };
    }

    const normalizeParent = (value) => String(value || '').trim().toLocaleLowerCase();
    const parentEntity = parentCandidates
      .map((candidate) => parentEntities.find((entity) => (
        normalizeParent(entity.canonicalName) === normalizeParent(candidate)
        || (entity.aliases || []).some((alias) => normalizeParent(alias) === normalizeParent(candidate))
      )))
      .find(Boolean) || parentEntities[0];
    const orgRole = String(ctx.accessContext?.orgRole || '').toLowerCase();
    const privilegedOrgReader = orgRole === 'owner' || orgRole === 'admin';
    const authorizedProjectTags = (ctx.accessContext?.projectIds || []).map((id) => `scope-key:project:${id}`);
    const accessibleDocument = {
      orgId: ctx.orgId,
      archivedAt: null,
      ...(ctx.projectId ? { tags: { has: `scope-key:project:${ctx.projectId}` } } : {}),
      ...(!ctx.projectId && !privilegedOrgReader
        ? {
            OR: [
              { userId: ctx.userId },
              // The upload writer emits `scope-key:org:<orgId>` (document-first-ingestion.js:
              // metadata.scope === 'organization' -> `org:${orgId}`), so the bare literal
              // `scope-key:organization` is NEVER written by that path. Matching only the
              // literal made every org-shared upload invisible to colleagues through the
              // agent's KB tool — fail-closed, so no leak, but org-wide sharing did not work.
              // Both forms accepted, matching evidence-retrieval.js and the .amr agent's
              // appendDocumentAccess, so all three paths answer identically.
              { tags: { hasSome: [`scope-key:org:${ctx.orgId}`, 'scope-key:organization'] } },
              { tags: { has: `scope-key:personal:${ctx.userId}` } },
              ...(authorizedProjectTags.length ? [{ tags: { hasSome: authorizedProjectTags } }] : []),
            ],
          }
        : {}),
    };
    const accessibleMemory = scopedMemoryWhere({
      user_id: ctx.userId,
      org_id: ctx.orgId,
      scope: 'all',
      access_context: ctx.projectId
        ? { ...(ctx.accessContext || {}), projectIds: [ctx.projectId] }
        : ctx.accessContext,
    });
    const parentMentions = await ctx.prisma.entityMention.findMany({
      where: {
        entityId: { in: parentEntities.map((entity) => entity.id) },
        OR: [
          { document: accessibleDocument },
          { memory: accessibleMemory },
        ],
      },
      select: { documentId: true, memoryId: true },
      take: 2001,
    });
    const parentCutoff = parentMentions.length > 2000;
    const documentIds = [...new Set(parentMentions.slice(0, 2000).map((row) => row.documentId).filter(Boolean))];
    const memoryIds = [...new Set(parentMentions.slice(0, 2000).map((row) => row.memoryId).filter(Boolean))];
    if (documentIds.length === 0 && memoryIds.length === 0) {
      return {
        count: 0,
        entities: [],
        parent: parentEntity.canonicalName,
        coverage: { complete: !parentCutoff, cutoff: parentCutoff, reason: parentCutoff ? 'parent_mention_cap' : null },
      };
    }

    const entities = await ctx.prisma.entity.findMany({
      where: {
        orgId: ctx.orgId,
        isActive: true,
        entityType: { equals: entityKind, mode: 'insensitive' },
        mentions: {
          some: {
            OR: [
              ...(documentIds.length ? [{ documentId: { in: documentIds } }] : []),
              ...(memoryIds.length ? [{ memoryId: { in: memoryIds } }] : []),
            ],
          },
        },
      },
      select: { id: true, canonicalName: true, aliases: true },
      orderBy: [{ canonicalName: 'asc' }],
      take: limit + 1,
    });
    const cutoff = parentCutoff || entities.length > limit;
    const members = entities.slice(0, limit);
    return {
      count: cutoff ? null : members.length,
      entity_kind: entityKind,
      parent: parentEntity.canonicalName,
      entities: members.map((entity) => ({
        id: entity.id,
        name: entity.canonicalName,
        aliases: entity.aliases || [],
      })),
      source_document_ids: documentIds.slice(0, 50),
      coverage: {
        complete: !cutoff,
        cutoff,
        reason: parentCutoff ? 'parent_mention_cap' : (entities.length > limit ? 'entity_cap' : null),
      },
    };
  },

  async hivemind_recall(args, ctx) {
    if (!ctx.persistentMemoryStore) throw new Error('memory store unavailable');

    // Single entry point — RecallRouter owns tier orchestration.
    // Memory-first, event-driven, no regex classifier. Memory layer's tags
    // are the routing oracle for evidence + live workspace lookups.
    const { RecallRouter, resolveRecallPlan, buildEvidencePacket, loadTypedGraphEvidence } = await import('../memory/recall-router.js');
    const router = new RecallRouter({
      persistentMemoryStore: ctx.persistentMemoryStore,
      evidenceRetrieval:     ctx.evidenceRetrieval,
      prisma:                ctx.prisma,
    });

    const requestedMode = args.mode || 'fact';
    const mode = normalizeAgentRecallMode(requestedMode);
    const requestedAnswerType = (typeof args.answer_type === 'string' && args.answer_type.trim())
      ? args.answer_type.trim().toLowerCase()
      : null;
    // `fact` is also the planner's generic document/entity read default. Making
    // it a hard predicate would incorrectly remove summaries and verbatim
    // evidence from broad source reads. Specific semantic kinds are strict;
    // fact remains a relevance hint unless a future plan explicitly supplies
    // memory_types=["fact"].
    const strictAnswerTypes = new Set(['decision', 'event', 'goal', 'preference', 'lesson', 'relationship']);
    const strictAnswerType = strictAnswerTypes.has(requestedAnswerType) ? requestedAnswerType : null;
    // The planner's answer_type is a retrieval contract, not merely a ranking
    // hint. Compile it into the canonical memory_types predicate once so the
    // memory and evidence lanes apply the same filter before the unified
    // rerank. The boost remains additive inside that already-typed pool.
    const recallPlan = resolveRecallPlan({
      ...args,
      memory_types: Array.isArray(args.memory_types) && args.memory_types.length
        ? args.memory_types
        : (strictAnswerType ? [strictAnswerType] : []),
      mode,
      explicit_mode: args._explicit_mode === true,
      structured_intent: args._structured_intent === true,
    });
    const planMode = recallPlan.mode;
    const recallStartedAt = Date.now();
    const originalQuery = args.query_original || args.query;
    const result = await router.recall(originalQuery, {
      mode:           planMode,
      explicit_mode:  args._explicit_mode === true,
      limit:          args.limit,
      tags:           args.tags,
      source_type:    args.source_type,
      source:         recallPlan.source,
      time:           recallPlan.time,
      // Keep the flat trusted planner fields as well as the normalized
      // structured objects. RecallRouter accepts both forms; the flat fields
      // preserve ordered direct-source selectors after the first normalization.
      source_kind:    args.source_kind,
      temporal_selector: args.temporal_selector,
      temporal_axis: recallPlan.time.axis,
      operation:      recallPlan.operation,
      include_superseded: recallPlan.operation === 'timeline' || args.include_superseded === true,
      // Date range — { start, end } ISO timestamps. Filters memories whose
      // document_date OR created_at falls in window. Used by agent's
      // today/yesterday/this-week shortcuts.
      include_live:   args.include_live === true,
      live_intent:    args.live_intent === true,
      scope_filter:   args.scope_filter,
      entity_filter_mode: recallPlan.entity_filter_mode,
      relationships: recallPlan.relationships,
      structured_intent: args._structured_intent === true,
      alternate_lexical_query: args.query_canonical_en && args.query_canonical_en !== originalQuery
        ? args.query_canonical_en
        : null,
      named_entities: args.entities || [],
      include_full_memory_content: args._include_full_memory_content === true,
      allow_semantic_source_recovery: args.allow_semantic_source_recovery === true,
      semantic_recovery: args.semantic_recovery === true,
      event_range: args._event_range === true,
      memory_types: recallPlan.memory_types,
      boost_memory_type: requestedAnswerType,
      reliability_v1: args.reliability_v1 === true,
    }, {
      userId:        ctx.userId,
      orgId:         ctx.orgId,
      projectId:     ctx.projectId,
      accessContext: ctx.accessContext,
      scopeFilter:   recallPlan.scope_filter,
    });
    // PROJECT-SCOPE POLICY — same authority as /api/recall (routes/recall.js).
    // The agent path calls router.recall DIRECTLY, bypassing the HTTP route, so
    // without this a projectless chat leaked project KB docs (Solvis whitepaper
    // answering an org-scope question) and a project-scoped chat was not
    // actually restricted to its project.
    await applyProjectScopeFilter(ctx.prisma, ctx.orgId, result, ctx.projectId || null);
    // Project filtering mutates the lane arrays. Filter the preserved mixed
    // ranking against those authorized rows as well; a rank cursor must never
    // retain an id that the scope gate removed.
    if (Array.isArray(result.ranked_candidates)) {
      const allowedMemories = new Set((result.memories || []).map((row) => row?.id).filter(Boolean));
      const allowedEvidence = new Set((result.evidence || []).map((row) => row?.segment_id || row?.segmentId || row?.id).filter(Boolean));
      result.ranked_candidates = result.ranked_candidates.filter((candidate) => candidate?.kind === 'memory'
        ? allowedMemories.has(candidate.memory_id)
        : allowedEvidence.has(candidate.segment_id));
    }
    const effectivePlan = result.trace?.recall_plan || recallPlan;

    let graph = Array.isArray(result.relationships) ? result.relationships : [];
    const graphBudget = effectivePlan.latency_budget_ms - (Date.now() - recallStartedAt);
    // Graph hydration is a distinct capability, not a mandatory appendage to
    // every hybrid recall.  The old default ran it for each ordinary recall
    // and for both snapshots of a diff, generating avoidable remote work and
    // filling an .amr tenant's relationship queue.  Relation and timeline
    // executors request their one graph read explicitly; callers may opt in
    // with include_graph for the documented raw-tool use case.
    const graphRequested = args.include_graph === true
      || effectivePlan.relationships?.requested === true
      || ['relation_between', 'timeline'].includes(String(effectivePlan.operation || ''));
    if (graphRequested && effectivePlan.max_graph_hops > 0 && result.memories.length > 0 && graphBudget > 1) {
      const loaded = await Promise.race([
        loadTypedGraphEvidence({
          prisma: ctx.prisma,
          memoryIds: result.memories.map((memory) => memory.id).filter(Boolean),
          userId: ctx.userId,
          orgId: ctx.orgId,
          accessContext: ctx.accessContext,
          time: effectivePlan.time,
        }),
        new Promise((resolve) => setTimeout(() => resolve({ items: [], reason: 'timeout' }), Math.min(500, graphBudget))),
      ]);
      graph = loaded.items || graph;
    }
    const cutoffReason = result.trace?.cutoff_reason || null;
    const evidencePacket = buildEvidencePacket({
      memories: result.memories,
      evidence: result.evidence,
      graph,
      live: result.live,
      plan: effectivePlan,
      trace: result.trace,
      cutoffReason,
    });

    // P2 salience feedback: reinforce every recalled memory (agent + MCP
    // surface). Mirrors the /api/recall tap — bump recall_count + nudge
    // strength + stamp lastAccessedAt. Fire-and-forget, never blocks the
    // tool response. strength is read-clamped to [0.1,1.0] downstream.
    if (ctx.prisma && Array.isArray(result.memories) && result.memories.length > 0) {
      const recalledIds = result.memories.map((m) => m.id).filter(Boolean);
      if (recalledIds.length > 0) {
        ctx.prisma.memory.updateMany({
          where: { id: { in: recalledIds } },
          data: {
            lastAccessedAt: new Date(),
            recallCount: { increment: 1 },
            strength: { increment: 0.05 },
          },
        }).catch(() => {});
        // Self-host: central updateMany no-ops (rows on the agent) — mirror to agent.
        try { amrBumpRecall(ctx.orgId, recalledIds); } catch { /* best-effort */ }
      }
    }

    // mode='insight' expansion: pull every synthesis row's evidence chain so
    // the agent sees both the curated claim AND its source memories. Quick
    // mode already returns the top synthesis + 2 evidence ids; insight mode
    // expands ALL synthesis rows up to 4 evidence ids each. Bound by ctx.prisma.
    let synthEvidenceChains = null;
    const remainingRecallBudget = () => Math.max(0, effectivePlan.latency_budget_ms - (Date.now() - recallStartedAt));
    if ((mode === 'explain' || mode === 'full') && ctx.prisma && remainingRecallBudget() > 1) {
      const synthRows = (result.memories || []).filter(m => {
        const srcType = m.source_metadata?.source_type;
        const tags = m.tags || [];
        return srcType === 'canonical-fact' || srcType === 'synthesis-bridge'
            || tags.includes('synthesis:canonical') || tags.includes('synthesis:bridge');
      });
      if (synthRows.length > 0) {
        const boundedSynthRows = synthRows.slice(0, 5);
        const evidenceIds = [...new Set(boundedSynthRows.flatMap((synth) =>
          (synth.synthesis_evidence_ids || synth.synthesisEvidenceIds || []).slice(0, 4)))];
        try {
          const hydration = orgIsRemote(ctx.orgId)
            ? remoteHydrate(ctx.orgId, evidenceIds)
            : ctx.prisma.memory.findMany({
                where: { id: { in: evidenceIds }, deletedAt: null },
                select: { id: true, title: true, content: true, tags: true, createdAt: true },
              });
          const rawRows = await Promise.race([
            hydration,
            new Promise((resolve) => setTimeout(() => resolve([]), remainingRecallBudget())),
          ]);
          const rows = (rawRows || []).map((r) => ({
            id: r.memory_id || r.id,
            title: r.title || null,
            content: r.content || '',
            tags: r.tags || [],
            createdAt: r.created_at || r.createdAt || null,
          }));
          const byId = new Map(rows.map((row) => [row.id, row]));
          synthEvidenceChains = boundedSynthRows.map((synth) => ({
            synthesis_id: synth.id,
            synthesis_title: synth.title,
            evidence: (synth.synthesis_evidence_ids || synth.synthesisEvidenceIds || [])
              .slice(0, 4)
              .map((id) => byId.get(id))
              .filter(Boolean)
              .map((row) => ({
                id: row.id,
                title: row.title,
                content: row.content.slice(0, 240),
                created_at: row.createdAt,
              })),
          })).filter((chain) => chain.evidence.length > 0);
        } catch (chainErr) {
          console.warn('[hivemind_recall] insight chain fetch failed:', chainErr.message);
        }
      }
    }

    return {
      mode: requestedMode,
      mode_used: effectivePlan.mode,
      recall_plan: effectivePlan,
      count:          result.memories.length,
      memories:       result.memories,
      live_count:     result.live.length,
      live:           result.live,
      evidence_count: result.evidence.length,
      evidence:       result.evidence,
      ranked_candidates: result.ranked_candidates || [],
      timeline:       effectivePlan.operation === 'timeline' ? result.memories : [],
      relationships:  graph,
      evidence_packet: evidencePacket,
      ...(synthEvidenceChains ? { synthesis_evidence_chains: synthEvidenceChains } : {}),
      trace:          result.trace,
    };
  },

  async hivemind_relation_between(args, ctx) {
    const entities = [...new Set((args.entities || []).map((entity) => String(entity).trim()).filter(Boolean))].slice(0, 6);
    if (entities.length < 2) return { error: 'at_least_two_entities_required' };
    const shared = {
      // explain (not fact) per entity lane: compare/relation needs each entity's
      // EVIDENCE, not just its top current facts. Fact mode skips evidence
      // expansion, so "Compare SolvisPia and SolvisLea" recalled only brand-level
      // memories and reported both absent though each has 28-31 KB segments.
      // explain pulls each entity's document evidence so synthesis can actually
      // compare them. limit bumped 5→8 for the richer two-entity merge.
      mode: 'explain', limit: 15,
      ...(args.source_document_id ? { source_document_id: args.source_document_id } : {}),
      ...(args.source_title ? { source_title: args.source_title } : {}),
      ...(args.valid_at ? { valid_at: args.valid_at } : {}),
      ...(args.known_at ? { known_at: args.known_at } : {}),
    };
    const recalled = await Promise.all(entities.map((entity) =>
      TOOL_HANDLERS.hivemind_recall({
        ...shared,
        query: entity,
        query_original: entity,
        query_canonical_en: entity,
      }, ctx)));
    const memories = new Map();
    const evidence = new Map();
    const edges = new Map();
    const memoryIdsByEntity = new Map();
    recalled.forEach((result, index) => {
      const ids = new Set();
      for (const memory of (result?.memories || [])) {
        if (!memory?.id || !rowMentionsEntity(memory, entities[index])) continue;
        ids.add(memory.id);
        if (!memories.has(memory.id)) memories.set(memory.id, memory);
      }
      memoryIdsByEntity.set(entities[index], ids);
      for (const item of (result?.evidence || [])) {
        if (!rowMentionsEntity(item, entities[index])) continue;
        const key = item?.id || `${item?.document_id || item?.document_title}|${item?.page || ''}|${String(item?.content || item?.snippet || '').slice(0, 80)}`;
        if (!evidence.has(key)) evidence.set(key, item);
      }
      for (const edge of (result?.relationships || [])) {
        if (edge?.from_id && edge?.to_id && edge?.type) edges.set(`${edge.from_id}|${edge.to_id}|${edge.type}`, edge);
      }
    });

    const anchorIds = [...memories.keys()];
    if (anchorIds.length) {
      const graphResult = await loadTypedGraphEvidence({
        prisma: ctx.prisma,
        memoryIds: anchorIds,
        userId: ctx.userId,
        orgId: ctx.orgId,
        accessContext: ctx.accessContext || {},
        time: { known_at: args.known_at || null },
      }).catch(() => ({ items: [] }));
      for (const edge of (graphResult.items || [])) {
        if (edge?.from_id && edge?.to_id && edge?.type) edges.set(`${edge.from_id}|${edge.to_id}|${edge.type}`, edge);
      }
    }

    const allEdges = [...edges.values()];
    const directEdges = findDirectEntityEdges(allEdges, entities, memoryIdsByEntity);
    let relationRows = [...memories.values(), ...evidence.values()];
    if (ctx.prisma?.memory && memories.size) {
      const ownership = await ctx.prisma.memory.findMany({
        // IDs came from authorized tenant-scoped recall above. Legacy rows may
        // have null/stale org_id, so reapplying a modern org predicate here
        // incorrectly discards their author while widening no readable set.
        where: { id: { in: [...memories.keys()] }, deletedAt: null },
        select: { id: true, userId: true, scope: true },
      }).catch(() => []);
      const ownershipById = new Map(ownership.map((row) => [row.id, row]));
      relationRows = relationRows.map((row) => {
        const owner = ownershipById.get(row?.id);
        return owner ? { ...row, _author_user_id: owner.userId, _memory_scope: owner.scope } : row;
      });
    }
    const explicitClaims = findExplicitRelationClaims(
      relationRows,
      entities,
      {
        requesterProfile: `${ctx._compactProfileContext || ''} ${relationRows
          .filter((row) => /\b(?:user profile|user name)\b/i.test(rowSearchText(row)))
          .map(rowSearchText).join(' ')}`,
        requesterUserId: ctx.userId,
      },
    );
    const explicitClaimIds = new Set(explicitClaims.map((claim) => claim.id).filter(Boolean));
    const claimMemories = [...memories.values()].filter((memory) => explicitClaimIds.has(memory.id));
    // Keep at least one descriptive row for every requested entity inside the
    // smallest progressive answer window.  Putting every relation claim first
    // made a compound "who is X and how are X/Y related" turn retrieve the
    // relationship claims correctly but starve the identity clause before
    // synthesis.  The relation claim remains rank 1; entity descriptions are
    // interleaved before the remaining claims, then the ordinary recall order
    // continues unchanged.
    const descriptiveScore = (memory) => {
      const text = rowSearchText(memory);
      const objective = /\b(?:colleague|coworker|work(?:s|ed)?|based|born|joined|reports?\s+to|led|attended|presented|coordinated|manager|role|office|team)\b/iu.test(text) ? 10 : 0;
      const subjective = /\b(?:good|bad|nice|really|beautiful|awful)\b/iu.test(text) ? 5 : 0;
      return objective - subjective;
    };
    const descriptiveByEntity = entities.map((entity) => [...memories.values()]
      .filter((memory) => !explicitClaimIds.has(memory.id) && rowMentionsEntity(memory, entity))
      .sort((left, right) => descriptiveScore(right) - descriptiveScore(left))[0]).filter(Boolean);
    const orderedMemories = [];
    const appendUnique = (memory) => {
      if (memory?.id && !orderedMemories.some((item) => item.id === memory.id)) orderedMemories.push(memory);
    };
    appendUnique(claimMemories[0]);
    descriptiveByEntity.forEach(appendUnique);
    claimMemories.slice(1).forEach(appendUnique);
    [...memories.values()].forEach(appendUnique);
    const sourceGroups = new Map();
    for (const [entity, ids] of memoryIdsByEntity.entries()) {
      for (const id of ids) {
        const memory = memories.get(id);
        const tags = Array.isArray(memory?.tags) ? memory.tags : [];
        const taggedDocumentId = tags.find((tag) => typeof tag === 'string' && tag.startsWith('doc-id:'))?.slice('doc-id:'.length);
        const taggedSourceId = tags.find((tag) => typeof tag === 'string' && tag.startsWith('source-id:'))?.slice('source-id:'.length);
        const taggedFilename = tags.find((tag) => typeof tag === 'string' && tag.startsWith('filename:'))?.slice('filename:'.length);
        const sourceId = memory?.source_metadata?.document_id
          || memory?.source_metadata?.source_id
          || memory?.source_id
          || taggedDocumentId
          || taggedSourceId
          || taggedFilename
          || null;
        if (!sourceId) continue;
        if (!sourceGroups.has(sourceId)) sourceGroups.set(sourceId, new Map());
        sourceGroups.get(sourceId).set(entity, id);
      }
    }
    const sharedPaths = [...sourceGroups.entries()]
      .filter(([, members]) => members.size >= 2)
      .slice(0, 12)
      .map(([source_id, members]) => ({
        type: 'shared_source', source_id,
        entities: [...members.keys()], memory_ids: [...members.values()], verified_relation: false,
      }));
    const relationPacket = buildEvidencePacket({
      memories: orderedMemories, evidence: [...evidence.values()],
      graph: allEdges, live: [], plan: { operation: 'relation_between', entities },
      trace: { operation: 'relation_between' },
    });
    return {
      entities,
      direct_edges: directEdges,
      explicit_relation_claims: explicitClaims,
      shared_paths: sharedPaths,
      co_mentions: sharedPaths.map((path) => ({ ...path, type: 'co_mention' })),
      verified_relation_found: directEdges.length > 0,
      grounded_relation_claim_found: explicitClaims.length > 0,
      memories: orderedMemories, evidence: [...evidence.values()],
      relationships: allEdges, evidence_packets: [relationPacket],
      coverage: {
        requested_entities: entities,
        resolved_entities: entities.filter((entity) => (memoryIdsByEntity.get(entity)?.size || 0) > 0),
        complete: entities.every((entity) => (memoryIdsByEntity.get(entity)?.size || 0) > 0),
      },
    };
  },

  async hivemind_save_memory(args, ctx) {
    if (!ctx.persistentMemoryEngine || !ctx.buildRoutedIngestPayloads) {
      throw new Error('ingest pipeline unavailable');
    }
    // Coerce memory_type to a valid Prisma enum value. Models routinely
    // emit 'note', 'observation', 'todo' etc — they're sensible English
    // but not in our locked enum. Map known synonyms; fall back to 'fact'.
    // One shared taxonomy is used by REST, chat saves and the graph engine.
    // `relationship` is accepted for old callers but normalized to `fact` for
    // new writes because relationships belong in the graph edge store.
    let memType = normalizeMemoryType(args.memory_type, { allowLegacy: false });

    // Resolve project scoping. The agent may pass:
    //   • project_id (UUID — direct)
    //   • project    (name or slug — server-side resolveScopedIngestPayload
    //                  converts to project_id via the user's access_context)
    //   • scope      (personal | project | team | organization — defaults
    //                  to personal when nothing supplied)
    // When project_id OR project is set, scope auto-elevates to 'project'
    // unless the caller explicitly chose otherwise.
    //
    // Chat orchestration opts into _require_explicit_scope. This is an
    // authority boundary: a durable statement authorizes saving, but does not
    // authorize silently deciding whether it belongs to personal, organization,
    // team, or one of several projects. Other first-party API callers retain
    // their explicit payload contract; only chat-originated saves ask.
    const requireExplicitScope = args._require_explicit_scope === true;
    const explicitScope = typeof args.scope === 'string' ? args.scope.toLowerCase() : null;

    // Resolve project name/slug → UUID against the user's access list.
    // Server-side resolveScopedIngestPayload only understands project_id(s),
    // so we lift the name lookup up here where we have prisma + accessContext.
    let resolvedProjectId = args.project_id || null;
    // Non-chat API callers may use the request-level scope. Chat saves may not:
    // merely viewing a project is not an explicit choice to store this fact
    // there.
    if (!requireExplicitScope && !resolvedProjectId && ctx.projectId) {
      resolvedProjectId = ctx.projectId;
    }
    if (resolvedProjectId) {
      const accessProjectIds = Array.isArray(ctx.accessContext?.projectIds)
        ? ctx.accessContext.projectIds
        : [];
      if (!accessProjectIds.includes(resolvedProjectId)) {
        return { saved: false, error: 'project_access_denied', project_id: resolvedProjectId };
      }
    }
    let resolvedProjectName = null;
    if (resolvedProjectId && ctx.persistentMemoryStore?.client?.project) {
      const project = await ctx.persistentMemoryStore.client.project.findFirst({
        where: { id: resolvedProjectId, orgId: ctx.orgId }, select: { name: true },
      }).catch(() => null);
      resolvedProjectName = project?.name || null;
    }
    if (!resolvedProjectId && args.project && ctx.persistentMemoryStore?.client?.project) {
      const accessProjectIds = (ctx.accessContext?.projectIds) || [];
      if (accessProjectIds.length > 0) {
        const q = String(args.project).trim();
        const hit = await ctx.persistentMemoryStore.client.project.findFirst({
          where: {
            id: { in: accessProjectIds },
            orgId: ctx.orgId,
            OR: [
              { slug: { equals: q, mode: 'insensitive' } },
              { name: { equals: q, mode: 'insensitive' } },
              { name: { contains: q, mode: 'insensitive' } },
            ],
          },
          select: { id: true, name: true },
        });
        if (hit) {
          resolvedProjectId = hit.id;
          resolvedProjectName = hit.name;
        }
      }
    }

    // A chat save with no stated destination pauses before any semantic project
    // classification or personal fallback. Returning the complete scope menu
    // lets every client render the same explicit choice; no data is written.
    if (requireExplicitScope && !resolvedProjectId && (!explicitScope || explicitScope === 'project')) {
      const accessProjectIds = (ctx.accessContext?.projectIds) || [];
      const projects = ctx.persistentMemoryStore?.client?.project && accessProjectIds.length > 0
        ? await ctx.persistentMemoryStore.client.project.findMany({
            where: { id: { in: accessProjectIds }, orgId: ctx.orgId, status: 'active' },
            select: { id: true, name: true, slug: true },
          }).catch(() => [])
        : [];
      return {
        saved: false,
        needs_project_choice: true,
        message: 'Memory destination was not stated. Ask the user to choose a personal, organization, team, or authorized project scope before saving; do not retry the save yourself.',
        scope_options: [
          { scope: 'personal', label: 'Personal' },
          { scope: 'organization', label: 'Organization' },
          { scope: 'team', label: 'Team' },
        ],
        projects,
        draft: { title: args.title, content: args.content, tags: args.tags || [], memory_type: memType },
      };
    }

    // Auto-classify the project from name+description when the caller gave no
    // project and no explicit scope. Confident match → assign silently;
    // ambiguous → return needs_project_choice (with a pre-selected suggestion)
    // so the UI asks; nothing fits → personal. Honors the org memory_save_policy
    // ('org-wide' → org scope; 'ask' → always ask; else → semantic classify).
    let autoScope = null; // set to 'organization' when policy routes org-wide
    if (!requireExplicitScope && !resolvedProjectId && !explicitScope && ctx.persistentMemoryStore?.client?.project) {
      const accessProjectIds = (ctx.accessContext?.projectIds) || [];
      if (accessProjectIds.length > 0) {
        const projs = await ctx.persistentMemoryStore.client.project.findMany({
          where: { id: { in: accessProjectIds }, orgId: ctx.orgId, status: 'active' },
          select: { id: true, name: true, slug: true, description: true },
        }).catch(() => []);
        if (projs.length > 0) {
          let policy = 'private';
          try {
            const org = await ctx.persistentMemoryStore.client.organization.findUnique({
              where: { id: ctx.orgId }, select: { memorySavePolicy: true },
            });
            policy = org?.memorySavePolicy || 'private';
          } catch { /* default private → classify */ }
          const res = await resolveProjectForSave({
            text: `${args.title || ''}\n${args.content || ''}\n${(args.tags || []).join(' ')}`,
            projects: projs,
            policy,
          });
          if (res.decision === 'auto' && res.projectId) {
            resolvedProjectId = res.projectId;
            resolvedProjectName = res.projectName || null;
          } else if (res.decision === 'org') {
            autoScope = 'organization';
          } else if (res.decision === 'ask') {
            return {
              saved: false,
              needs_project_choice: true,
              message: 'Ambiguous which project this belongs to. Ask the user (buttons shown); the suggested project is pre-selected. Do not retry the save yourself.',
              suggested_project_id: res.suggestedId || null,
              projects: projs.map(p => ({ id: p.id, name: p.name, slug: p.slug })),
              draft: { title: args.title, content: args.content, tags: args.tags || [], memory_type: memType },
            };
          }
          // 'personal' → fall through (resolvedProjectId stays null)
        }
      }
    }

    const hasProject = Boolean(resolvedProjectId);
    const scope = ['personal', 'project', 'team', 'organization'].includes(explicitScope)
      ? explicitScope
      : (hasProject ? 'project' : (autoScope || 'personal'));

    const memoryAdmission = args._memory_admission === 'user_assertion' ? 'user_assertion' : 'trusted_fact';
    const provenanceTag = memoryAdmission === 'user_assertion' ? 'provenance:user-assertion' : 'provenance:user-fact';
    const plannedEntities = [...new Set((Array.isArray(args.entities) ? args.entities : [])
      .map((entity) => String(entity || '').trim()).filter(Boolean))].slice(0, 12);
    // Planner-selected entities are already part of the canonical save
    // contract. Persist their normalized tags in the same write so a just-saved
    // memory is entity-recallable before asynchronous enrichment completes (or
    // even when the enrichment model returns malformed JSON). The canonical
    // linker still refines entities and typed relationships afterwards.
    const plannedEntityTags = plannedEntities
      .map((entity) => normalizeEntity(entity))
      .filter(Boolean)
      .map((slug) => `entity:${slug}`);
    const payload = {
      title: args.title,
      content: args.content,
      tags: Array.from(new Set([...(args.tags || []), provenanceTag, ...plannedEntityTags])),
      memory_type: memType,
      user_id: ctx.userId,
      org_id: ctx.orgId,
      scope,
      project_ids: resolvedProjectId ? [resolvedProjectId] : [],
      entities: plannedEntities,
      ...(args.event_time ? { document_date: args.event_time, event_time: args.event_time, valid_from: args.event_time } : {}),
      source_metadata: {
        source_platform: 'talk-to-hive', source_type: 'chat-turn', via: 'react-agent',
        source_id: args._source_id || null,
        original_content: args._original_content || args.content,
        metadata: { memory_admission: memoryAdmission },
      },
    };
    let saved;
    if (ctx.ingestCanonicalPayload) {
      saved = await ctx.ingestCanonicalPayload(payload, { sourceType: 'mcp', mode: 'atomic' });
    } else {
      const [routed] = await ctx.buildRoutedIngestPayloads(payload, { smartIngestRouter: ctx.smartIngestRouter });
      saved = ctx.ingestRoutedPayload
        ? await ctx.ingestRoutedPayload(routed, ctx.persistentMemoryEngine)
        : await ctx.persistentMemoryEngine.ingestMemory(routed);
    }
    const id = saved?.parentId || saved?.id || saved?.memoryId || saved?.memory?.id || null;
    // Chat writes use canonical ingestion directly, so they previously skipped
    // server.js's upload-only profile extraction hook. Derive caller profile
    // facts only after the canonical memory is durable. ProfileStore itself
    // accepts first-person statements and self-name aliases, never arbitrary
    // third-party claims.
    let profileFacts = [];
    let profileMemoryId = null;
    if (ctx.prisma && ctx.userId && typeof args.content === 'string') {
      try {
        const { getSharedProfileStore } = await import('../memory/profile-store.js');
        profileFacts = await getSharedProfileStore(ctx.prisma).extractAndStore(args.content, {
          userId: ctx.userId,
          orgId: ctx.orgId,
          memoryId: id,
        });
        // If a caller explicitly filed a self-profile statement outside their
        // personal scope, retain a private canonical copy too. The shared
        // memory stays exactly where the user chose; the personal copy gives
        // the profile fact durable private recall/history without silently
        // changing the selected destination.
        if (profileFacts.length && scope !== 'personal') {
          const profilePayload = {
            title: 'User profile update',
            content: args.content,
            tags: Array.from(new Set(['profile', 'source:chat', 'provenance:user-fact', ...plannedEntityTags])),
            memory_type: memType,
            user_id: ctx.userId,
            org_id: ctx.orgId,
            scope: 'personal',
            project_ids: [],
            source_metadata: {
              source_platform: 'talk-to-hive', source_type: 'profile-update', via: 'react-agent',
              mirrors_memory_id: id,
            },
          };
          const mirrored = ctx.ingestCanonicalPayload
            ? await ctx.ingestCanonicalPayload(profilePayload, { sourceType: 'mcp', mode: 'atomic' })
            : null;
          profileMemoryId = mirrored?.parentId || mirrored?.id || mirrored?.memoryId || mirrored?.memory?.id || null;
        }
      } catch (profileError) {
        // The canonical memory write is authoritative. A profile derivation
        // failure must be observable but must never turn a completed save into
        // a failed user action.
        console.warn('[hivemind_save_memory] profile derivation failed:', profileError.message);
      }
    }
    // SURFACE A CONTRADICTION THE SAVE JUST DETECTED.
    // graph-engine records every edge it wrote in `edgesCreated`, including
    // Contradicts, but this handler dropped the whole array — so a save that
    // KNEW it conflicted with an existing memory still answered "saved" and the
    // user found out never. Returning the conflicting memories (hydrated to a
    // short snippet, so the answer can name the thing rather than an id) lets the
    // reply say "saved — note this may conflict with <X>". Only Contradicts is
    // surfaced: Updates/Extends are normal evolution and would be noise.
    let conflicts;
    try {
      const _c = (saved?.edgesCreated || []).filter((e) => e?.type === 'Contradicts' && e?.to);
      if (_c.length) {
        const _store = ctx.persistentMemoryEngine?.store;
        const _hydrated = _store?.getMemories ? await _store.getMemories(_c.map((e) => e.to)) : null;
        conflicts = _c.slice(0, 3).map((e) => {
          const m = _hydrated?.get?.(e.to);
          return {
            memory_id: e.to,
            title: m?.title || null,
            snippet: String(m?.content || '').slice(0, 160) || null,
            reasoning: e.reasoning || null,
          };
        });
      }
    } catch { /* a failed hydrate must never fail the save */ }
    return {
      saved: true,
      id,
      title: args.title,
      operation: saved?.operation || null,
      profile_facts: profileFacts,
      profile_memory_id: profileMemoryId,
      ...(conflicts?.length ? { conflicts } : {}),
      childCount: saved?.childIds?.length ?? null,
      scope,
      project_id: resolvedProjectId,
      project: resolvedProjectName || args.project || null,
      project_resolution: args.project && !args.project_id
        ? (resolvedProjectId ? 'resolved' : 'not_found_defaulted_personal')
        : null,
    };
  },

  async hivemind_update_memory(args, ctx) {
    if (!ctx.persistentMemoryStore || !ctx.persistentMemoryEngine?.ingestMemory) {
      throw new Error('versioned memory update unavailable');
    }
    let targetId = args.id || null;
    if (!targetId && args.target_query) {
      if (args.project_id && !(ctx.accessContext?.projectIds || []).includes(args.project_id)) {
        return { updated: false, error: 'project_access_denied' };
      }
      const normalizedTarget = String(args.target_query).trim().toLocaleLowerCase();
      const prisma = ctx.prisma || ctx.persistentMemoryStore?.client;
      if (prisma?.memory) {
        const accessContext = args.project_id
          ? { ...(ctx.accessContext || {}), projectIds: [args.project_id] }
          : ctx.accessContext;
        const exactCandidates = await prisma.memory.findMany({
          where: {
            ...scopedMemoryWhere({
              user_id: ctx.userId,
              org_id: ctx.orgId,
              scope: 'all',
              access_context: accessContext,
            }),
            isLatest: true,
            ...(args.project_id ? {
              scope: 'project',
              memoryProjects: { some: { projectId: args.project_id } },
            } : {}),
            OR: [
              { title: { equals: args.target_query, mode: 'insensitive' } },
              { tags: { has: args.target_query } },
            ],
          },
          select: { id: true },
          take: 2,
        }).catch(() => []);
        if (exactCandidates.length === 1) targetId = exactCandidates[0].id;
        else if (exactCandidates.length > 1) {
          return {
            updated: false,
            needs_memory_choice: true,
            candidates: exactCandidates.map(({ id }) => ({ id })),
          };
        }
      }
      if (!targetId) {
      const recalled = await TOOL_HANDLERS.hivemind_recall({
        query: args.target_query, mode: 'fact', limit: 5,
      }, args.project_id ? { ...ctx, projectId: args.project_id } : ctx);
      const candidates = (recalled?.memories || []).filter((memory) => memory?.id && memory.is_latest !== false);
      const exact = candidates.filter((memory) => String(memory.title || '').trim().toLocaleLowerCase() === normalizedTarget);
      if (exact.length === 1) {
        targetId = exact[0].id;
      } else {
        const first = candidates[0];
        const second = candidates[1];
        const firstScore = Number(first?.score || 0);
        const secondScore = Number(second?.score || 0);
        if (first && firstScore >= 0.72 && (firstScore - secondScore >= 0.10 || !second)) {
          targetId = first.id;
        } else {
          return {
            updated: false,
            needs_memory_choice: true,
            candidates: candidates.slice(0, 5).map((memory) => ({
              id: memory.id, title: memory.title, snippet: String(memory.content || '').slice(0, 240), score: memory.score,
            })),
          };
        }
      }
      }
    }
    if (!targetId) {
      console.warn(`[hivemind_update_memory] FAIL memory_target_required user=${ctx.userId} org=${ctx.orgId} target_query=${JSON.stringify(args.target_query || null)} id=${JSON.stringify(args.id || null)}`);
      return { updated: false, error: 'memory_target_required' };
    }
    const existing = await ctx.persistentMemoryStore.getMemoryScoped?.(targetId, {
      user_id: ctx.userId, org_id: ctx.orgId, access_context: ctx.accessContext,
    });
    if (!existing) {
      console.warn(`[hivemind_update_memory] FAIL memory_not_found_or_forbidden user=${ctx.userId} org=${ctx.orgId} targetId=${targetId}`);
      return { updated: false, error: 'memory_not_found_or_forbidden' };
    }
    if (existing.is_latest === false || existing.isLatest === false) {
      console.warn(`[hivemind_update_memory] FAIL memory_target_is_superseded user=${ctx.userId} org=${ctx.orgId} targetId=${targetId}`);
      return { updated: false, error: 'memory_target_is_superseded' };
    }
    let result;
    try {
      result = await ctx.persistentMemoryEngine.ingestMemory({
      title: args.title || existing.title,
      content: args.content || existing.content,
      tags: Array.isArray(args.tags) ? args.tags : (existing.tags || []),
      memory_type: existing.memory_type || 'fact',
      user_id: ctx.userId,
      org_id: ctx.orgId,
      scope: existing.scope || 'personal',
      project_ids: existing.project_ids || [],
      relationship: { type: 'Updates', target_id: targetId, confidence: 1.0 },
      _authorized_relationship: true,
      source_metadata: {
        source_type: 'chat-update',
        source_id: targetId,
        metadata: { update_reason: args.reason || null, original_target_query: args.target_query || null },
      },
      ...(args.event_time ? { document_date: args.event_time, event_time: args.event_time, valid_from: args.event_time } : {}),
      });
    } catch (err) {
      // Previously an ingestMemory throw propagated up as an opaque tool failure
      // with NO server log — "update tool failed" in chat with nothing to see in
      // `docker logs`. Log the real cause and return it as a structured result so
      // the agent can explain it instead of hard-erroring the turn.
      console.error(`[hivemind_update_memory] ingestMemory THREW user=${ctx.userId} org=${ctx.orgId} targetId=${targetId}: ${err?.message}`, err?.stack?.split('\n').slice(0, 3).join(' | '));
      return { updated: false, error: 'update_write_failed', detail: err?.message || String(err) };
    }
    return {
      updated: true,
      id: result?.memoryId || result?.id || null,
      deprecated_id: targetId,
      operation: result?.operation || 'updated',
      reason: args.reason,
      edges_created: result?.id || result?.memoryId
        ? [{ type: 'Updates', from_id: result?.memoryId || result?.id, to_id: targetId }]
        : [],
    };
  },

  async hivemind_get_memory(args, ctx) {
    if (!ctx.persistentMemoryStore) throw new Error('memory store unavailable');
    const m = await ctx.persistentMemoryStore.getMemoryScoped?.(args.id, {
      user_id: ctx.userId, org_id: ctx.orgId, access_context: ctx.accessContext,
    });
    if (!m) return { found: false };
    return {
      found: true,
      id: m.id,
      title: m.title,
      content: m.content,
      memory_type: m.memory_type,
      tags: m.tags,
      created_at: m.created_at,
    };
  },

  async tara_call_get(args, ctx) {
    if (!ctx.prisma || !ctx.orgId) throw new Error('tara_call_store_unavailable');
    const reference = String(args.reference || '').trim().replace(/^tara-call:/, '');
    if (!reference) return { found: false };
    const call = await ctx.prisma.taraCall.findFirst({
      where: {
        orgId: ctx.orgId,
        OR: [
          ...(/^[0-9a-f-]{36}$/i.test(reference) ? [{ id: reference }] : []),
          { sessionId: reference },
        ],
      },
    });
    if (!call) return { found: false };
    const [turns, insight] = await Promise.all([
      ctx.prisma.taraTurn.findMany({
        where: { callId: call.id, orgId: ctx.orgId },
        orderBy: { seq: 'asc' },
        select: { id: true, seq: true, userText: true, agentText: true, createdAt: true },
      }),
      ctx.prisma.taraInsight.findFirst({ where: { callId: call.id, orgId: ctx.orgId } }),
    ]);
    return {
      found: true,
      call: {
        id: call.id, session_id: call.sessionId, provider: call.provider, status: call.status,
        goal: call.goal, language: call.language, turn_count: call.turnCount,
        duration_ms: call.durationMs, started_at: call.startedAt, ended_at: call.endedAt,
      },
      transcript_ref: `tara-call:${call.id}`,
      turns: turns.map((turn) => ({
        id: turn.id, seq: turn.seq, user_text: turn.userText, agent_text: turn.agentText, created_at: turn.createdAt,
      })),
      insight: insight ? { id: insight.id, summary: insight.summary, data: insight.data, created_at: insight.createdAt } : null,
    };
  },

  async hivemind_list_memories(args, ctx) {
    if (!ctx.persistentMemoryStore) throw new Error('memory store unavailable');
    const list = await ctx.persistentMemoryStore.listMemories({
      user_id: ctx.userId,
      org_id: ctx.orgId,
      tags: args.tags,
      memory_type: args.memory_type,
      limit: Math.min(args.limit || 20, 100),
      since: args.since ? new Date(args.since) : undefined,
    });
    const rows = Array.isArray(list) ? list
      : (Array.isArray(list?.memories) ? list.memories : []);
    return { count: rows.length, memories: rows.map((m) => ({ id: m.id, title: m.title, tags: m.tags, created_at: m.created_at })) };
  },

  async hivemind_delete_memory(args, ctx) {
    if (!ctx.persistentMemoryStore) throw new Error('memory store unavailable');
    if (!args._approval_token || ctx._approvalFlow !== true) {
      return { deleted: false, error: 'explicit_delete_confirmation_required' };
    }
    const existing = await ctx.persistentMemoryStore.getMemoryScoped?.(args.id, {
      user_id: ctx.userId, org_id: ctx.orgId, access_context: ctx.accessContext,
    });
    if (!existing) return { deleted: false, error: 'memory_not_found_or_forbidden' };
    await ctx.persistentMemoryStore.deleteMemory(args.id);
    return { deleted: true, id: args.id };
  },

  async hivemind_traverse_graph(args, ctx) {
    // PrismaGraphStore.getRelatedMemories actually returns EDGE records
    // (from_id, to_id, type, confidence) despite the name — older callers
    // mistook edges for memories which produced hallucinated relations.
    // Now we ALSO resolve the connected memories by id so the caller gets
    // both the edge list AND the memory rows referenced by them.
    if (!ctx.persistentMemoryStore?.getRelatedMemories) {
      return { error: 'graph traversal unavailable', _failure_mode: 'UNKNOWN_TOOL' };
    }
    const edges = await ctx.persistentMemoryStore.getRelatedMemories(args.memory_id, {
      maxDepth: args.depth || 2,
      relationship: args.relationship && args.relationship !== 'all' ? args.relationship : null,
      user_id: ctx.userId,
      org_id: ctx.orgId,
    });
    const edgeList = (Array.isArray(edges) ? edges : []).slice(0, 50);
    // Collect unique memory ids referenced by edges (excluding seed).
    const otherIds = new Set();
    for (const e of edgeList) {
      if (e.from_id && e.from_id !== args.memory_id) otherIds.add(e.from_id);
      if (e.to_id   && e.to_id   !== args.memory_id) otherIds.add(e.to_id);
    }
    // Resolve memory rows for the connected ids — bulk lookup.
    let memories = [];
    if (otherIds.size > 0 && ctx.prisma?.memory) {
      try {
        const rows = await ctx.prisma.memory.findMany({
          where: {
            id: { in: [...otherIds] },
            ...scopedMemoryWhere({
              user_id: ctx.userId,
              org_id: ctx.orgId,
              scope: 'all',
              access_context: ctx.accessContext,
            }),
          },
          select: {
            id: true, title: true, content: true, tags: true, memoryType: true,
            isLatest: true, createdAt: true, documentDate: true,
          },
          take: 30,
        });
        memories = rows.map(r => ({
          id: r.id, title: r.title,
          content: String(r.content || '').slice(0, 400),
          tags: r.tags || [],
          memory_type: r.memoryType,
          is_latest: r.isLatest,
          created_at: r.createdAt,
        }));
      } catch (lookupErr) {
        console.warn('[hivemind_traverse_graph] member lookup failed:', lookupErr.message);
      }
    }
    return {
      memory_id: args.memory_id,
      edge_count: edgeList.length,
      // edges[]: typed relationship records — agent MUST use these for any
      // "relation between X and Y" answers. No edge listed = no recorded
      // relation in graph (do NOT invent).
      edges: edgeList.map(e => ({
        from_id: e.from_id,
        to_id: e.to_id,
        type: e.type,
        confidence: typeof e.confidence === 'number' ? Number(e.confidence.toFixed(3)) : e.confidence,
        created_at: e.created_at,
      })),
      memories,                    // resolved memory rows referenced by edges
      related: memories,           // backward-compat alias
      count: memories.length,
    };
  },

  async get_user_profile(args, ctx) {
    // TENANT-SAFE by construction: scoped to ctx.userId/ctx.orgId — the tool
    // takes NO id from the model, so it can only ever return the authenticated
    // caller's own profile. Returns the structured facts (for the UI/answer)
    // plus the compact context string (for grounding). Reuses ProfileStore —
    // the same store the /api/profiles routes and the dreamer write to.
    if (!ctx.prisma) return { facts: [], context: '', error: 'profile_store_unavailable' };
    try {
      const { getSharedProfileStore } = await import('../memory/profile-store.js');
      const store = getSharedProfileStore(ctx.prisma);
      const [facts, context] = await Promise.all([
        store.getProfile(ctx.userId, ctx.orgId, ctx.projectId || null),
        store.buildCompactProfileContext(ctx.userId, ctx.orgId, ctx.projectId || null),
      ]);
      return { facts: facts || [], context: context || '', fact_count: (facts || []).length };
    } catch (err) {
      return { facts: [], context: '', error: `profile_read_failed: ${err.message}` };
    }
  },

  async hivemind_at(args, ctx) {
    const rawValidAt = args.valid_at || args.valid_time || null;
    const rawKnownAt = args.known_at || args.transaction_time || null;
    const validAt = rawValidAt ? new Date(rawValidAt) : null;
    const knownAt = rawKnownAt ? new Date(rawKnownAt) : null;
    if ((!validAt && !knownAt) || (validAt && Number.isNaN(validAt.getTime())) || (knownAt && Number.isNaN(knownAt.getTime()))) {
      throw new Error('hivemind_at requires a valid valid_at and/or known_at date');
    }
    if (args.memory_query && !args.query) args.query = args.memory_query;
    const result = await TOOL_HANDLERS.hivemind_recall(
      {
        query: args.query,
        ...typedRetrievalFilters(args),
        time: {
          ...(validAt ? { valid_at: validAt.toISOString() } : {}),
          ...(knownAt ? { known_at: knownAt.toISOString() } : {}),
        },
        tags: Array.isArray(args.tags) && args.tags.length > 0 ? args.tags : undefined,
        limit: 15,
        mode: 'explain',
      },
      ctx
    );
    return restrictEvidenceToTemporalSnapshot(result, {
      validAt: validAt?.toISOString() || null,
      knownAt: knownAt?.toISOString() || null,
    });
  },

  async hivemind_diff(args, ctx) {
    const from = new Date(args.from);
    const to = new Date(args.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
      throw new Error('diff requires valid from/to timestamps with from before to');
    }
    const tags = Array.isArray(args.tags) && args.tags.length > 0 ? args.tags : undefined;
    const mode = 'explain';
    const [a, b] = await Promise.all([
      TOOL_HANDLERS.hivemind_at({ query: args.query, ...typedRetrievalFilters(args), valid_at: from.toISOString(), tags, limit: 10, mode }, ctx),
      TOOL_HANDLERS.hivemind_at({ query: args.query, ...typedRetrievalFilters(args), valid_at: to.toISOString(), tags, limit: 10, mode }, ctx),
    ]);
    // Compute stable identity delta first, then pair changed claims by typed
    // supersession edges or normalized claim identity. IDs alone cannot express
    // a new version of the same fact.
    const fromIds = new Set((a.memories || []).map(m => m.id));
    const toIds   = new Set((b.memories || []).map(m => m.id));
    const added    = (b.memories || []).filter(m => !fromIds.has(m.id));
    const removed  = (a.memories || []).filter(m => !toIds.has(m.id));
    const persisted = (b.memories || []).filter(m => fromIds.has(m.id));
    const changedIds = new Set([...added, ...removed].map((memory) => memory.id));
    const typedEdges = [...(a.relationships || []), ...(b.relationships || [])]
      .filter((edge) => ['updates', 'contradicts'].includes(String(edge.type || '').toLowerCase()))
      .filter((edge) => changedIds.has(edge.from_id) || changedIds.has(edge.to_id));
    const edgeKeys = new Set();
    const changes = typedEdges.filter((edge) => {
      const key = `${edge.from_id}|${edge.to_id}|${String(edge.type).toLowerCase()}`;
      if (edgeKeys.has(key)) return false;
      edgeKeys.add(key);
      return true;
    });
    const removedByClaim = new Map(removed.map((row) => [temporalClaimKey(row), row]));
    const addedByClaim = new Map(added.map((row) => [temporalClaimKey(row), row]));
    const changed = [];
    for (const [key, before] of removedByClaim) {
      const after = addedByClaim.get(key);
      if (!after) continue;
      changed.push({ claim_key: key, before, after, reason: 'normalized_claim_changed' });
    }
    // The two snapshots are the evidence for a diff.  Returning only
    // `added` made a stable or unchanged fact look unsupported downstream,
    // even though both dated recall results had already retrieved it.
    const uniqueById = (rows = []) => [...new Map(rows.filter(Boolean).map((row) => [row.id || `${row.document_id || ''}:${row.segment_id || ''}:${row.content || ''}`, row])).values()];
    const snapshotMemories = uniqueById([...(a.memories || []), ...(b.memories || [])]);
    const snapshotEvidence = uniqueById([...(a.evidence || []), ...(b.evidence || [])]);
    const fromEvidence = new Map((a.evidence || []).map((row) => [temporalRowIdentity(row), row]));
    const toEvidence = new Map((b.evidence || []).map((row) => [temporalRowIdentity(row), row]));
    const evidenceAdded = [...toEvidence].filter(([key]) => !fromEvidence.has(key)).map(([, row]) => row);
    const evidenceRemoved = [...fromEvidence].filter(([key]) => !toEvidence.has(key)).map(([, row]) => row);
    return {
      query: args.query,
      from_date: args.from,
      to_date: args.to,
      added_count: added.length,
      removed_count: removed.length,
      persisted_count: persisted.length,
      added,
      removed,
      persisted,
      changes,
      changed,
      evidence_delta: { added: evidenceAdded, removed: evidenceRemoved },
      memories: snapshotMemories,
      evidence: snapshotEvidence,
      evidence_packets: [a.evidence_packet, b.evidence_packet].filter(Boolean),
      from: a,
      to: b,
    };
  },

  async hivemind_timeline(args, ctx) {
    // Resolve by EXACT memory_id via the MemoryVersion ledger — the documented
    // contract. Previously this ignored memory_id and required `query`, so
    // "timeline of memory X" failed with missing-query. Walk the version chain
    // directly (newest→oldest revisions, supersession, derive, contradict).
    const memoryId = typeof args.memory_id === 'string' && args.memory_id.trim()
      ? args.memory_id.trim() : null;
    if (memoryId && ctx.persistentMemoryStore?.getMemoryScoped) {
      try {
        // TENANT ISOLATION: getTemporalTimeline + getMemories are UNSCOPED
        // (they filter only by id). A user could pass any UUID and read another
        // tenant's memory + full history. So authorize the ANCHOR first via the
        // scoped getter — it returns null unless this user/org/project may see
        // it — and refuse before walking the ledger. Related (superseded/
        // derived) rows are each re-checked through the same scoped getter so a
        // cross-tenant relatedMemoryId can never leak into the result.
        const scope = { user_id: ctx.userId, org_id: ctx.orgId, access_context: ctx.accessContext || null };
        const anchor = await ctx.persistentMemoryStore.getMemoryScoped(memoryId, scope);
        if (!anchor) {
          return { error: 'memory_not_found_or_forbidden', memory_id: memoryId, _failure_mode: 'NOT_AUTHORIZED' };
        }
        const { BiTemporalEngine } = await import('../memory/bi-temporal.js');
        const engine = new BiTemporalEngine({ store: ctx.persistentMemoryStore, prisma: ctx.prisma });
        const versions = await engine.getTemporalTimeline(memoryId);
        // Authorize + hydrate related memories individually (chains are short).
        const relatedIds = [...new Set(versions.map(v => v.relatedMemoryId).filter(Boolean))];
        const related = (await Promise.all(
          relatedIds.map(id => ctx.persistentMemoryStore.getMemoryScoped(id, scope).catch(() => null)),
        )).filter(Boolean);
        return {
          memory_id: memoryId,
          version_count: versions.length,
          versions,
          memories: [anchor, ...related],
          resolved_by: 'memory_id',
        };
      } catch (err) {
        return { error: `timeline_by_id_failed: ${err.message}`, memory_id: memoryId };
      }
    }
    // Fall back to semantic/tag/file-scoped timeline recall.
    const tags = Array.isArray(args.tags) && args.tags.length > 0 ? [...args.tags] : [];
    if (typeof args.file_path === 'string' && args.file_path.trim()) tags.push(`file:${args.file_path.trim()}`);
    if (!args.query && !tags.length) {
      return { error: "hivemind_timeline needs one of: memory_id, query, tags, or file_path", _failure_mode: 'INVALID_ARGS' };
    }
    const recalled = await TOOL_HANDLERS.hivemind_recall(
      {
        query: args.query || tags.join(' '),
        ...typedRetrievalFilters(args),
        mode: 'explain',
        operation: 'timeline',
        include_superseded: true,
        limit: args.limit || 20,
        tags: tags.length ? tags : undefined,
        ...(args.valid_at && !Number.isNaN(new Date(args.valid_at).getTime())
          ? { time: { valid_at: new Date(args.valid_at).toISOString() } }
          : {}),
      },
      ctx
    );
    // TRAVERSE the Updates chain: recall ranks the LATEST memory but the
    // superseded predecessor (isLatest=false, near-identical text) rarely ranks
    // into the delivered set — so "what was the previous value / show the change
    // history" came back empty even though the Updates edge exists. Follow the
    // typed Updates edges from the recalled memories and hydrate the
    // predecessors (edge.to_id) so the answer can state "was X → now Y".
    try {
      const anchorIds = (recalled?.memories || []).map((m) => m.id).filter(Boolean);
      if (anchorIds.length && ctx.prisma && loadTypedGraphEvidence) {
        const graph = await loadTypedGraphEvidence({
          prisma: ctx.prisma, memoryIds: anchorIds,
          userId: ctx.userId, orgId: ctx.orgId, accessContext: ctx.accessContext || {},
        }).catch(() => ({ items: [] }));
        const updatesEdges = (graph.items || []).filter((e) => String(e.type).toLowerCase() === 'updates');
        const predIds = [...new Set(updatesEdges.map((e) => e.to_id).filter((id) => id && !anchorIds.includes(id)))];
        if (predIds.length && ctx.persistentMemoryStore?.getMemories) {
          const predMap = await ctx.persistentMemoryStore.getMemories(predIds).catch(() => new Map());
          const seen = new Set(anchorIds);
          const preds = predIds.map((id) => predMap.get?.(id)).filter((m) => m && !seen.has(m.id));
          if (preds.length) {
            recalled.memories = [...(recalled.memories || []), ...preds.map((m) => ({ ...m, _superseded_predecessor: true }))];
            recalled.relationships = [...(recalled.relationships || []), ...updatesEdges];
          }
        }
      }
    } catch { /* traversal is additive — never break the timeline on it */ }
    recalled.timeline_groups = groupTemporalRows(
      recalled.memories || [], recalled.relationships || [],
    );
    return recalled;
  },

  async hivemind_query_with_ai(args, ctx) {
    // Heavier synthesis — reuse recall mode=insight if available, else fall back.
    return TOOL_HANDLERS.hivemind_recall({ query: args.query, mode: 'insight', limit: 20 }, ctx);
  },

  async hivemind_recall_bugs(args, ctx) {
    return TOOL_HANDLERS.hivemind_recall(
      {
        query: args.context,
        tags: args.file_path ? ['bug', 'fix', 'gotcha', `file:${args.file_path}`] : ['bug', 'fix', 'gotcha'],
        limit: 10,
      },
      ctx
    );
  },

  async hivemind_web_search(args, ctx) {
    // Was dead: read ctx.webIntelligence, which nothing ever set. Now shares
    // runWebSearchJob() (server.js) with POST /api/web/search/jobs — same
    // quota/rate-limit/abuse gate, no second path.
    if (!ctx.runWebSearchJob) return { error: 'web search not configured' };
    const result = await ctx.runWebSearchJob({
      query: args.query, domains: [], limit: 10, userId: ctx.userId, orgId: ctx.orgId,
    });
    const { ok, httpStatus, ...body } = result;
    return body;
  },

  async hivemind_web_crawl(args, ctx) {
    // Was dead: read ctx.webIntelligence, which nothing ever set (verified —
    // no assignment to globalThis.webIntelligence anywhere in the codebase).
    // Now shares runWebCrawlJob() (server.js) with POST /api/web/crawl/jobs —
    // same quota/rate-limit/abuse/policy gate, no second path.
    if (!ctx.runWebCrawlJob) return { error: 'web crawl not configured' };
    const result = await ctx.runWebCrawlJob({
      urls: [args.url], depth: args.depth, captureScreenshot: args.capture_screenshot, session: args.session,
      userId: ctx.userId, orgId: ctx.orgId,
    });
    const { ok, httpStatus, ...body } = result;
    return body;
  },

  async hivemind_brand_dna(args, ctx) {
    if (!ctx.startVisualIntelligenceWorkflow) return { error: 'brand_dna_workflow_not_configured' };
    try {
      return await ctx.startVisualIntelligenceWorkflow({ orgId: ctx.orgId, userId: ctx.userId, urls: [args.url], roomId: ctx.roomId || null });
    } catch (error) {
      return { error: error.message || 'brand_dna_workflow_failed' };
    }
  },

  async hivemind_web_job_status(args, ctx) {
    if (!ctx.webJobStore) return { error: 'web intel not configured' };
    const job = await ctx.webJobStore.get(args.job_id, { userId: ctx.userId, orgId: ctx.orgId });
    if (!job) return { error: 'job not found' };
    return job;
  },

  async update_user_profile(args, ctx) {
    // Update the AUTHENTICATED caller's own profile facts (name, role, company,
    // language, preferences). Caller-scoped by construction: ctx.userId/orgId,
    // NO id from the model. Distinct from set_assistant_name (which renames
    // HIVE) — "change MY name" belongs here, "call yourself X" belongs there.
    if (!ctx.prisma) return { updated: false, error: 'profile_store_unavailable' };
    const ALLOWED = new Set(['name', 'role', 'company', 'language', 'location', 'timezone']);
    const fields = [];
    // Structured fields.
    for (const [k, v] of Object.entries(args?.fields || {})) {
      if (ALLOWED.has(k) && typeof v === 'string' && v.trim()) fields.push({ category: 'static', key: k, value: v.trim().slice(0, 500) });
    }
    // Free-form preferences → preference:<slug>.
    if (Array.isArray(args?.preferences)) {
      for (const p of args.preferences) {
        if (typeof p === 'string' && p.trim()) fields.push({ category: 'preference', key: `preference:${p.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`, value: p.trim().slice(0, 500) });
      }
    }
    if (!fields.length) return { updated: false, error: 'no_valid_profile_fields' };
    try {
      const { getSharedProfileStore } = await import('../memory/profile-store.js');
      const store = getSharedProfileStore(ctx.prisma);
      // A profile fact is durable user context, not merely a mutable settings
      // row. Preserve it as one canonical PERSONAL memory as well, so profile
      // updates remain visible to recall/history with ordinary source lineage.
      // This does not replace an explicitly chosen organization/project memory
      // from a separate save; it is the caller's private profile history.
      const profileContent = fields
        .map((field) => `My ${field.key.replace(/^preference:/, 'preference ')} is ${field.value}.`)
        .join('\n');
      let profileMemoryId = null;
      if (ctx.ingestCanonicalPayload || ctx.buildRoutedIngestPayloads) {
        const payload = {
          title: 'User profile update',
          content: profileContent,
          tags: ['profile', 'source:chat', 'provenance:user-fact'],
          memory_type: 'fact',
          user_id: ctx.userId,
          org_id: ctx.orgId,
          scope: 'personal',
          project_ids: [],
          source_metadata: { source_platform: 'talk-to-hive', source_type: 'profile-update', via: 'react-agent' },
        };
        const saved = ctx.ingestCanonicalPayload
          ? await ctx.ingestCanonicalPayload(payload, { sourceType: 'mcp', mode: 'atomic' })
          : await (async () => {
              const [routed] = await ctx.buildRoutedIngestPayloads(payload, { smartIngestRouter: ctx.smartIngestRouter });
              return ctx.ingestRoutedPayload
                ? ctx.ingestRoutedPayload(routed, ctx.persistentMemoryEngine)
                : ctx.persistentMemoryEngine?.ingestMemory(routed);
            })();
        profileMemoryId = saved?.parentId || saved?.id || saved?.memoryId || saved?.memory?.id || null;
      }
      const applied = [];
      for (const f of fields) {
        await store.upsertFact({ userId: ctx.userId, orgId: ctx.orgId, category: f.category, key: f.key, value: f.value, confidence: 1.0, sourceMemoryId: profileMemoryId }).catch(() => {});
        applied.push({ key: f.key, value: f.value });
      }
      return {
        updated: true,
        // `id` keeps the standard mutation result/UI contract intact while
        // `memory_id` remains explicit for API clients.
        id: profileMemoryId,
        fields: applied,
        memory_id: profileMemoryId,
        profile_memory_saved: Boolean(profileMemoryId),
        _terminal: true,
      };
    } catch (err) {
      return { updated: false, error: `profile_update_failed: ${err.message}` };
    }
  },

  async hivemind_set_assistant_name(args, ctx) {
    if (!ctx.persistentMemoryEngine) throw new Error('ingest pipeline unavailable');
    const { buildAssistantNamePayload } = await import('../services/assistant-identity.js');
    const payload = buildAssistantNamePayload({
      name: args.name,
      userId: ctx.userId,
      orgId: ctx.orgId,
    });
    await ctx.persistentMemoryEngine.ingestMemory({
      ...payload,
      skipProcessing: true,
      smartIngest: false,
    });
    return { set: true, name: args.name };
  },

  async hivemind_log_decision(args, ctx) {
    if (!ctx.persistentMemoryEngine || !ctx.buildRoutedIngestPayloads) {
      throw new Error('ingest pipeline unavailable');
    }
    const content = [
      `Decision: ${args.decision}`,
      args.rationale ? `Rationale: ${args.rationale}` : null,
      args.alternatives?.length ? `Alternatives: ${args.alternatives.join('; ')}` : null,
      args.affected_files?.length ? `Affected: ${args.affected_files.join(', ')}` : null,
    ].filter(Boolean).join('\n');
    const tags = ['decision', ...(args.affected_files || []).map((f) => `file:${f}`)];
    const payload = {
      title: args.title,
      content,
      tags,
      memory_type: 'decision',
      user_id: ctx.userId,
      org_id: ctx.orgId,
      source_metadata: { source_platform: 'talk-to-hive', via: 'react-agent' },
    };
    let saved;
    if (ctx.ingestCanonicalPayload) {
      saved = await ctx.ingestCanonicalPayload(payload, { sourceType: 'mcp', mode: 'atomic' });
    } else {
      const [routed] = await ctx.buildRoutedIngestPayloads(payload, { smartIngestRouter: ctx.smartIngestRouter });
      saved = ctx.ingestRoutedPayload
        ? await ctx.ingestRoutedPayload(routed, ctx.persistentMemoryEngine)
        : await ctx.persistentMemoryEngine.ingestMemory(routed);
    }
    return { logged: true, id: saved?.parentId || saved?.id || saved?.memoryId || null };
  },

  async hivemind_code_at(args, ctx) {
    return TOOL_HANDLERS.hivemind_recall(
      {
        query: `code at ${args.file_path}`,
        tags: [`file:${args.file_path}`],
        valid_at: args.valid_at,
        limit: 5,
      },
      ctx
    );
  },

  async hivemind_why_code(args, ctx) {
    return TOOL_HANDLERS.hivemind_recall(
      {
        query: args.query,
        tags: args.file_path ? [`file:${args.file_path}`, 'decision'] : ['decision'],
        limit: 10,
      },
      ctx
    );
  },

  // List every project the user has access to under the active org.
  // Returns enough metadata for the agent to pick a match (id, name, slug,
  // role). The list is small (typically <20 per user) so we don't paginate.
  // Used by the agent BEFORE saving a memory when the user mentions a
  // project by name or the topic obviously belongs to one.
  async hivemind_list_projects(args, ctx) {
    if (!ctx.persistentMemoryStore?.client?.project) {
      throw new Error('project store unavailable');
    }
    const prisma = ctx.persistentMemoryStore.client;
    const accessProjectIds = (ctx.accessContext?.projectIds) || [];
    if (accessProjectIds.length === 0) {
      // No project access at all — return empty so the agent falls back
      // to personal scope.
      return { count: 0, projects: [], note: 'No projects accessible — memory will default to personal scope.' };
    }
    const where = { id: { in: accessProjectIds }, orgId: ctx.orgId };
    if (args?.query && typeof args.query === 'string') {
      const q = args.query.trim();
      if (q) {
        where.OR = [
          { name: { contains: q, mode: 'insensitive' } },
          { slug: { contains: q, mode: 'insensitive' } },
        ];
      }
    }
    const rows = await prisma.project.findMany({
      where,
      select: { id: true, name: true, slug: true, status: true, teamId: true, createdAt: true },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });
    return {
      count: rows.length,
      projects: rows.map(r => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        status: r.status,
        team_id: r.teamId,
      })),
    };
  },
};

export function normalizeAgentRecallMode(mode) {
  const value = String(mode || 'fact').toLowerCase();
  return ({ quick: 'fact', panorama: 'explain', insight: 'explain' })[value]
    || (['fact', 'explain', 'full'].includes(value) ? value : 'fact');
}

// ── Dispatch entry ───────────────────────────────────────────────────────────

// Per-tool timeout contract. Default 15s for unspecified tools.
// Source: ai-boost/awesome-harness-engineering 2026 recommendations +
// observed P95 latencies in HIVEMIND production.
const TOOL_TIMEOUTS_MS = {
  hivemind_aggregate_entities: 5_000,
  // A filtered COUNT is a single indexed aggregate — far cheaper than recall's
  // multi-lane fan-out, so it gets a tight budget. If it ever needs longer the
  // filter is wrong, not the timeout.
  hivemind_count_where: 5_000,
  hivemind_query_table: 5_000,
  hivemind_recall:           8_000,
  get_user_profile:          3_000,
  update_user_profile:       3_000,   // two indexed Postgres reads, no LLM
  hivemind_relation_between: 8_000,
  hivemind_at:               9_000,   // wraps recall + extra date filter
  hivemind_diff:            16_000,  // 2x recall
  hivemind_timeline:         8_000,
  hivemind_traverse_graph:  12_000,
  hivemind_query_with_ai:   25_000,  // heavy LLM synthesis
  hivemind_save_memory:     10_000,
  hivemind_update_memory:   10_000,
  hivemind_delete_memory:    5_000,
  hivemind_get_memory:       3_000,
  hivemind_list_memories:    6_000,
  hivemind_list_projects:    3_000,
  hivemind_web_search:       3_000,  // job submit only
  hivemind_web_crawl:        3_000,
  hivemind_web_job_status:   5_000,
  hivemind_recall_bugs:      8_000,
  hivemind_code_at:         12_000,
  hivemind_why_code:        12_000,
  hivemind_log_decision:     6_000,
  hivemind_set_assistant_name: 3_000,
};

// Schema validation: surfaces missing-required errors before handler runs.
function validateAndSanitize(name, args) {
  const def = TOOL_SCHEMAS.find(t => t.function.name === name);
  if (!def) return { ok: false, error: `unknown tool: ${name}` };
  const required = def.function.parameters?.required || [];
  const props = def.function.parameters?.properties || {};
  const clean = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (k in props || k.startsWith('_')) clean[k] = v;
  }
  for (const r of required) {
    if (clean[r] === undefined || clean[r] === null || clean[r] === '') {
      return { ok: false, error: `missing required param '${r}' for ${name}` };
    }
  }
  return { ok: true, args: clean };
}

export async function dispatchTool(name, args, ctx, { timeoutMs } = {}) {
  const handler = TOOL_HANDLERS[name];
  if (!handler) return { error: `unknown tool: ${name}`, _failure_mode: 'UNKNOWN_TOOL' };

  let argsObj = args;
  if (typeof args === 'string') {
    try { argsObj = JSON.parse(args); } catch { argsObj = {}; }
  }

  // Argument validation (Tool Call Validation Layer — OpenReview 2026).
  const validation = validateAndSanitize(name, argsObj || {});
  if (!validation.ok) {
    return { error: validation.error, _failure_mode: 'INVALID_ARGS' };
  }

  const effectiveTimeout = timeoutMs || TOOL_TIMEOUTS_MS[name] || 15_000;
  try {
    const result = await runWithStageDeadline(
      () => handler(validation.args, ctx),
      { timeoutMs: effectiveTimeout, label: `tool:${name}` },
    );
    return result;
  } catch (err) {
    const msg = err.message || String(err);
    // Standardized error-action map for upstream handlers.
    let mode = 'EXEC_ERROR';
    if (err?.code === 'REMOTE_MEMORY_UNAVAILABLE') mode = 'REMOTE_UNAVAILABLE';
    else if (isStageDeadlineError(err) || /timed out|deadline exceeded/i.test(msg)) mode = 'TIMEOUT';
    else if (/not found|no such|missing/i.test(msg)) mode = 'NOT_FOUND';
    else if (/unauthorized|forbidden|401|403|invalid token/i.test(msg)) mode = 'AUTH_ERROR';
    else if (/rate limit|429|quota/i.test(msg)) mode = 'RATE_LIMIT';
    return { error: msg, _failure_mode: mode };
  }
}

export const TOOL_NAMES = TOOL_SCHEMAS.map((t) => t.function.name);
export { TOOL_SCHEMAS, TOOL_TIMEOUTS_MS };
