/**
 * Language-agnostic chat intent parser.
 *
 * Intent is model-parsed through one required structured tool call. There are
 * deliberately no word lists, locale regexes, filename regexes, or imperative
 * phrase fallbacks in this module. A parser outage fails safely to scoped
 * recall of the unchanged user message.
 */

import { chatCompletionFetch } from '../llm/chat-provider.js';

const CHAT_INTENT_VERSION = 'chat-intent.v2';
const OPERATIONS = new Set([
  'direct', 'recall', 'source_read', 'aggregate', 'connector_read',
  'connector_write', 'save', 'update', 'relation_between', 'delete', 'rename_assistant',
  // timeline: version history / "what changed" / "what was true on date X".
  // Served by the bi-temporal tools (hivemind_timeline / _at / _diff) in the
  // gatherEvidence executor. time.valid_at / time.range drive as-of vs diff.
  'timeline',
  // profile: "what do you know about me / my company / my preferences" — served
  // by the get_user_profile tool (caller-scoped; no id from the model).
  'profile',
  // update_profile: "change MY name/role/company/preferences" — caller-scoped
  // profile WRITE (distinct from rename_assistant which renames HIVE). Terminal.
  'update_profile',
  // compound: multi-step request decomposed into ordered subtasks by the
  // progressive router (compound_plan). Executed by the compound orchestrator
  // behind COMPOUND_ORCHESTRATOR_ENABLED.
  'compound',
]);
const RECALL_MODES = new Set(['fact', 'explain', 'full']);
const RESPONSE_DEPTHS = new Set(['standard', 'detailed', 'comprehensive']);
const SCOPES = new Set(['personal', 'project', 'team', 'organization']);
const SIDE_EFFECT_POLICIES = new Set(['read_only', 'approval_required']);

function boundedText(value, max = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function boundedStrings(value, maxItems = 12, maxLength = 512) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item.trim())
      .slice(0, maxItems).map((item) => item.trim().slice(0, maxLength))
    : [];
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(boundedText(value, 64));
}

function validIsoTime(value) {
  const text = boundedText(value, 64);
  if (!text || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(text)) return null;
  const [year, month, day] = text.slice(0, 10).split('-').map(Number);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1 || calendarDate.getUTCDate() !== day) return null;
  return Number.isNaN(Date.parse(text)) ? null : text;
}

export function normalizeChatHistory(history, limit = 6) {
  return (Array.isArray(history) ? history : [])
    .filter((turn) => turn && (turn.role === 'user' || turn.role === 'assistant') && turn.content)
    .slice(-limit)
    .map((turn) => ({ role: turn.role, content: boundedText(turn.content, 800) }));
}

