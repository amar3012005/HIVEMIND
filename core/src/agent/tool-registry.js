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
import { loadTypedGraphEvidence } from '../memory/recall-router.js';

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

// ── Tool schemas (LLM-visible) ───────────────────────────────────────────────

export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'hivemind_recall',
      description:
        `Unified retrieval — the ONLY recall entry point. It runs bounded memory/evidence lanes and typed graph expansion under one tenant-scoped plan.\n\nReturns memories[], evidence[], relationships[], live[], evidence_packet, and trace.\n\nCall once with the user's complete question. Use fact for the initial fast path and explain only for one policy-driven expansion. Full is caller-explicit only. Never fan out paraphrase queries or loop until satisfied.`,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language query.' },
          query_original: { type: 'string', description: 'Original-language query for multilingual vector and lexical retrieval.' },
          query_canonical_en: { type: 'string', description: 'English-canonical lexical formulation; exact names and identifiers remain unchanged.' },
          entities: { type: 'array', items: { type: 'string' }, maxItems: 12, description: 'Exact entities selected by the structured router.' },
          mode: { type: 'string', enum: ['fact', 'explain', 'full', 'quick', 'panorama', 'insight'], default: 'fact' },
          limit: { type: 'integer', default: 10, minimum: 1, maximum: 50 },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tag filters.' },
          source_type: { type: 'string', enum: ['text', 'code', 'conversation', 'documentation', 'decision'] },
          source_document_id: { type: 'string', description: 'Known KnowledgeDocument id. Hard-filters evidence in explain/full.' },
          source_title: { type: 'string', description: 'Exact or partial source filename/title. Resolves to a hard document filter in explain/full.' },
          valid_at: { type: 'string', description: 'ISO timestamp for bi-temporal time-travel.' },
          known_at: { type: 'string', description: 'ISO timestamp for what the workspace had learned by that time.' },
          date_range: {
            type: 'object',
            description: 'Bounded event-time range selected by the server-side intent planner.',
            properties: {
              start: { type: 'string' },
              end: { type: 'string' },
            },
          },
          include_live: { type: 'boolean', default: false, description: 'Force live workspace lookup (Gmail/Drive/Calendar) even if memory layer does not hint at it.' },
          scope_filter: { type: 'string', enum: ['personal', 'project', 'team', 'organization'], description: 'Server-owned scope restriction for typed requests such as self-profile recall.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hivemind_aggregate_entities',
      description: 'Deterministically count/list distinct canonical entities associated with a parent entity. Use for exhaustive how-many/list-all questions; never infer a count from top-K recall.',
      parameters: {
        type: 'object',
        properties: {
          parent_name: { type: 'string', description: 'Canonical parent/entity name, for example Solvis.' },
          parent_candidates: { type: 'array', items: { type: 'string' }, maxItems: 12, description: 'Optional exact entity names resolved from the user request. Used only as tenant-scoped deterministic fallbacks when parent_name is not a canonical entity.' },
          entity_kind: { type: 'string', description: 'Entity kind to aggregate, for example product.' },
          limit: { type: 'integer', minimum: 1, maximum: 1000, default: 500 },
        },
        required: ['parent_name', 'entity_kind'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hivemind_save_memory',
      description:
        'Save a durable fact, preference, decision, goal, person, or event to HIVEMIND. Call when the user reveals something durable. ALWAYS tag (≥2 tags). NEVER save chitchat or secrets.\n\nPROJECT SCOPING (enterprise multi-tenant):\n  • If the user names a project ("save to SOLVIS", "in my Q2-planning project"), pass project_id (UUID) OR project (name/slug — server resolves).\n  • If unsure which project, FIRST call hivemind_list_projects to see what exists, pick the best match by topic, and use that.\n  • If still ambiguous, ASK the user before saving instead of guessing.\n  • If the org policy is "ask" or no obvious match, omit project_id — server defaults to personal scope.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '3-8 words, searchable.' },
          content: { type: 'string', description: 'The fact, one claim per memory.' },
          tags: { type: 'array', items: { type: 'string' }, minItems: 2 },
          memory_type: { type: 'string', enum: ['fact', 'preference', 'decision', 'goal', 'event', 'lesson'] },
          project_id: {
            type: 'string',
            description: 'Project UUID. Use when you already know it (e.g. from a prior hivemind_list_projects call).',
          },
          project: {
            type: 'string',
            description: 'Project NAME or slug (e.g. "SOLVIS"). Server resolves to project_id. Use when the user mentioned the project by name.',
          },
          scope: {
            type: 'string',
            enum: ['personal', 'project', 'team', 'organization'],
            description: 'Memory scope. Defaults to personal. Use "organization" when the user explicitly says "save to the whole company"; use "project" when project_id/project is set; use "team" rarely.',
          },
          entities: { type: 'array', items: { type: 'string' }, maxItems: 12, description: 'Exact entity names preserved by the router.' },
          event_time: { type: 'string', description: 'ISO event/valid time explicitly supplied by the user.' },
        },
        required: ['title', 'content', 'tags'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hivemind_update_memory',
      description: 'Update an existing memory when new info contradicts or refines it. Emits an Updates edge.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          target_query: { type: 'string', description: 'Precise title/entity/content query used only when the memory id is unknown.' },
          content: { type: 'string' },
          title: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string', description: 'Why it changed.' },
          project_id: { type: 'string' },
          project_hint: { type: 'string' },
          entities: { type: 'array', items: { type: 'string' }, maxItems: 12 },
          event_time: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hivemind_relation_between',
      description: 'Resolve two or more exact entities and return verified typed edges first, then bounded shared-source/shared-entity paths. Co-mentions are explicitly separated from graph relations.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          entities: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 6 },
          query: { type: 'string' }, mode: { type: 'string', enum: ['fact', 'explain'], default: 'explain' },
          source_document_id: { type: 'string' }, source_title: { type: 'string' },
          valid_at: { type: 'string' }, known_at: { type: 'string' },
        },
        required: ['entities'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hivemind_get_memory',
      description: 'Fetch full content of a known memory id (after recall returns a snippet).',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hivemind_list_memories',
      description: 'Explicit "show me my memories about X". Returns paged list.',
      parameters: {
        type: 'object',
        properties: {
          tags: { type: 'array', items: { type: 'string' } },
          memory_type: { type: 'string' },
          limit: { type: 'integer', default: 20 },
          since: { type: 'string', description: 'ISO date.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hivemind_delete_memory',
      description: 'User explicitly says "forget X". Confirm before calling on anything consequential.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hivemind_list_projects',
      description:
        'List every project (sub-HIVEMIND) the user has access to under the active org. Use BEFORE saving a memory when the user mentions a project by name OR when the topic obviously belongs to a project (e.g. their pitch deck → likely "Pitch Deck" project). Returns [{ id, name, slug, role }]. The agent should pick the best match by name/topic, then pass project_id to hivemind_save_memory. If multiple match → ASK the user which.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional name/slug substring to filter results.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hivemind_traverse_graph',
      description: '"What\'s related to X?" — walks edges outward from a memory. depth 1-3 typical.',
      parameters: {
        type: 'object',
        properties: {
          memory_id: { type: 'string' },
          depth: { type: 'integer', default: 2, minimum: 1, maximum: 5 },
          relationship: { type: 'string', enum: ['all', 'Updates', 'Extends', 'Derives', 'Contradicts', 'Supports', 'References'], default: 'all' },
        },
        required: ['memory_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_user_profile',
      description:
        'Return the maintained profile of the CURRENT user and their organization — durable identity facts (name, role, company, mission, ICP, location, language), preferences, goals, and current focus. Call this for "what do you know about me", "who am I", "my preferences/role/company", "was weißt du über mich / meine Firma", or any request about the user or their org themselves (any language). Always scoped to the authenticated caller; takes no id.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hivemind_at',
      description:
        'Bi-temporal snapshot: what did we know about X on date Y? Filters to memories whose document_date ≤ valid_at AND were already ingested by then.\n\nFor connector-scoped time-travel pass tags. Examples:\n  • Slack: tags=["slack"] (+ optional channel:NAME, from:USER)\n  • Notion: tags=["notion"] (+ optional page:NAME)\n  • Gmail: tags=["gmail"] (+ optional from:EMAIL, thread:ID)',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          valid_at: { type: 'string', description: 'ISO timestamp.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tag filter (connector + marker tags).' },
          mode: { type: 'string', enum: ['quick', 'panorama', 'insight'], default: 'quick' },
        },
        required: ['query', 'valid_at'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hivemind_diff',
      description:
        'What changed between two dates for a topic. Returns memory snapshot at "from" + at "to".\n\nFor connector-scoped diff pass tags (e.g. tags=["slack","channel:product"]).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          mode: { type: 'string', enum: ['quick', 'panorama', 'insight'], default: 'quick' },
        },
        required: ['query', 'from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hivemind_timeline',
      description:
        'Full version chain / chronological history. Resolve by memory_id (exact — walks the MemoryVersion ledger: every revision, supersession, derive, contradict), OR by query / tags / file_path (semantic/scoped timeline ordered by date). Useful for "how has X changed", "history of the decision", "all msgs from @user".',
      parameters: {
        type: 'object',
        properties: {
          memory_id: { type: 'string', description: 'Exact memory UUID — returns its full version chain directly.' },
          query: { type: 'string' },
          limit: { type: 'integer', default: 20 },
          tags: { type: 'array', items: { type: 'string' } },
          file_path: { type: 'string', description: 'Code-scoped — translated to a file:<path> tag.' },
          valid_at: { type: 'string', description: 'Optional upper bound for time-travel.' },
        },
        // No hard required: the handler accepts ANY of memory_id | query | tags |
        // file_path and returns a bounded INVALID_ARGS error if none is present.
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hivemind_query_with_ai',
      description: 'Complex synthesis over many memories. Heavier than recall — use sparingly for "summarize everything you know about X" / cross-memory comparison.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          scope: { type: 'string' },
          mode: { type: 'string', enum: ['summary', 'compare', 'evolution'], default: 'summary' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hivemind_recall_bugs',
      description: 'Failure-mode memories — call BEFORE writing code in a known-buggy area.',
      parameters: {
        type: 'object',
        properties: {
          context: { type: 'string' },
          file_path: { type: 'string' },
        },
        required: ['context'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hivemind_web_search',
      description: 'Live web search. Returns job_id — poll with hivemind_web_job_status.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          freshness: { type: 'string', enum: ['day', 'week', 'month', 'year', 'all'], default: 'week' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hivemind_web_crawl',
      description: 'Crawl a specific URL. Returns job_id.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          depth: { type: 'integer', default: 1 },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hivemind_web_job_status',
      description: 'Poll web_search / web_crawl until done.',
      parameters: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hivemind_set_assistant_name',
      description: 'Set the assistant\'s name (user gave it one).',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hivemind_log_decision',
      description: 'Log an architectural / engineering decision with rationale.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          decision: { type: 'string' },
          rationale: { type: 'string' },
          alternatives: { type: 'array', items: { type: 'string' } },
          affected_files: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'decision'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hivemind_code_at',
      description: 'Bi-temporal: what did the code at file_path look like on a date.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          valid_at: { type: 'string' },
        },
        required: ['file_path', 'valid_at'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hivemind_why_code',
      description: 'Explain why a piece of code exists — pulls decision + history memories.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          file_path: { type: 'string' },
        },
        required: ['query'],
      },
    },
  },
];

// ── Dispatch handlers ────────────────────────────────────────────────────────

const TOOL_HANDLERS = {
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
              { tags: { has: 'scope-key:organization' } },
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
    const recallPlan = resolveRecallPlan({
      ...args,
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
      operation:      recallPlan.operation,
      include_superseded: recallPlan.operation === 'timeline' || args.include_superseded === true,
      // Date range — { start, end } ISO timestamps. Filters memories whose
      // document_date OR created_at falls in window. Used by agent's
      // today/yesterday/this-week shortcuts.
      include_live:   args.include_live === true,
      live_intent:    args.live_intent === true,
      scope_filter:   args.scope_filter,
      structured_intent: args._structured_intent === true,
      alternate_lexical_query: args.query_canonical_en && args.query_canonical_en !== originalQuery
        ? args.query_canonical_en
        : null,
      named_entities: args.entities || [],
    }, {
      userId:        ctx.userId,
      orgId:         ctx.orgId,
      projectId:     ctx.projectId,
      accessContext: ctx.accessContext,
    });
    // PROJECT-SCOPE POLICY — same authority as /api/recall (routes/recall.js).
    // The agent path calls router.recall DIRECTLY, bypassing the HTTP route, so
    // without this a projectless chat leaked project KB docs (Solvis whitepaper
    // answering an org-scope question) and a project-scoped chat was not
    // actually restricted to its project.
    await applyProjectScopeFilter(ctx.prisma, ctx.orgId, result, ctx.projectId || null);
    const effectivePlan = result.trace?.recall_plan || recallPlan;

    let graph = [];
    const graphBudget = effectivePlan.latency_budget_ms - (Date.now() - recallStartedAt);
    if (effectivePlan.max_graph_hops > 0 && result.memories.length > 0 && graphBudget > 1) {
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
      graph = loaded.items || [];
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
      mode: 'explain', limit: 8,
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
        entities: [entity],
      }, ctx)));
    const memories = new Map();
    const evidence = new Map();
    const edges = new Map();
    const packets = [];
    const memoryIdsByEntity = new Map();
    recalled.forEach((result, index) => {
      const ids = new Set();
      for (const memory of (result?.memories || [])) {
        if (!memory?.id) continue;
        ids.add(memory.id);
        if (!memories.has(memory.id)) memories.set(memory.id, memory);
      }
      memoryIdsByEntity.set(entities[index], ids);
      for (const item of (result?.evidence || [])) {
        const key = item?.id || `${item?.document_id || item?.document_title}|${item?.page || ''}|${String(item?.content || item?.snippet || '').slice(0, 80)}`;
        if (!evidence.has(key)) evidence.set(key, item);
      }
      for (const edge of (result?.relationships || [])) {
        if (edge?.from_id && edge?.to_id && edge?.type) edges.set(`${edge.from_id}|${edge.to_id}|${edge.type}`, edge);
      }
      if (result?.evidence_packet) packets.push(result.evidence_packet);
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
    return {
      entities,
      direct_edges: directEdges,
      shared_paths: sharedPaths,
      co_mentions: sharedPaths.map((path) => ({ ...path, type: 'co_mention' })),
      verified_relation_found: directEdges.length > 0,
      memories: [...memories.values()], evidence: [...evidence.values()],
      relationships: allEdges, evidence_packets: packets,
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
    const ALLOWED = new Set(['fact', 'preference', 'decision', 'goal', 'event', 'lesson']);
    const TYPE_ALIAS = {
      note: 'fact', observation: 'fact', todo: 'goal', task: 'goal',
      reminder: 'goal', insight: 'lesson', learning: 'lesson',
      idea: 'fact', knowledge: 'fact', context: 'fact',
      contact: 'fact', person: 'fact', user: 'fact', relationship: 'fact',
      meeting: 'event', appointment: 'event',
      synthesis: 'fact', summary: 'fact', // canonical-summary cognition rows
    };
    let memType = (args.memory_type || 'fact').toString().toLowerCase().trim();
    if (TYPE_ALIAS[memType]) memType = TYPE_ALIAS[memType];
    if (!ALLOWED.has(memType)) memType = 'fact';

    // Resolve project scoping. The agent may pass:
    //   • project_id (UUID — direct)
    //   • project    (name or slug — server-side resolveScopedIngestPayload
    //                  converts to project_id via the user's access_context)
    //   • scope      (personal | project | team | organization — defaults
    //                  to personal when nothing supplied)
    // When project_id OR project is set, scope auto-elevates to 'project'
    // unless the caller explicitly chose otherwise.
    const explicitScope = typeof args.scope === 'string' ? args.scope.toLowerCase() : null;

    // Resolve project name/slug → UUID against the user's access list.
    // Server-side resolveScopedIngestPayload only understands project_id(s),
    // so we lift the name lookup up here where we have prisma + accessContext.
    let resolvedProjectId = args.project_id || null;
    // Fall back to ctx.projectId (the request-level scope set by the caller
    // e.g. browser-extension scope pill) when the LLM didn't supply one.
    if (!resolvedProjectId && ctx.projectId) {
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

    // Auto-classify the project from name+description when the caller gave no
    // project and no explicit scope. Confident match → assign silently;
    // ambiguous → return needs_project_choice (with a pre-selected suggestion)
    // so the UI asks; nothing fits → personal. Honors the org memory_save_policy
    // ('org-wide' → org scope; 'ask' → always ask; else → semantic classify).
    let autoScope = null; // set to 'organization' when policy routes org-wide
    if (!resolvedProjectId && !explicitScope && ctx.persistentMemoryStore?.client?.project) {
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

    const payload = {
      title: args.title,
      content: args.content,
      tags: args.tags || [],
      memory_type: memType,
      user_id: ctx.userId,
      org_id: ctx.orgId,
      scope,
      project_ids: resolvedProjectId ? [resolvedProjectId] : [],
      entities: Array.isArray(args.entities) ? args.entities : [],
      ...(args.event_time ? { document_date: args.event_time, event_time: args.event_time, valid_from: args.event_time } : {}),
      source_metadata: {
        source_platform: 'talk-to-hive', source_type: 'chat-turn', via: 'react-agent',
        source_id: args._source_id || null,
        original_content: args._original_content || args.content,
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
    return {
      saved: true,
      id,
      title: args.title,
      operation: saved?.operation || null,
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
    if (!targetId) return { updated: false, error: 'memory_target_required' };
    const existing = await ctx.persistentMemoryStore.getMemoryScoped?.(targetId, {
      user_id: ctx.userId, org_id: ctx.orgId, access_context: ctx.accessContext,
    });
    if (!existing) return { updated: false, error: 'memory_not_found_or_forbidden' };
    if (existing.is_latest === false || existing.isLatest === false) {
      return { updated: false, error: 'memory_target_is_superseded' };
    }
    const result = await ctx.persistentMemoryEngine.ingestMemory({
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
    return { count: list.length, memories: list.map((m) => ({ id: m.id, title: m.title, tags: m.tags, created_at: m.created_at })) };
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
          content: (r.content || '').slice(0, 400),
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
        store.buildProfileContext(ctx.userId, ctx.orgId, ctx.projectId || null),
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
    return TOOL_HANDLERS.hivemind_recall(
      {
        query: args.query,
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
      TOOL_HANDLERS.hivemind_recall({ query: args.query, time: { valid_at: from.toISOString() }, tags, limit: 10, mode }, ctx),
      TOOL_HANDLERS.hivemind_recall({ query: args.query, time: { valid_at: to.toISOString() }, tags, limit: 10, mode }, ctx),
    ]);
    // Compute structured delta — added/removed/persisted by memory id.
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
    if (!ctx.webIntelligence?.search) return { error: 'web search not configured' };
    const job = await ctx.webIntelligence.search({ query: args.query, freshness: args.freshness });
    return { job_id: job.job_id || job.id, status: 'queued' };
  },

  async hivemind_web_crawl(args, ctx) {
    if (!ctx.webIntelligence?.crawl) return { error: 'web crawl not configured' };
    const job = await ctx.webIntelligence.crawl({ url: args.url, depth: args.depth });
    return { job_id: job.job_id || job.id, status: 'queued' };
  },

  async hivemind_web_job_status(args, ctx) {
    if (!ctx.webIntelligence?.status) return { error: 'web intel not configured' };
    return ctx.webIntelligence.status({ job_id: args.job_id });
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
  hivemind_recall:           8_000,
  get_user_profile:          3_000,   // two indexed Postgres reads, no LLM
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
    const result = await Promise.race([
      handler(validation.args, ctx),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${name} timed out after ${effectiveTimeout}ms`)), effectiveTimeout)),
    ]);
    return result;
  } catch (err) {
    const msg = err.message || String(err);
    // Standardized error-action map for upstream handlers.
    let mode = 'EXEC_ERROR';
    if (/timed out/.test(msg)) mode = 'TIMEOUT';
    else if (/not found|no such|missing/i.test(msg)) mode = 'NOT_FOUND';
    else if (/unauthorized|forbidden|401|403|invalid token/i.test(msg)) mode = 'AUTH_ERROR';
    else if (/rate limit|429|quota/i.test(msg)) mode = 'RATE_LIMIT';
    return { error: msg, _failure_mode: mode };
  }
}

export const TOOL_NAMES = TOOL_SCHEMAS.map((t) => t.function.name);
export { TOOL_TIMEOUTS_MS };
