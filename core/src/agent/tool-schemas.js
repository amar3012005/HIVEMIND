import { CANONICAL_MEMORY_TYPES } from '../memory/memory-taxonomy.js';

export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'tara_call_get',
      description: 'Read one completed TARA call by durable call, transcript, or session reference. Returns the exact tenant-scoped turns and retained insight. This tool never places a call.',
      parameters: {
        type: 'object',
        properties: {
          reference: { type: 'string', description: 'Call UUID, tara-call:UUID transcript reference, or canonical session ID.' },
        },
        required: ['reference'],
      },
    },
  },
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
          // Ordered direct uploads (for example the latest image) are memory
          // provenance sources, not necessarily KnowledgeDocument rows.
          // Keep these declared so the tool validator preserves the planner's
          // source contract through to RecallRouter.
          source_kind: { type: 'string', enum: ['document', 'image', 'conversation', 'connector'] },
          temporal_selector: { type: 'string', enum: ['latest', 'earliest'], description: 'Order an authorized direct source by stored event/created time; not snapshot time travel.' },
          temporal_axis: { type: 'string', enum: ['known_time', 'event_time', 'valid_time'], description: 'Clock used for latest/earliest ordering. known_time means latest mention, event_time means latest real-world event, and valid_time means latest effective claim.' },
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
          memory_types: { type: 'array', items: { type: 'string' }, maxItems: 12, description: 'Hard semantic type predicate shared by memory and evidence lanes.' },
          entity_filter_mode: { type: 'string', enum: ['must', 'should', 'off'], description: 'Hard entity predicate by default when entities are supplied.' },
          relationship_types: { type: 'array', items: { type: 'string', enum: ['Updates', 'Extends', 'Derives', 'Contradicts', 'Supports', 'References', 'Mentions', 'PartOf', 'Causes', 'Requires', 'Blocks', 'RelatedTo'] }, maxItems: 12, description: 'Return only candidates participating in one of these authorized typed relationships.' },
          relationship_direction: { type: 'string', enum: ['any', 'incoming', 'outgoing'], default: 'any' },
          // V5 D5: planner-signalled expected memory KIND ("what did we decide" => decision).
          // Must be declared here — validateAndSanitize strips undeclared keys.
          answer_type: { type: 'string', enum: ['decision', 'goal', 'preference', 'lesson', 'event', 'relationship', 'fact'], description: 'Expected memory type of the answer, inferred from user intent (language-neutral). Enables the type-aware recall lane.' },
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
      // Counting is a SET question; recall is a SAMPLE. Top-K cannot answer
      // "how many" — it returns the most similar rows, not all matching rows, so
      // any number derived from it is a guess that reads like a fact. Observed:
      // asked "how many prospects from Hannover", chat correctly REFUSED rather
      // than counting 5 sampled memories, because it had no tool that could scan.
      // hivemind_aggregate_entities covers counts hanging off a canonical parent
      // entity; this covers everything else.
      // Spreadsheets are ROWS. Similarity over prose cannot answer "which is
      // highest" or "what is the value for X" — the grid has to stay queryable.
      name: 'hivemind_query_table',
      description:
        'Query a spreadsheet/table from an uploaded document EXACTLY — filter rows, read cells, '
        + 'count matches. Use for any question about a value IN a table ("which channel indexes '
        + 'highest", "what is the budget for X", "how many rows where city=Hannover"). '
        + 'Returns real rows, not a similarity match. Prefer this over hivemind_recall for tabular data.',
      parameters: {
        type: 'object',
        properties: {
          document_title: { type: 'string', description: 'Filename or partial title, e.g. Mediennutzung.' },
          contains: { type: 'string', description: 'Return only rows containing this text in any cell.' },
          column: { type: 'string', description: 'Restrict `contains` to one column (header name).' },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hivemind_count_where',
      description:
        'Exactly count memories matching a filter by SCANNING, not sampling. Use for every '
        + '"how many", "list all", "are there any" question. Returns {count, complete}. '
        + 'When complete is false the scan hit its ceiling and count is a LOWER BOUND — say so '
        + 'explicitly; never present it as exact. Prefer this over hivemind_recall for anything countable.',
      parameters: {
        type: 'object',
        properties: {
          contains: {
            type: 'string',
            description: 'Case-insensitive substring the memory title or content must contain, e.g. Hannover.',
          },
          tags: {
            type: 'array', items: { type: 'string' }, maxItems: 10,
            description: 'Tags that must ALL be present, e.g. ["prospect"].',
          },
          memory_type: {
            type: 'string',
            enum: [...CANONICAL_MEMORY_TYPES],
          },
          source_platform: { type: 'string', description: 'Restrict to one ingestion source.' },
          created_after: { type: 'string', description: 'ISO-8601 lower bound on creation time.' },
          created_before: { type: 'string', description: 'ISO-8601 upper bound on creation time.' },
          project: { type: 'string', description: 'Restrict to one project id.' },
          return_samples: {
            type: 'integer', minimum: 0, maximum: 25, default: 5,
            description: 'How many example matches to return alongside the count.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hivemind_save_memory',
      description:
        'Save one durable fact, event, decision, preference, goal, commitment, policy, procedure, or lesson to HIVEMIND. Use summary/synthesis only for genuinely aggregated knowledge and conversation only for a transcript-like record. Relationships belong in graph edges, not memory_type. Call when the user reveals durable information. ALWAYS tag (≥2 tags). NEVER save chitchat or secrets.\n\nDESTINATION: pass scope when the user explicitly states personal, organization, team, or project destination. For a named project, pass project_id (UUID) or project (name/slug; the server resolves it). Chat-originated saves with no stated destination return an explicit scope choice; do not silently pick a destination from the current page, profile, or project catalog.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '3-8 words, searchable.' },
          content: { type: 'string', description: 'The fact, one claim per memory.' },
          tags: { type: 'array', items: { type: 'string' }, minItems: 2 },
          memory_type: { type: 'string', enum: [...CANONICAL_MEMORY_TYPES] },
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
          _memory_admission: { type: 'string', enum: ['trusted_fact', 'user_assertion'], description: 'Internal provenance supplied by chat planning. A user assertion remains recallable but is not promoted into independently verified background.' },
          _require_explicit_scope: { type: 'boolean', description: 'Internal chat orchestration flag. When true, the save handler returns a destination choice instead of inferring or defaulting an omitted scope.' },
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
        'Bi-temporal snapshot over unified filtered recall. Use valid_at for “what was true then”; use known_at for “what did HIVEMIND know then”; provide both when both constraints matter.\n\nFor connector-scoped time-travel pass tags. Examples:\n  • Slack: tags=["slack"] (+ optional channel:NAME, from:USER)\n  • Notion: tags=["notion"] (+ optional page:NAME)\n  • Gmail: tags=["gmail"] (+ optional from:EMAIL, thread:ID)',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          valid_at: { type: 'string', description: 'ISO timestamp.' },
          known_at: { type: 'string', description: 'ISO timestamp: upper bound on when HIVEMIND learned the fact.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tag filter (connector + marker tags).' },
          entities: { type: 'array', items: { type: 'string' }, maxItems: 12 },
          memory_types: { type: 'array', items: { type: 'string' }, maxItems: 12 },
          source_document_id: { type: 'string' }, source_title: { type: 'string' }, source_kind: { type: 'string' },
          scope_filter: { type: 'string', enum: ['personal', 'project', 'team', 'organization'] },
          relationship_types: { type: 'array', items: { type: 'string' }, maxItems: 12 },
          relationship_direction: { type: 'string', enum: ['any', 'incoming', 'outgoing'] },
          time_axis: { type: 'string', enum: ['event_time', 'valid_time', 'known_time'], default: 'valid_time' },
          mode: { type: 'string', enum: ['quick', 'panorama', 'insight'], default: 'quick' },
        },
        required: ['query'],
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
          entities: { type: 'array', items: { type: 'string' }, maxItems: 12 },
          memory_types: { type: 'array', items: { type: 'string' }, maxItems: 12 },
          source_document_id: { type: 'string' }, source_title: { type: 'string' }, source_kind: { type: 'string' },
          scope_filter: { type: 'string', enum: ['personal', 'project', 'team', 'organization'] },
          relationship_types: { type: 'array', items: { type: 'string' }, maxItems: 12 },
          relationship_direction: { type: 'string', enum: ['any', 'incoming', 'outgoing'] },
          time_axis: { type: 'string', enum: ['event_time', 'valid_time', 'known_time'], default: 'valid_time' },
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
          entities: { type: 'array', items: { type: 'string' }, maxItems: 12 },
          memory_types: { type: 'array', items: { type: 'string' }, maxItems: 12 },
          source_document_id: { type: 'string' }, source_title: { type: 'string' }, source_kind: { type: 'string' },
          scope_filter: { type: 'string', enum: ['personal', 'project', 'team', 'organization'] },
          relationship_types: { type: 'array', items: { type: 'string' }, maxItems: 12 },
          relationship_direction: { type: 'string', enum: ['any', 'incoming', 'outgoing'] },
          time_axis: { type: 'string', enum: ['event_time', 'valid_time', 'known_time'], default: 'valid_time' },
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
      description: 'Render and crawl a specific URL (real browser, not a static fetch). Returns job_id — poll with hivemind_web_job_status. Set capture_screenshot for a visual, or session for a platform (linkedin/x/instagram) where a pre-authorized session exists — see hivemind_web_job_status result for session_used / session_requested_but_missing.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          depth: { type: 'integer', default: 1 },
          capture_screenshot: { type: 'boolean', default: false, description: 'Take a screenshot of the page.' },
          session: { type: 'string', enum: ['linkedin', 'x', 'instagram'], description: 'Reuse a pre-authorized session for this platform, if one has been captured. Falls back to an anonymous view if none exists — never fails the request.' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hivemind_brand_dna',
      description: 'Create a durable, source-backed Brand DNA artifact from a company public website. Uses a bounded same-origin browser crawl, captures rendered evidence, and returns a job_id to poll. Never use this for private URLs or as a replacement for a quick page lookup.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Public HTTPS company homepage or approved same-origin seed URL.' } },
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
      description: 'Set the ASSISTANT\'s name — "call yourself X", "rename the assistant". NOT for the user\'s own name.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_user_profile',
      description: 'Update the CURRENT USER\'s own profile — "change MY name to X", "my role is Y", "I work at Z", "I prefer W". Caller-scoped; never the assistant\'s name. Returns a server-owned confirmation (terminal — no synthesis).',
      parameters: {
        type: 'object',
        properties: {
          fields: { type: 'object', description: 'Any of: name, role, company, language, location, timezone → new value.' },
          preferences: { type: 'array', items: { type: 'string' }, description: 'Free-form durable preferences to record.' },
        },
      },
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