export function createChatIntentTool(groupCatalog = []) {
  const groupNames = groupCatalog.map((group) => group.name).filter(Boolean);
  return {
    type: 'function',
    function: {
      name: 'route_chat_turn',
      description: 'Classify the complete chat turn and select the minimum tool groups required. Preserve the user language, exact entity names, and exact source titles.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          operation: {
            type: 'string',
            enum: [...OPERATIONS],
            description: 'Use relation_between whenever the user asks how two or more named entities are connected, related, associated, dependent, compared, or mentioned together in any language. Use aggregate only for an explicitly certified exact count or registry-complete enumeration; use recall with detailed depth for a useful inventory of known items from workspace context. Use source_read only when the user names a specific file/source. Use recall with recall_mode=explain when the user asks which files or sources mention an entity. Use recall fact only for a bounded direct fact where source reconstruction is unnecessary.',
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          response_language: { type: 'string', description: 'BCP-47 language tag inferred from the request and history.' },
          direct_response: { type: 'string', description: 'Same-language response. Required only for direct.' },
          queries: { type: 'array', items: { type: 'string' }, maxItems: 3 },
          query_original: { type: 'string', description: 'Original user retrieval wording. Preserve names, filenames, identifiers and aliases exactly.' },
          query_canonical_en: { type: 'string', description: 'Concise English retrieval formulation. Preserve exact names, filenames, numbers and identifiers.' },
          named_entities: { type: 'array', items: { type: 'string' }, maxItems: 12 },
          recall_mode: { type: 'string', enum: [...RECALL_MODES] },
          response_depth: {
            type: 'string', enum: [...RESPONSE_DEPTHS],
            description: 'Semantic answer depth. Use standard for ordinary requests, detailed when the user wants meaningful breadth or several aspects, and comprehensive when the request clearly calls for a thorough cross-source treatment or exhaustive detail about every member of a set. This is language-independent and must follow intent, not keywords.',
          },
          answer_objective: {
            type: 'string',
            description: 'One concise instruction describing exactly what the final answer must deliver, including the requested shape such as direct fact, overview, product list, comparison, timeline, or explanation. Do not answer the question here.',
          },
          source: {
            type: 'object', additionalProperties: false,
            properties: { document_id: { type: 'string' }, title: { type: 'string' } },
          },
          aggregate: {
            type: 'object', additionalProperties: false,
            properties: { parent: { type: 'string' }, kind: { type: 'string' } },
            required: ['parent', 'kind'],
            description: 'Required for aggregate. Preserve the canonical parent/entity name and the requested entity kind; this invokes a complete tenant-scoped registry aggregation rather than top-K recall.',
          },
          tool_groups: {
            type: 'array', uniqueItems: true,
            items: groupNames.length ? { type: 'string', enum: groupNames } : { type: 'string' },
          },
          connector_provider: { type: 'string' },
          scope_filter: { type: 'string', enum: [...SCOPES] },
          side_effect_policy: { type: 'string', enum: [...SIDE_EFFECT_POLICIES] },
          save: {
            type: 'object', additionalProperties: false,
            properties: {
              title: { type: 'string' }, content: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' }, maxItems: 12 },
              memory_type: { type: 'string' }, project_hint: { type: 'string' },
              project_id: { type: 'string', description: 'Choose only an authorized project id supplied in the project catalog.' },
              entities: { type: 'array', items: { type: 'string' }, maxItems: 12 },
              event_time: { type: 'string', description: 'ISO event/valid time when explicitly supplied.' },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
              admission_class: {
                type: 'string', enum: ['trusted_fact', 'user_assertion'],
                description: 'trusted_fact only for a stable, first-party fact the user can authoritatively establish. user_assertion is an attributable user-provided note: retain it when asked, but do not elevate it into independently verified background about another person.',
              },
            },
            required: ['title', 'content'],
          },
          update: {
            type: 'object', additionalProperties: false,
            properties: {
              id: { type: 'string', description: 'Existing memory UUID only. If unknown, leave empty and use target_query.' }, target_query: { type: 'string', description: 'Exact title, entity, or prior claim used to resolve the authorized current memory.' }, content: { type: 'string', description: 'Complete replacement claim including its subject; never an empty string or pronoun fragment.' },
              title: { type: 'string' }, reason: { type: 'string' }, project_id: { type: 'string' },
              project_hint: { type: 'string' }, entities: { type: 'array', items: { type: 'string' }, maxItems: 12 },
              event_time: { type: 'string' },
            },
            required: ['content'],
          },
          profile_update: {
            type: 'object', additionalProperties: false,
            description: 'operation=update_profile only: the CURRENT USER\'s own profile fields (never the assistant name).',
            properties: {
              fields: {
                type: 'object', additionalProperties: false,
                properties: {
                  name: { type: 'string' }, role: { type: 'string' }, company: { type: 'string' },
                  language: { type: 'string' }, location: { type: 'string' },
                },
              },
              preferences: { type: 'array', items: { type: 'string' }, maxItems: 12 },
            },
          },
          relation: {
            type: 'object', additionalProperties: false,
            properties: {
              entities: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 6 },
              source: {
                type: 'object', additionalProperties: false,
                properties: { document_id: { type: 'string' }, title: { type: 'string' } },
              },
              time: {
                type: 'object', additionalProperties: false,
                properties: { valid_at: { type: 'string' }, known_at: { type: 'string' } },
              },
            },
            required: ['entities'],
          },
          delete: {
            type: 'object', additionalProperties: false,
            properties: { id: { type: 'string' }, reason: { type: 'string' } },
            required: ['id'],
          },
          time: {
            type: 'object', additionalProperties: false,
            properties: {
              valid_at: { type: 'string' }, known_at: { type: 'string' },
              range: {
                type: 'object', additionalProperties: false,
                properties: { start: { type: 'string' }, end: { type: 'string' } },
              },
            },
          },
          continuation: {
            type: 'object', additionalProperties: false,
            properties: {
              kind: { type: 'string', enum: ['project_choice'] },
              project_hint: { type: 'string' }, selected_scope: { type: 'string', enum: [...SCOPES] },
            },
          },
          assistant_name: { type: 'string' },
          project_prompt: { type: 'string', description: 'Same-language question to ask if memory scope is unresolved.' },
          acknowledgement: { type: 'string', description: 'Same-language acknowledgement for a successful save, mutation, or connector write.' },
          failure_response: { type: 'string', description: 'Same-language response if the selected operation or toolkit cannot be executed safely.' },
        },
        required: ['operation', 'confidence', 'response_language', 'queries', 'named_entities', 'recall_mode', 'response_depth', 'answer_objective', 'tool_groups', 'side_effect_policy'],
      },
    },
  };
}

