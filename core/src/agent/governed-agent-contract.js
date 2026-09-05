import crypto from 'node:crypto';

/**
 * The governed graph's closed-world contract.
 *
 * These helpers intentionally know nothing about Gmail, LinkedIn, or a
 * provider-specific slug.  They reason only over a Meta Tool's authority,
 * JSON schema, receipts, and the semantic outcome supplied by the planner.
 */
export const GOVERNED_ACTIONS = Object.freeze(['discover', 'resolve_dependency', 'read', 'draft', 'ask', 'done']);

const READ_OPERATIONS = new Set(['fetch', 'find', 'get', 'list', 'read', 'retrieve', 'search', 'view']);
const WRITE_OPERATIONS = new Set(['add', 'append', 'archive', 'create', 'delete', 'modify', 'patch', 'post', 'remove', 'reply', 'send', 'set', 'update', 'upload']);
const PROVIDER_IDENTIFIER = /(?:^|_)(?:id|ids|urn|url|cursor|token|resource|thread|message|draft)(?:$|_)/i;

const asText = (value, limit = 900) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
const normalized = value => asText(value, 320).toLowerCase();

export function hashGovernedValue(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex');
}

export function capabilityAuthority(slug = '') {
  const tokens = String(slug).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const operation = tokens.find(token => READ_OPERATIONS.has(token) || WRITE_OPERATIONS.has(token));
  if (READ_OPERATIONS.has(operation)) return 'read';
  if (WRITE_OPERATIONS.has(operation)) return 'write';
  return 'unknown';
}

export function humanizeField(field) {
  const words = String(field || 'information').replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (!words.length) return 'information';
  const lower = words.join(' ').toLowerCase();
  if (/\bbody\b|\bcontent\b|\bmessage\b/.test(lower)) return 'what you would like to say';
  if (/\bsubject\b/.test(lower)) return 'a subject line';
  if (/\brecipient\b|\bemail\b|\baddress\b/.test(lower)) return 'the recipient’s email address';
  if (PROVIDER_IDENTIFIER.test(`_${words.join('_')}_`)) return 'a human-readable link or the relevant item';
  return lower;
}

export function isProviderIdentifier(field) {
  return PROVIDER_IDENTIFIER.test(String(field || ''));
}

export function capabilityCard({ tool, schema, source = 'composio', authority = null } = {}) {
  const slug = String(tool?._composio?.slug || tool?.slug || '').trim();
  const inputSchema = schema?.input_schema || schema?.inputSchema || tool?.function?.parameters || { type: 'object', properties: {} };
  return {
    slug,
    source: source === 'core' ? 'core' : 'composio',
    toolkit: String(schema?.toolkit || tool?._composio?.toolkit || slug.split('_')[0] || '').toLowerCase(),
    authority: authority || capabilityAuthority(slug),
    description: asText(schema?.description || tool?.function?.description || slug, 800),
    schema: inputSchema,
    required: Array.isArray(inputSchema?.required) ? inputSchema.required.map(String) : [],
    fields: Object.keys(inputSchema?.properties || {}).slice(0, 48),
  };
}

export function compactCapability(card = {}) {
  return {
    slug: card.slug,
    source: card.source || 'composio',
    toolkit: card.toolkit,
    authority: card.authority,
    description: asText(card.description, 360),
    required: card.required || [],
    fields: card.fields || Object.keys(card.schema?.properties || {}).slice(0, 48),
  };
}

export function compactRecommendedPlan(steps = [], guidance = null) {
  const safeSteps = Array.isArray(steps)
    ? steps.slice(0, 12).map(step => {
      if (typeof step === 'string') return asText(step, 360);
      if (!step || typeof step !== 'object') return null;
      return Object.fromEntries(Object.entries(step).slice(0, 12).map(([key, value]) => [key, asText(value, 360)]));
    }).filter(Boolean)
    : [];
  return { steps: safeSteps, guidance: guidance == null ? null : asText(guidance, 900) };
}

export function serializeKnownFacts(facts = {}) {
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return '';
  return Object.entries(facts)
    .filter(([key, value]) => asText(key, 80) && ['string', 'number', 'boolean'].includes(typeof value) && asText(value, 120))
    .slice(0, 16)
    .map(([key, value]) => `${String(key).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 60)}:${asText(value, 120)}`)
    .join(', ')
    .slice(0, 1800);
}

