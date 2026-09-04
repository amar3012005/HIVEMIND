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

export function isReadLookupUseCase(message) {
  const text = String(message || '');
  if (/\b(send|email|mail to|draft|publish|create|post this|share this|write a|reply to)\b/i.test(text)) return false;
  return /\b(what|think|last|show|get|read|about my|did i|have i|was my|latest|recent|list)\b/i.test(text);
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
  const recipient = namedRecipient(raw);
  const apps = destinationAppsList(destinationApps);
  const app = apps[0] || '';
  if (recipient && /\b(company|hivemind|singulance)\b/i.test(raw)) {
    return 'send an email with company information';
  }
  if (/email address of a person|find the email/i.test(raw)) {
    return 'find a person email address in gmail contacts';
  }
  if (isReadLookupUseCase(raw)) {
    if (/\b(post|posts)\b/i.test(raw) || app === 'linkedin') {
      return `list the authenticated user's latest ${app || 'linkedin'} posts`;
    }
    if (app === 'gmail' || /\b(email|emails|inbox|mail)\b/i.test(raw)) {
      return "fetch the authenticated user's latest gmail emails";
    }
    if (app === 'youtube' || /\b(watch|video|history)\b/i.test(raw)) {
      return "list the authenticated user's latest youtube watch history";
    }
    if (app === 'github' || /\b(repo|repos|repository)\b/i.test(raw)) {
      return "list the authenticated user's github repositories";
    }
    return app
      ? `retrieve the authenticated user's latest ${app} records`
      : compact(raw, 400);
  }
  if (recipient) return app && app !== 'gmail' ? `send a message via ${app}` : 'send an email to someone';
  if (app) return `use ${app} for the requested action`;
  return compact(raw, 400);
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