function safeRecallDecision({ message, language, reason }) {
  return {
    version: CHAT_INTENT_VERSION,
    operation: 'recall', confidence: 0,
    response_language: boundedText(language, 32) || 'und',
    direct_response: '', queries: [boundedText(message)], named_entities: [],
    query_original: boundedText(message), query_canonical_en: boundedText(message),
    recall_mode: 'fact', source: null, aggregate: null, tool_groups: ['hivemind-recall'],
    response_depth: 'standard', answer_objective: boundedText(message),
    connector_provider: null, scope_filter: null, side_effect_policy: 'read_only',
    save: null, update: null, relation: null, delete: null, time: null, continuation: null,
    assistant_name: null, project_prompt: '', acknowledgement: '', failure_response: '',
    parser_fallback: reason || 'intent_parser_unavailable',
  };
}

export function normalizeIntentDecision(raw, { message, language, allowedGroups = [] } = {}) {
  if (!raw || typeof raw !== 'object' || !OPERATIONS.has(raw.operation)) {
    return safeRecallDecision({ message, language, reason: 'invalid_intent_payload' });
  }
  const allowed = new Set(allowedGroups);
  const operation = raw.operation;
  const sideEffect = operation === 'connector_write' || operation === 'delete'
    ? 'approval_required'
    : (SIDE_EFFECT_POLICIES.has(raw.side_effect_policy) ? raw.side_effect_policy : 'read_only');
  const queries = boundedStrings(raw.queries, 3, 1000);
  const namedEntities = boundedStrings(raw.named_entities, 12, 256);
  if (operation !== 'direct' && queries.length === 0 && !['save', 'update', 'delete', 'rename_assistant', 'update_profile'].includes(operation)) {
    queries.push(boundedText(message));
  }
  const source = raw.source && (boundedText(raw.source.document_id, 128) || boundedText(raw.source.title, 512))
    ? { document_id: boundedText(raw.source.document_id, 128) || null, title: boundedText(raw.source.title, 512) || null }
    : null;
  const aggregate = raw.aggregate && boundedText(raw.aggregate.parent, 256) && boundedText(raw.aggregate.kind, 128)
    ? { parent: boundedText(raw.aggregate.parent, 256), kind: boundedText(raw.aggregate.kind, 128), requires_complete_coverage: true }
    : null;
  const toolGroups = boundedStrings(raw.tool_groups, 12, 128).filter((name) => allowed.has(name));
  const requiredNativeGroup = ['recall', 'source_read', 'aggregate', 'relation_between', 'timeline', 'profile'].includes(operation)
    ? 'hivemind-recall'
    : ['save', 'update', 'delete', 'rename_assistant', 'update_profile'].includes(operation) ? 'hivemind-memory-write' : null;
  if (requiredNativeGroup && allowed.has(requiredNativeGroup) && !toolGroups.includes(requiredNativeGroup)) {
    toolGroups.push(requiredNativeGroup);
  }
  const normalized = {
    version: CHAT_INTENT_VERSION,
    operation,
    confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0)),
    response_language: boundedText(raw.response_language, 32) || boundedText(language, 32) || 'und',
    direct_response: boundedText(raw.direct_response, 2000),
    queries,
    query_original: boundedText(raw.query_original, 2000) || boundedText(message, 2000),
    query_canonical_en: boundedText(raw.query_canonical_en, 2000) || queries[0] || boundedText(message, 2000),
    named_entities: namedEntities,
    // Full reconstruction is caller-explicit only. The router can request at
    // most explain; applyExplicitRecallControls may promote to full later.
    recall_mode: raw.recall_mode === 'full'
      ? 'explain'
      : (RECALL_MODES.has(raw.recall_mode) ? raw.recall_mode : 'fact'),
    response_depth: RESPONSE_DEPTHS.has(raw.response_depth) ? raw.response_depth : 'standard',
    answer_objective: boundedText(raw.answer_objective, 1000) || boundedText(message, 1000),
    source,
    aggregate,
    tool_groups: toolGroups,
    connector_provider: boundedText(raw.connector_provider, 128) || null,
    scope_filter: SCOPES.has(raw.scope_filter) ? raw.scope_filter : null,
    side_effect_policy: sideEffect,
    save: raw.save && boundedText(raw.save.content)
      ? {
          title: boundedText(raw.save.title, 200), content: boundedText(raw.save.content),
          tags: boundedStrings(raw.save.tags, 12, 128), memory_type: boundedText(raw.save.memory_type, 64) || 'fact',
          project_hint: boundedText(raw.save.project_hint, 256) || null,
          project_id: boundedText(raw.save.project_id, 128) || null,
          entities: boundedStrings(raw.save.entities, 12, 256),
          event_time: validIsoTime(raw.save.event_time),
          confidence: Math.max(0, Math.min(1, Number(raw.save.confidence) || 0)),
          admission_class: raw.save.admission_class === 'user_assertion' ? 'user_assertion' : 'trusted_fact',
        }
      : null,
    update: raw.update && boundedText(raw.update.content)
      && (boundedText(raw.update.id, 128) || boundedText(raw.update.target_query, 1000))
      ? {
          id: isUuid(raw.update.id) ? boundedText(raw.update.id, 64) : null,
          target_query: boundedText(raw.update.target_query, 1000)
            || (!isUuid(raw.update.id) ? boundedText(raw.update.id, 1000) : null),
          content: boundedText(raw.update.content), title: boundedText(raw.update.title, 200),
          reason: boundedText(raw.update.reason, 500), project_id: boundedText(raw.update.project_id, 128) || null,
          project_hint: boundedText(raw.update.project_hint, 256) || null,
          entities: boundedStrings(raw.update.entities, 12, 256),
          event_time: validIsoTime(raw.update.event_time),
        }
      : null,
    relation: (raw.relation || (operation === 'relation_between' ? { entities: namedEntities } : null))
      && boundedStrings(raw.relation?.entities || namedEntities, 6, 256).length >= 2
      ? {
          entities: boundedStrings(raw.relation?.entities || namedEntities, 6, 256),
          source: raw.relation?.source ? {
            document_id: boundedText(raw.relation.source.document_id, 128) || null,
            title: boundedText(raw.relation.source.title, 512) || null,
          } : null,
          time: raw.relation?.time ? {
            valid_at: validIsoTime(raw.relation.time.valid_at),
            known_at: validIsoTime(raw.relation.time.known_at),
          } : null,
        }
      : null,
    delete: raw.delete && boundedText(raw.delete.id, 128)
      ? { id: boundedText(raw.delete.id, 128), reason: boundedText(raw.delete.reason, 500) }
      : null,
    profile_update: (() => {
      const pu = raw.profile_update || (operation === 'update_profile' ? {} : null);
      if (!pu) return null;
      const f = pu.fields || {};
      const fields = {};
      for (const k of ['name', 'role', 'company', 'language', 'location']) {
        const v = boundedText(f[k], 256);
        if (v) fields[k] = v;
      }
      const preferences = boundedStrings(pu.preferences, 12, 256);
      return (Object.keys(fields).length || preferences.length) ? { fields, preferences } : null;
    })(),
    time: raw.time ? {
      valid_at: validIsoTime(raw.time.valid_at),
      known_at: validIsoTime(raw.time.known_at),
      range: raw.time.range ? { start: validIsoTime(raw.time.range.start), end: validIsoTime(raw.time.range.end) } : null,
    } : null,
    continuation: raw.continuation?.kind === 'project_choice'
      ? { kind: 'project_choice', project_hint: boundedText(raw.continuation.project_hint, 256) || null, selected_scope: SCOPES.has(raw.continuation.selected_scope) ? raw.continuation.selected_scope : null }
      : null,
    assistant_name: boundedText(raw.assistant_name, 80) || null,
    project_prompt: boundedText(raw.project_prompt, 1000),
    acknowledgement: boundedText(raw.acknowledgement, 1000),
    failure_response: boundedText(raw.failure_response, 1000),
  };
  const invalid =
    (operation === 'direct' && !normalized.direct_response)
    || (operation === 'source_read' && !normalized.source)
    || (operation === 'aggregate' && !normalized.aggregate)
    || (operation === 'connector_read' && (!normalized.connector_provider || normalized.tool_groups.length === 0))
    || (operation === 'connector_write' && (!normalized.connector_provider || normalized.tool_groups.length === 0))
    || (operation === 'save' && !normalized.save)
    || (operation === 'update' && !normalized.update)
    || (operation === 'relation_between' && !normalized.relation)
    || (operation === 'delete' && !normalized.delete)
    || (operation === 'rename_assistant' && !normalized.assistant_name)
    || (operation === 'update_profile' && !normalized.profile_update)
    || (['connector_read', 'connector_write'].includes(operation) && !normalized.failure_response)
    // update_profile intentionally NOT here: the server-owned mutationConfirmation
    // is the user-facing message for the write, and gemini-flash-lite reliably
    // omits `acknowledgement` — requiring it discarded correct routing.
    || (['connector_write', 'delete', 'rename_assistant'].includes(operation) && !normalized.acknowledgement);
  return invalid ? safeRecallDecision({ message, language, reason: 'invalid_intent_combination' }) : normalized;
}

