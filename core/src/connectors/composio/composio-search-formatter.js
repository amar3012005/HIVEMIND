/**
 * Small, deterministic input contract for COMPOSIO_SEARCH_TOOLS.
 *
 * This deliberately carries facts already known by the planner instead of
 * sending the provider a raw chat transcript.  It is data only: it cannot
 * select or execute a tool.
 */
function compact(value, limit = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function namedRecipient(message) {
  const match = compact(message).match(/\b(?:to|send|reply to|email)\s+([A-Za-z][A-Za-z0-9._-]{1,40})\b/i);
  return match?.[1] || null;
}

export function formatComposioSearch({ message, sessionId, destinationApps = [], model } = {}) {
  const useCase = compact(message, 1_500);
  const recipient = namedRecipient(useCase);
  const known_fields = {
    product_context: 'HIVEMIND is the company brain. Native memory and profile tools execute locally; Composio is only for connected app capabilities.',
    ...(recipient ? { recipient_name: recipient } : {}),
    ...(destinationApps.length ? { destination_apps: [...new Set(destinationApps.map((app) => compact(app, 60).toLowerCase()).filter(Boolean))] } : {}),
  };
  return {
    queries: [{
      use_case: useCase,
      known_fields,
      search_strategy: 'auto',
      ...(destinationApps.length === 1 ? { destination_app: known_fields.destination_apps[0] } : {}),
    }],
    session: { id: sessionId, generate_id: sessionId },
    model: model || process.env.COMPOSIO_SESSION_SEARCH_MODEL || 'openai/gpt-oss-20b',
  };
}
