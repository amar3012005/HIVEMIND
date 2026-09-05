/**
 * Legal COMPOSIO_SEARCH_TOOLS argument contract (Composio v3 meta-tool).
 *
 * queries[] additionalProperties: false — only `use_case` + `known_fields`.
 * `known_fields` is a "k:v" string, never an object.
 * `search_strategy` is top-level (`auto`, then `tool_search` on retry).
 * `session.generate_id` is boolean true on first search; later calls use the
 * workflow *word* returned by Composio, never a Tool Router `trs_*` id.
 */
function compact(value, limit = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

const RECIPIENT_STOP = new Set([
  'me', 'him', 'her', 'them', 'us', 'the', 'a', 'an', 'my', 'this', 'that', 'about',
  'send', 'share', 'draft', 'mail', 'email', 'gmail', 'person', 'people', 'user',
  'company', 'information', 'info', 'called',
]);

export function namedRecipient(message) {
  const text = compact(message);
  const called = text.match(/\bcalled\s+([A-Za-z][A-Za-z0-9._-]{1,40})\b/i);
  if (called?.[1] && !RECIPIENT_STOP.has(called[1].toLowerCase())) return called[1];
  const match = text.match(/\b(?:to|send|reply to|email)\s+([A-Za-z][A-Za-z0-9._-]{1,40})\b/i);
  if (match?.[1] && !RECIPIENT_STOP.has(match[1].toLowerCase())) return match[1];
  return null;
}

export function isWriteIntentMessage(message) {
  const text = String(message || '');
  if (/\b(send|draft|publish|create|share this|write a|reply to|forward this|mail to)\b/i.test(text)) return true;
  if (/\bsend\b/i.test(text) && /\b(e-?mails?|mail|gmail|message)\b/i.test(text)) return true;
  return false;
}

export function isReadLookupUseCase(message) {
  if (isWriteIntentMessage(message)) return false;
  return /\b(what|think|last|latest|show|get|read|about my|did i|have i|was my|recent|list|e-?mails?|inbox)\b/i.test(String(message || ''));
}

function destinationAppsList(destinationApps = []) {
  return [...new Set((destinationApps || [])
    .map((item) => String(item || '').toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter((item) => item && item !== 'hivemind' && item !== 'local' && item !== 'composio'))];
}

export const SEARCH_INTENT_SYSTEM = `Turn one user request into one COMPOSIO_SEARCH_TOOLS query.
Return JSON only: {"kind":"lookup"|"compose","use_case":"","known_fields":""}
Rules:
- Understand the request in any language.
- use_case: one English sentence. Name the app if the user named one. Describe the action and outcome. Do not include people's names, emails, phone numbers, or ids. Never name tool slugs.
- known_fields: comma-separated key:value identifiers only (example recipient_name:Ada). Empty string if none.
- kind=lookup if they want to see existing data. kind=compose if they want to send, create, post, reply, or change something.
- Never invent an app.`;

export function formatKnownFields({ recipient, knownFields } = {}) {
  if (typeof knownFields === 'string' && knownFields.trim()) return compact(knownFields, 240);
  if (!recipient) return '';
  return `recipient_name:${compact(recipient, 60)}`;
}

export function formatUseCase({ message, destinationApps = [], kind } = {}) {
  const raw = compact(message, 800);
  const apps = destinationAppsList(destinationApps);
  const app = apps[0] || '';
  const lookup = kind === 'lookup' || (!kind && isReadLookupUseCase(raw));
  if (lookup) {
    return (app ? `look up existing ${app} records for: ${raw}` : `look up existing records for: ${raw}`).slice(0, 1024);
  }
  if (kind === 'compose' || namedRecipient(raw) || isWriteIntentMessage(raw)) {
    return (app ? `prepare a message in ${app} for: ${raw}` : `prepare a message for: ${raw}`).slice(0, 1024);
  }
  return (app ? `use ${app} for: ${raw}` : raw).slice(0, 1024);
}

function parseIntent(raw, { message, destinationApps } = {}) {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  let parsed = obj;
  if (!parsed) {
    const text = String(raw || '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { parsed = null; }
    }
  }
  const kind = parsed?.kind === 'compose' || parsed?.kind === 'lookup'
    ? parsed.kind
    : (isWriteIntentMessage(message) ? 'compose' : (isReadLookupUseCase(message) ? 'lookup' : 'lookup'));
  const useCase = compact(parsed?.use_case, 1024);
  const known = typeof parsed?.known_fields === 'string' ? compact(parsed.known_fields, 240) : '';
  return {
    kind,
    use_case: useCase || formatUseCase({ message, destinationApps, kind }),
    known_fields: known || formatKnownFields({ recipient: namedRecipient(message) }),
  };
}

export function fallbackSearchIntent({ message, destinationApps = [] } = {}) {
  const kind = isWriteIntentMessage(message) ? 'compose' : 'lookup';
  return {
    kind,
    use_case: formatUseCase({ message, destinationApps, kind }),
    known_fields: formatKnownFields({ recipient: namedRecipient(message) }),
  };
}

export async function normalizeSearchIntent({ message, destinationApps = [], generateImpl } = {}) {
  if (typeof generateImpl === 'function') {
    try {
      const raw = await generateImpl({ message, destinationApps });
      return parseIntent(raw, { message, destinationApps });
    } catch { /* fallback */ }
  }
  const inNodeTest = Boolean(process.env.NODE_TEST_CONTEXT);
  if (!inNodeTest && process.env.DURABLE_SEARCH_INTENT_LLM !== 'false') {
    try {
      const { chatCompletionFetch, DEFAULT_CHAT_PLANNER_MODEL } = await import('../../llm/chat-provider.js');
      const model = process.env.DURABLE_NEXT_ACTION_MODEL || DEFAULT_CHAT_PLANNER_MODEL;
      const apps = destinationAppsList(destinationApps).join(', ');
      const response = await chatCompletionFetch(model, {
        body: JSON.stringify({
          temperature: 0,
          max_tokens: 180,
          messages: [
            { role: 'system', content: SEARCH_INTENT_SYSTEM },
            { role: 'user', content: `Apps in scope: ${apps || '(none named)'}\nRequest:\n${String(message || '').slice(0, 800)}` },
          ],
        }),
      }, { useCase: 'chat_planner' });
      const payload = await response.json();
      return parseIntent(payload?.choices?.[0]?.message?.content, { message, destinationApps });
    } catch { /* fallback */ }
  }
  return fallbackSearchIntent({ message, destinationApps });
}

export function isToolRouterSessionId(value) {
  return /^trs_/i.test(String(value || '').trim());
}

export function formatComposioSearch({
  message,
  sessionId,
  destinationApps = [],
  model,
  generateId = true,
  searchStrategy = 'auto',
  intent = null,
} = {}) {
  const resolved = intent && intent.use_case
    ? {
      kind: intent.kind === 'compose' ? 'compose' : 'lookup',
      use_case: compact(intent.use_case, 1024),
      known_fields: formatKnownFields({
        recipient: namedRecipient(message),
        knownFields: intent.known_fields,
      }),
    }
    : fallbackSearchIntent({ message, destinationApps });
  const workflowId = String(sessionId || '').trim();
  const session = (!generateId && workflowId && !isToolRouterSessionId(workflowId))
    ? { id: workflowId }
    : { generate_id: true };
  const strategy = searchStrategy === 'tool_search' || resolved.kind === 'lookup'
    ? 'tool_search'
    : 'auto';
  return {
    queries: [{
      use_case: resolved.use_case,
      known_fields: resolved.known_fields,
    }],
    session,
    model: model || process.env.COMPOSIO_SESSION_SEARCH_MODEL || 'gemini-2.5-flash-lite',
    search_strategy: strategy,
  };
}

export function extractWorkflowSessionId(searched) {
  const id = searched?.data?.session?.id
    || searched?.data?.session_id
    || searched?.session?.id
    || searched?.data?.results?.[0]?.session_id
    || null;
  if (!id) return null;
  const value = String(id).trim();
  if (!value || isToolRouterSessionId(value)) return null;
  return value;
}
