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

export function formatKnownFields({ recipient } = {}) {
  if (!recipient) return '';
  return `recipient_name:${compact(recipient, 60)}`;
}

export function formatUseCase({ message, destinationApps = [] } = {}) {
  const raw = compact(message, 800);
  const apps = destinationAppsList(destinationApps);
  const app = apps[0] || '';
  if (/find a person email address|email address of a person/i.test(raw)) {
    return app ? `find a person email address in ${app} contacts` : 'find a person email address in contacts';
  }
  if (isReadLookupUseCase(raw)) {
    return (app ? `look up existing ${app} records for: ${raw}` : `look up existing records for: ${raw}`).slice(0, 1024);
  }
  if (namedRecipient(raw) || isWriteIntentMessage(raw)) {
    return (app ? `prepare a message in ${app} for: ${raw}` : `prepare a message for: ${raw}`).slice(0, 1024);
  }
  return (app ? `use ${app} for: ${raw}` : raw).slice(0, 1024);
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
} = {}) {
  const recipient = namedRecipient(message);
  const workflowId = String(sessionId || '').trim();
  const session = (!generateId && workflowId && !isToolRouterSessionId(workflowId))
    ? { id: workflowId }
    : { generate_id: true };
  return {
    queries: [{
      use_case: formatUseCase({ message, destinationApps }),
      known_fields: formatKnownFields({ recipient, destinationApps, message }),
    }],
    session,
    model: model || process.env.COMPOSIO_SESSION_SEARCH_MODEL || 'gemini-2.5-flash-lite',
    search_strategy: searchStrategy === 'tool_search' ? 'tool_search' : 'auto',
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