export function missingRequiredFields(schema = {}, args = {}) {
  const properties = schema?.properties || {};
  return (Array.isArray(schema?.required) ? schema.required : [])
    .map(String)
    .filter(key => {
      const value = args?.[key];
      if (value === undefined || value === null) return true;
      if (typeof value === 'string' && !value.trim()) return true;
      if (Array.isArray(value) && !value.length) return true;
      return false;
    })
    .map(key => ({ field: key, schema: properties[key] || {} }));
}

function tokens(value) {
  return new Set(normalized(value).match(/[a-z0-9]{3,}/g) || []);
}

export function capabilityRelevance(card, { intent, missing = [] } = {}) {
  const wanted = new Set([
    ...tokens(intent?.discovery_query),
    ...tokens(intent?.use_case),
    ...tokens((intent?.outcomes || []).map(item => item?.description).join(' ')),
    ...missing.flatMap(item => [...tokens(item?.field), ...tokens(item?.schema?.description)]),
  ]);
  if (!wanted.size) return 0;
  return [...tokens(`${card.slug} ${card.description} ${(card.fields || []).join(' ')}`)]
    .filter(token => wanted.has(token)).length;
}

export function eligibleReadCapabilities(state = {}, missing = []) {
  const failed = new Set((state.receipts || []).filter(row => row?.successful === false).map(row => String(row.slug)));
  return (state.capabilities || [])
    .filter(card => card?.authority === 'read' && !failed.has(card.slug))
    .map(card => ({ card, relevance: capabilityRelevance(card, { intent: state.intent, missing }) }))
    .sort((left, right) => right.relevance - left.relevance);
}

export function outcomeIds(state = {}) {
  const covered = new Set((state.receipts || []).filter(row => row?.successful && Array.isArray(row.outcome_ids))
    .flatMap(row => row.outcome_ids));
  return (state.intent?.outcomes || []).filter(outcome => !covered.has(outcome.id)).map(outcome => outcome.id);
}

export function outcomesCovered(state = {}) {
  const unresolved = outcomeIds(state);
  return Array.isArray(state.intent?.outcomes) && state.intent.outcomes.length > 0 && !unresolved.length;
}

export function normalizePlanCandidate(value = {}) {
  const action = GOVERNED_ACTIONS.includes(value?.action) ? value.action : null;
  return {
    action,
    tool_slug: asText(value?.tool_slug || value?.slug, 160) || null,
    purpose: ['outcome', 'prerequisite'].includes(value?.purpose) ? value.purpose : null,
    outcome_ids: Array.isArray(value?.outcome_ids) ? value.outcome_ids.map(String).slice(0, 12) : [],
    query: asText(value?.query, 800) || null,
    question: asText(value?.question, 600) || null,
    reason: asText(value?.reason, 700) || null,
  };
}

/**
 * Deterministic admission guard between planner output and the graph.  It does
 * not select an application-specific tool; it only admits a proposal that is
 * available, authorized, and supported by the current evidence state.
 */