export async function parseChatIntent({
  message, language = null, history = [], groupCatalog = [], model, apiKey,
  signal, fetchImpl = globalThis.fetch, projectCatalog = [],
} = {}) {
  const allowedGroups = groupCatalog.map((group) => group.name).filter(Boolean);
  const catalog = groupCatalog.map((group) => ({
    name: boundedText(group.name, 128),
    description: boundedText(group.description, 300),
    tools: (group.tools || []).slice(0, 24).map((tool) => ({
      name: boundedText(tool.name, 128),
      description: boundedText(tool.description, 240),
      read_only: tool.readOnly === true,
    })),
  }));
  const system = `You are the fast intent and capability parser for a multi-tenant enterprise assistant.
Return exactly one route_chat_turn tool call. Understand the user's language directly; do not translate exact names, filenames, identifiers, or search queries.
Use the conversation history to resolve references. Select the minimum tool groups whose descriptions match the request.
  Operation contract: use source_read only when the user names a specific source/file. When the user asks which file(s) or source(s) mention or describe an entity without naming a file, use operation=recall with recall_mode=explain and keep only real names/identifiers in named_entities. Use relation_between when the user asks how two or more exact entities are connected, related, associated, dependent, compared, or mentioned together. This applies in every language and is not ordinary recall. Use aggregate only when the user explicitly requires a certified exact count or registry-complete enumeration. A request for a useful inventory of known products, people, projects, or other items from remembered context uses recall with response_depth=detailed. A top-K recall answer cannot certify completeness, so disclose that boundary rather than misrouting an ordinary inventory. Use connector_read for current connected-app or native operational data. Use connector_write for an explicit connector action OR an explicit native operation such as creating, regenerating, or pausing a campaign. When the campaigns group is available, requests to create/run/start a campaign must select connector_provider=campaigns and tool_groups=["campaigns"]. Campaign creation starts a dedicated planning Room and does not publish.
  Routing examples: "How are SolvisPia and SolvisMax related?", "Wie hängen SolvisPia und SolvisMax zusammen?", "Quel est le lien entre SolvisPia et SolvisMax ?", "¿Qué relación hay entre SolvisPia y SolvisMax?", "SolvisPia और SolvisMax कैसे जुड़े हैं?", and "ما العلاقة بين SolvisPia وSolvisMax؟" all require operation=relation_between with relation.entities=["SolvisPia","SolvisMax"]. A question about only one entity requires recall instead.
  Source-discovery examples: "Which files mention SolvisPia?", "In welcher Datei wird SolvisPia beschrieben?", and equivalent questions in any language require operation=recall, recall_mode=explain, named_entities=["SolvisPia"]. Do not add generic words such as file, source, document, relationship, product, company, or question words to named_entities.
  Profile routing: use operation=profile when the user asks about THEMSELVES or their OWN organization — "what do you know about me", "who am I", "my role/company/preferences/goals", "was weißt du über mich / meine Firma", equivalents in any language. It returns the maintained user+org profile. A question about some OTHER entity/person is recall, not profile.
  Profile WRITE routing: use operation=update_profile when the user states or changes a fact about THEMSELVES — "change my name to Amar Sai", "my role is Head of Product", "I work at Solvis", "meine Firma ist …", "call me …", equivalents in any language. Put the changed field in profile_update.fields (name/role/company/language/location) and any stated preference in profile_update.preferences, plus an acknowledgement. This is DISTINCT from rename_assistant: "call yourself Atlas", "rename the assistant", "your name is …" set the ASSISTANT name (rename_assistant), never the user profile. If a bare "change my name" is ambiguous about whose name, it refers to the USER (update_profile).
  Temporal / timeline routing: use operation=timeline when the user asks how something CHANGED over time, its history/versions, or what was true AT a past date. Set time.valid_at (as-of a single instant, e.g. "as of March 2026", "letztes Jahr", "was it true on 2026-05-01"), OR time.range {start,end} (a span, e.g. "what changed between May and July", "seit 2025"), OR neither for a full version history ("what's the history of X", "how has the launch date changed", "wie hat sich X entwickelt"). Keep the topic in named_entities/query. Examples in any language: "What changed about SolvisPia since 2025?" (range start=2025-01-01), "What was the launch date as of last week?" (valid_at), "Show me the history of the pricing decision" (no time = full timeline). A plain current-fact question is NOT timeline — use recall.
Always return query_original in the user's wording and query_canonical_en as a concise, intent-preserving English retrieval expression. It must not be merely a punctuation-stripped copy. Preserve exact filenames, people, companies, products, numbers, identifiers and aliases. Include only the semantic facets needed to retrieve the requested answer: an inventory should carry its category plus concepts such as names, models, variants and categories; a comparison should carry the entities and comparison dimensions; a bounded fact should stay narrow. Do not invent facts or entity names.
Choose response_depth semantically in the user's language. Most ordinary turns are standard. Use detailed when the requested outcome genuinely needs multiple aspects, a useful inventory, comparison, explanation, or broad overview. Use comprehensive when the user clearly wants a thorough treatment across all relevant retained evidence or exhaustively requests detailed attributes for every member of a set. This is an intent distinction, never a language or keyword rule. Do not promote depth merely because many candidates exist. Write answer_objective as a precise, compact instruction for the final synthesizer: preserve the subject, requested facets, requested answer shape, and any explicit exclusions. For example, an organization overview should cover identity, activity, products/positioning, and notable facts supported by evidence; a product question should enumerate and describe products rather than drift into general company background.
Return explicit ISO time fields when the request is temporal; do not make downstream code infer dates from words.
For every stable declarative user assertion, emit a fully resolved save object even when the user does not explicitly ask to save it. Set admission_class=trusted_fact only for durable first-party facts the user can authoritatively establish about themselves, their organisation, products, decisions, naming, history, or confirmed work. Set admission_class=user_assertion for statements about another person or any claim that is only the user's assertion; it remains as an attributable user note rather than becoming independently verified background. Questions, requests, and transient conversational reactions do not need a save object. Acknowledging a durable assertion in prose WITHOUT emitting its save object is a failure: the next recall would answer from stale context. Put the complete resolved statement in save.content; never return a pronoun or the save instruction itself.
For implicit durable facts or attributable user assertions, use save only at confidence >= 0.80. For explicit save continuations, resolve the immediately preceding user statement from history; if it is only an assertion, preserve it as admission_class=user_assertion. For save/update, choose project_id only from the authorized project catalog below; if no project clearly fits, leave project_id null. Never invent a project id.
For update, provide either the exact memory UUID from conversation context or a precise target_query; never put an entity name in id. update.content must be the complete replacement claim, including the exact subject and new value. Downstream code resolves authorized latest memories and refuses ambiguity.
When the prior assistant requested a project choice, resolve it through continuation instead of copying the prior prompt text.
Use scope_filter=personal for questions specifically about the user. Saving a NEW fact is additive and needs no permission — never reply "would you like me to save this?"; just emit the save and acknowledge that you stored it. Only a destructive write (delete) needs approval, and that is enforced in code by a server-issued one-time token, not by asking here. Never broaden organization or project scope.
For direct conversational replies, supply direct_response in the user's language.
For connector operations, supply failure_response in the user's language for a safe execution failure. For connector_write also supply acknowledgement.
Authorized projects:\n${JSON.stringify((projectCatalog || []).slice(0, 24))}\nAvailable tool groups:\n${JSON.stringify(catalog)}`;
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      ...normalizeChatHistory(history),
      { role: 'user', content: boundedText(message, 6000) },
    ],
    tools: [createChatIntentTool(groupCatalog)],
    tool_choice: { type: 'function', function: { name: 'route_chat_turn' } },
    temperature: 0,
    max_tokens: 650,
  };
  const fallbackModel = String(process.env.CHAT_INTENT_FALLBACK_MODEL || 'openai/gpt-oss-20b:nitro').trim();
  const models = [...new Set([model, fallbackModel].filter(Boolean))];
  let lastError = null;
  let firstError = null;
  for (let index = 0; index < models.length; index += 1) {
    const candidateModel = models[index];
    const parserController = new AbortController();
    const timeoutMs = index === 0
      ? Number(process.env.CHAT_INTENT_TIMEOUT_MS || 2500)
      : Number(process.env.CHAT_INTENT_FALLBACK_TIMEOUT_MS || 4500);
    const timeout = setTimeout(() => parserController.abort(), timeoutMs);
    const abortFromParent = () => parserController.abort();
    if (signal) {
      if (signal.aborted) parserController.abort();
      else signal.addEventListener('abort', abortFromParent, { once: true });
    }
    try {
      const response = await chatCompletionFetch(candidateModel, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, model: candidateModel }), signal: parserController.signal,
      }, { fallbackApiKey: apiKey, fetchImpl, useCase: 'chat_planner' });
      if (!response.ok) throw new Error(`intent_parser_http_${response.status}`);
      const data = await response.json();
      const call = data?.choices?.[0]?.message?.tool_calls?.find((item) => item.function?.name === 'route_chat_turn');
      if (!call) throw new Error('intent_parser_missing_tool_call');
      let parsed;
      try { parsed = JSON.parse(call.function.arguments || '{}'); } catch { throw new Error('intent_parser_invalid_json'); }
      return {
        decision: normalizeIntentDecision(parsed, { message, language, allowedGroups }),
        usage: data.usage || null,
        model: candidateModel,
        fallback_used: index > 0,
      };
    } catch (error) {
      if (!firstError) firstError = error;
      lastError = error;
      if (signal?.aborted) break;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener?.('abort', abortFromParent);
    }
  }
  return { decision: safeRecallDecision({ message, language, reason: firstError?.message || lastError?.message }), usage: null, fallback_used: true };
}

