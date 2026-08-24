export const CREDIT_COSTS = Object.freeze({
  chat_turn: { credits: 2, unit: 'turn', label: 'BRAIN chat' },
  composio_tool_call: { credits: 2, unit: 'tool call', label: 'Connected-app action' },
  knowledge_page_evidence: { credits: 1, unit: 'page', label: 'Evidence-only page' },
  knowledge_page_both: { credits: 2, unit: 'page', label: 'Memory + evidence page' },
  meeting_minute: { credits: 6, unit: 'minute', label: 'AI Meeting Notes' },
  hyperagent_turn: { credits: 25, unit: 'turn', label: 'HyperAgent turn' },
});

export function creditCost(service, units = 1) {
  const item = CREDIT_COSTS[service];
  if (!item) throw new Error(`unknown credit service: ${service}`);
  return Math.max(0, Math.ceil(Number(units) || 0)) * item.credits;
}

export function publicCreditCatalog() {
  return Object.fromEntries(Object.entries(CREDIT_COSTS).map(([key, value]) => [key, { ...value }]));
}