export function verifyPlanCandidate(state = {}, candidate = {}) {
  const plan = normalizePlanCandidate(candidate);
  const unresolved = outcomeIds(state);
  const cards = state.capabilities || [];
  const selected = cards.find(card => card.slug === plan.tool_slug) || null;
  const discoveryAttempts = Number(state.discoveryAttempts || 0);
  const availableReads = eligibleReadCapabilities(state);

  if (!plan.action) return { ok: false, code: 'invalid_action', repair: 'Return one supported action.' };
  if (plan.action === 'done') {
    if (outcomesCovered(state) || state.capabilityGap) return { ok: true, plan: { ...plan, outcome_ids: unresolved } };
    return { ok: false, code: 'premature_done', repair: 'Unresolved outcomes remain. Select an admissible read, dependency search, or clarification.' };
  }
  if (plan.action === 'discover' || plan.action === 'resolve_dependency') {
    const query = asText(plan.query, 800);
    const prior = new Set((state.searchQueries || []).map(normalized));
    if (!query) return { ok: false, code: 'search_query_missing', repair: 'Provide a concise materially different discovery query.' };
    if (prior.has(normalized(query))) return { ok: false, code: 'duplicate_discovery', repair: 'The discovery query repeats a prior search. Refine for an upstream capability.' };
    if (discoveryAttempts >= 3) return { ok: false, code: 'discovery_budget_exhausted', capabilityGap: true,
      repair: 'Discovery budget is exhausted. Ask only for a human-readable business fact or state the capability gap.' };
    return { ok: true, plan: { ...plan, action: 'discover', query, outcome_ids: [] } };
  }
  if (plan.action === 'read') {
    if (!selected) return { ok: false, code: 'tool_not_discovered', repair: 'Select only a discovered read capability.' };
    if (selected.authority !== 'read') return { ok: false, code: 'read_authority_denied', repair: 'A read action requires a discovered read capability.' };
    const failed = (state.receipts || []).some(row => row?.slug === selected.slug && row?.successful === false);
    if (failed) return { ok: false, code: 'failed_tool_repeat', repair: 'Do not retry the failed tool with unchanged facts; discover a materially different capability.' };
    const purpose = plan.purpose || 'outcome';
    const outcomeIds = purpose === 'prerequisite' ? [] : (plan.outcome_ids.length ? plan.outcome_ids : unresolved);
    const invalidOutcome = outcomeIds.find(id => state.intent?.outcomes?.find(outcome => outcome.id === id)?.kind === 'draft');
    if (invalidOutcome) return { ok: false, code: 'read_cannot_complete_draft', repair: 'A read can supply evidence only. Keep draft outcomes unresolved until a governed draft is created.' };
    return { ok: true, plan: { ...plan, purpose, outcome_ids: outcomeIds } };
  }
  if (plan.action === 'draft') {
    if (!selected) return { ok: false, code: 'tool_not_discovered', repair: 'Select only a discovered mutation capability.' };
    if (selected.authority !== 'write') return { ok: false, code: 'write_authority_denied', repair: 'A draft action requires a discovered write capability.' };
    if (selected.source === 'core') return { ok: false, code: 'core_write_not_supported', repair: 'Core capabilities are read-only in this governed graph. Select an external mutation capability.' };
    const outcomeIds = plan.outcome_ids.length ? plan.outcome_ids : unresolved;
    const invalidOutcome = outcomeIds.find(id => state.intent?.outcomes?.find(outcome => outcome.id === id)?.kind !== 'draft');
    if (invalidOutcome) return { ok: false, code: 'draft_cannot_complete_read', repair: 'A draft may only complete a requested mutation outcome.' };
    return { ok: true, plan: { ...plan, purpose: 'outcome', outcome_ids: outcomeIds } };
  }
  if (plan.action === 'ask') {
    if (discoveryAttempts < 2 && availableReads.some(item => item.relevance > 0)) {
      return { ok: false, code: 'premature_clarification', repair: 'A relevant connected read remains. Resolve factual evidence before asking the user.' };
    }
    if (!plan.question) return { ok: false, code: 'question_missing', repair: 'Ask one concise business-language question.' };
    return { ok: true, plan: { ...plan, outcome_ids: [] } };
  }
  return { ok: false, code: 'unhandled_action', repair: 'Return a supported action.' };
}

export function capabilityGapQuestion(missing = []) {
  if ((missing || []).some(item => isProviderIdentifier(item.field))) {
    return 'The connected integration does not expose a way to resolve this item automatically. Please share a human-readable link or paste the relevant content.';
  }
  const labels = [...new Set((missing || []).map(item => humanizeField(item.field)).filter(Boolean))].slice(0, 3);
  return labels.length ? `What should I use for ${labels.join(' and ')}?` : 'What business information should I use?';
}

export function safeReceiptSummary(data) {
  if (data == null) return 'No data returned';
  if (typeof data === 'string') return asText(data, 220);
  const candidate = data?.name || data?.title || data?.subject || data?.snippet || data?.message || data?.data?.name;
  return candidate ? asText(candidate, 220) : 'Provider operation completed';
}

export function compactReceipt(row = {}) {
  return {
    slug: row.slug,
    successful: row.successful === true,
    outcome_ids: Array.isArray(row.outcome_ids) ? row.outcome_ids : [],
    summary: row.summary || safeReceiptSummary(row.data),
    error_code: row.error_code || null,
    draft_id: row.draft_id || null,
  };
}

/**
 * The durable ledger deliberately stores only a redacted receipt projection.
 * A synthesis invocation is different: it runs inside the authenticated turn
 * and must receive the bounded evidence that the connector successfully
 * returned. Reusing `compactReceipt` here made successful reads impossible to
 * answer from, because the final model could see that a tool ran but none of
 * its results. Keep this projection generic and connector-agnostic.
 */
export function synthesisReceipt(row = {}) {
  return {
    ...compactReceipt(row),
    data: row?.successful === true && row.data !== undefined ? row.data : null,
  };
}