export function intentDecisionToPlan(decision, message) {
  const operation = decision.operation;
  return {
    intent_kind: operation === 'save' ? 'save'
      : (operation === 'connector_write' || operation === 'update_profile') ? 'action'
      : 'lookup',
    user_message: message,
    operation,
    intents: [operation],
    sub_queries: ['save', 'update', 'delete', 'rename_assistant', 'update_profile'].includes(operation) ? [] : decision.queries,
    named_entities: decision.named_entities,
    answer_type: decision.answer_type || null,
    query_original: decision.query_original,
    query_canonical_en: decision.query_canonical_en,
    native_tool: decision.native_tool || null,
    temporal_axis: decision.temporal_axis || null,
    response_depth: decision.response_depth || 'standard',
    retrieval_shape: decision.retrieval_shape || 'fact',
    answer_objective: decision.answer_objective || message,
    recall_mode: decision.source || decision.aggregate ? 'explain' : decision.recall_mode,
    source: decision.relation?.source || decision.source,
    aggregate: decision.aggregate,
    requires_complete_coverage: !!decision.aggregate,
    scope_filter: decision.scope_filter,
    tool_groups: decision.tool_groups,
    live_providers: operation === 'connector_read' && decision.connector_provider ? [decision.connector_provider] : [],
    action_intent: operation === 'connector_write' ? decision.connector_provider : null,
    save_intent: operation === 'save' ? decision.save : null,
    auto_save_intent: operation !== 'save' && decision.save?.confidence >= 0.80 ? decision.save : null,
    update_intent: operation === 'update' ? decision.update : null,
    relation_intent: operation === 'relation_between' ? decision.relation : null,
    delete_intent: operation === 'delete' ? decision.delete : null,
    profile_update_intent: operation === 'update_profile' ? (decision.profile_update || { fields: {}, preferences: [] }) : null,
    recall_time: decision.relation?.time || decision.time,
    time: decision.relation?.time || decision.time,
    continuation: decision.continuation,
    assistant_name_intent: operation === 'rename_assistant' ? decision.assistant_name : null,
    _direct_answer: operation === 'direct' ? decision.direct_response : null,
    project_prompt: decision.project_prompt,
    acknowledgement: decision.acknowledgement,
    failure_response: decision.failure_response,
    needs_traverse: operation === 'relation_between',
    // Time-travel fires when the planner declared a timeline op OR supplied any
    // bi-temporal field. The gatherEvidence executor reads these to dispatch
    // hivemind_timeline (op=timeline / version history), hivemind_diff (a range),
    // or an as-of hivemind_at (valid_at/known_at). Previously hardcoded false,
    // so temporal chat questions never reached the bi-temporal tools.
    // Event-time windows ("what did we do yesterday") are bounded retrieval,
    // not time travel. They must reach hivemind_recall's date_range lane and
    // must not also run hivemind_at/hivemind_diff, whose snapshot semantics are
    // different. Existing untyped ranges retain the legacy diff behaviour.
    needs_time_travel: operation === 'timeline'
      || (decision.time?.kind !== 'event_range'
        && !!(decision.time?.valid_at || decision.time?.known_at || decision.time?.range)),
    time_travel: (decision.relation?.time || decision.time) || null,
    needs_web: false, ask_for_project: false, expected_evidence_types: [],
  };
}
