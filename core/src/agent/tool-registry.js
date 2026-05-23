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

// ── Tool schemas (LLM-visible) ───────────────────────────────────────────────

export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'hivemind_recall',
      description:
        `Unified retrieval — the ONLY recall entry point. Memory-first sequential pipeline; you do NOT pick storage tiers, the router does.\n\nReturns three lanes:\n  memories[]  — canonical facts (chat, decisions, people, projects, KB summaries)\n  evidence[]  — full document segments when the query anchors a doc (filename tag, doc-hash, or sparse memory match)\n  live[]      — fresh Gmail / Drive / Calendar items when memory layer hints at workspace data\nPlus trace{} explaining what fired.\n\nHow to call:\n  • query: pass user's literal wording — include filenames verbatim ("Dachmarke (1).pdf") when mentioned\n  • Issue 2-4 broad sub-queries varying in scope (entity-only, entity+topic, side-topic, filename) — the router de-dupes across them\n  • limit: 12 default, 25 for "summarize everything about X"\n\nHow to read:\n  • If memories[] OR evidence[] OR live[] has ANY relevant row, USE IT — don't say "I don't have notes"\n  • Cite memory titles inline, reference evidence as "[Doc Title — p.N]"\n  • Synthesize across rows, don't list silos\n  • trace.tiers_fired tells you which tiers contributed`,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language query.' },
          mode: { type: 'string', enum: ['quick', 'panorama', 'insight'], default: 'quick' },
          limit: { type: 'integer', default: 10, minimum: 1, maximum: 50 },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tag filters.' },
          source_type: { type: 'string', enum: ['text', 'code', 'conversation', 'documentation', 'decision'] },
          valid_at: { type: 'string', description: 'ISO timestamp for bi-temporal time-travel.' },
        },
        required: ['query'],
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
          memory_type: { type: 'string', enum: ['fact', 'preference', 'decision', 'goal', 'event', 'lesson', 'relationship'] },
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
          content: { type: 'string' },
          title: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string', description: 'Why it changed.' },
        },
        required: ['id'],
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
      name: 'hivemind_at',
      description:
        'Bi-temporal snapshot: what did we know about X on date Y? Filters to memories whose document_date ≤ valid_at AND were already ingested by then.\n\nFor connector-scoped time-travel pass tags. Examples:\n  • Slack: tags=["slack"] (+ optional channel:NAME, from:USER)\n  • Notion: tags=["notion"] (+ optional page:NAME)\n  • Gmail: tags=["gmail"] (+ optional from:EMAIL, thread:ID)',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          valid_at: { type: 'string', description: 'ISO timestamp.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tag filter (connector + marker tags).' },
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
        'Chronological list of memories matching a query, ordered by document_date desc.\n\nFor connector-scoped timeline pass tags. Useful for "history of decisions in #X" or "all msgs from @user".',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer', default: 20 },
          tags: { type: 'array', items: { type: 'string' } },
          valid_at: { type: 'string', description: 'Optional upper bound for time-travel.' },
        },
        required: ['query'],
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
  async hivemind_recall(args, ctx) {
    if (!ctx.persistentMemoryStore) throw new Error('memory store unavailable');

    // Single entry point — RecallRouter owns tier orchestration.
    // Memory-first, event-driven, no regex classifier. Memory layer's tags
    // are the routing oracle for evidence + live workspace lookups.
    const { RecallRouter } = await import('../memory/recall-router.js');
    const router = new RecallRouter({
      persistentMemoryStore: ctx.persistentMemoryStore,
      evidenceRetrieval:     ctx.evidenceRetrieval,
      prisma:                ctx.prisma,
    });

    const result = await router.recall(args.query, {
      limit:          args.limit,
      tags:           args.tags,
      source_type:    args.source_type,
      valid_at:       args.valid_at,
      include_live:   args.include_live,
    }, {
      userId:        ctx.userId,
      orgId:         ctx.orgId,
      projectId:     ctx.projectId,
      accessContext: ctx.accessContext,
    });

    return {
      mode:           args.mode || 'quick',
      count:          result.memories.length,
      memories:       result.memories,
      live_count:     result.live.length,
      live:           result.live,
      evidence_count: result.evidence.length,
      evidence:       result.evidence,
      trace:          result.trace,
    };
  },

  async hivemind_save_memory(args, ctx) {
    if (!ctx.persistentMemoryEngine || !ctx.buildRoutedIngestPayloads) {
      throw new Error('ingest pipeline unavailable');
    }
    // Coerce memory_type to a valid Prisma enum value. Models routinely
    // emit 'note', 'observation', 'todo' etc — they're sensible English
    // but not in our locked enum. Map known synonyms; fall back to 'fact'.
    const ALLOWED = new Set(['fact', 'preference', 'decision', 'goal', 'event', 'lesson', 'relationship']);
    const TYPE_ALIAS = {
      note: 'fact', observation: 'fact', todo: 'goal', task: 'goal',
      reminder: 'goal', insight: 'lesson', learning: 'lesson',
      idea: 'fact', knowledge: 'fact', context: 'fact',
      contact: 'relationship', person: 'relationship', user: 'relationship',
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
    let resolvedProjectName = null;
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

    const hasProject = Boolean(resolvedProjectId);
    const scope = ['personal', 'project', 'team', 'organization'].includes(explicitScope)
      ? explicitScope
      : (hasProject ? 'project' : 'personal');

    const payload = {
      title: args.title,
      content: args.content,
      tags: args.tags || [],
      memory_type: memType,
      user_id: ctx.userId,
      org_id: ctx.orgId,
      scope,
      project_ids: resolvedProjectId ? [resolvedProjectId] : [],
      source_metadata: { source_platform: 'talk-to-hive', via: 'react-agent' },
    };
    const [routed] = await ctx.buildRoutedIngestPayloads(payload, {
      smartIngestRouter: ctx.smartIngestRouter,
    });
    // Use tree-aware dispatcher when provided so conversation/document
    // sessions with multiple turns/sections produce parent + children +
    // PartOf edges in one transaction. Falls back to ingestMemory for
    // legacy flat payloads or older server.js versions without the
    // dispatcher attached on ctx.
    const saved = ctx.ingestRoutedPayload
      ? await ctx.ingestRoutedPayload(routed, ctx.persistentMemoryEngine)
      : await ctx.persistentMemoryEngine.ingestMemory(routed);
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
    if (!ctx.persistentMemoryStore) throw new Error('memory store unavailable');
    const updated = await ctx.persistentMemoryStore.updateMemory({
      id: args.id,
      content: args.content,
      title: args.title,
      tags: args.tags,
      user_id: ctx.userId,
      org_id: ctx.orgId,
      update_reason: args.reason,
    });
    return { updated: true, id: args.id, reason: args.reason };
  },

  async hivemind_get_memory(args, ctx) {
    if (!ctx.persistentMemoryStore) throw new Error('memory store unavailable');
    const m = await ctx.persistentMemoryStore.getMemory(args.id);
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
    await ctx.persistentMemoryStore.deleteMemory({ id: args.id, user_id: ctx.userId, org_id: ctx.orgId });
    return { deleted: true, id: args.id };
  },

  async hivemind_traverse_graph(args, ctx) {
    if (!ctx.persistentMemoryStore?.traverseGraph) {
      return { error: 'graph traversal unavailable' };
    }
    const nodes = await ctx.persistentMemoryStore.traverseGraph({
      memory_id: args.memory_id,
      depth: args.depth || 2,
      relationship: args.relationship === 'all' ? null : args.relationship,
      user_id: ctx.userId,
      org_id: ctx.orgId,
    });
    return { count: nodes.length, nodes: nodes.slice(0, 30) };
  },

  async hivemind_at(args, ctx) {
    // Accept both `valid_at` (canonical) and `valid_time` / `transaction_time`
    // (planner's naming). memory_query falls back to query.
    const rawValidAt = args.valid_at || args.valid_time || args.transaction_time;
    const valid_at = new Date(rawValidAt);
    if (Number.isNaN(valid_at.getTime())) throw new Error('invalid valid_at date');
    if (args.memory_query && !args.query) args.query = args.memory_query;
    return TOOL_HANDLERS.hivemind_recall(
      {
        query: args.query,
        valid_at: valid_at.toISOString(),
        tags: Array.isArray(args.tags) && args.tags.length > 0 ? args.tags : undefined,
        limit: 15,
      },
      ctx
    );
  },

  async hivemind_diff(args, ctx) {
    const from = new Date(args.from);
    const to = new Date(args.to);
    const tags = Array.isArray(args.tags) && args.tags.length > 0 ? args.tags : undefined;
    const [a, b] = await Promise.all([
      TOOL_HANDLERS.hivemind_recall({ query: args.query, valid_at: from.toISOString(), tags, limit: 10 }, ctx),
      TOOL_HANDLERS.hivemind_recall({ query: args.query, valid_at: to.toISOString(), tags, limit: 10 }, ctx),
    ]);
    return { from: a, to: b };
  },

  async hivemind_timeline(args, ctx) {
    return TOOL_HANDLERS.hivemind_recall(
      {
        query: args.query,
        mode: 'panorama',
        limit: args.limit || 20,
        tags: Array.isArray(args.tags) && args.tags.length > 0 ? args.tags : undefined,
        ...(args.valid_at && !Number.isNaN(new Date(args.valid_at).getTime())
          ? { valid_at: new Date(args.valid_at).toISOString() }
          : {}),
      },
      ctx
    );
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
    const [routed] = await ctx.buildRoutedIngestPayloads(payload, {
      smartIngestRouter: ctx.smartIngestRouter,
    });
    const saved = ctx.ingestRoutedPayload
      ? await ctx.ingestRoutedPayload(routed, ctx.persistentMemoryEngine)
      : await ctx.persistentMemoryEngine.ingestMemory(routed);
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

// ── Dispatch entry ───────────────────────────────────────────────────────────

// Per-tool timeout contract. Default 15s for unspecified tools.
// Source: ai-boost/awesome-harness-engineering 2026 recommendations +
// observed P95 latencies in HIVEMIND production.
const TOOL_TIMEOUTS_MS = {
  hivemind_recall:           8_000,
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
