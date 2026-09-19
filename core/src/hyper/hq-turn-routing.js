const HQ_KIND_KEYWORDS = [
  ['outreach', ['outreach', 'cold email', 'prospect', 'lead gen', 'leads', 'sales call', 'book meeting', 'reach out', 'sales sheet', 'campaign']],
  ['research', ['competitor', 'market research', 'landscape', 'icp', 'market size', 'segment', 'industry trend', 'analyze market', 'research']],
  ['content', ['content', 'blog', 'social', 'post', 'newsletter', 'seo', 'copy', 'article', 'brand']],
  ['strategy', ['strategy', 'roadmap', 'prioriti', 'decision', 'invest', 'pivot', 'pricing', 'business model', 'go-to-market', 'gtm']],
];

const DIRECT_CHAT_RE = /^(?:hi|hello|hey|hallo|guten\s+(?:morgen|tag|abend)|thanks|thank\s+you|danke|who\s+are\s+you|what\s+can\s+you\s+do)[!.?\s]*$/i;
const FOCUSED_WORK_RE = /\b(?:find|design|create|build|write|draft|prepare|research|analyse|analyze|generate|plan|make|produce|reach\s+out|send|compose|map|identify)\b/i;
const OPERATING_WORK_RE = /\b(?:launch|run|start|set\s+up|execute|operate|schedule|monitor|full|complete|comprehensive|multi[-\s]?channel|end[-\s]?to[-\s]?end|operating\s+program|broad\s+audit)\b/i;

export function classifyHqKind(message) {
  const hay = String(message || '').toLowerCase();
  for (const [kind, words] of HQ_KIND_KEYWORDS) {
    if (words.some((word) => hay.includes(word))) return kind;
  }
  return null;
}

export function classifyHqResponseDepth(message) {
  const text = String(message || '').trim();
  if (!text || /^\s*@[A-Za-z0-9_-]{2,32}\b/.test(text)) return 'direct';
  if (DIRECT_CHAT_RE.test(text)) return 'direct';
  if (OPERATING_WORK_RE.test(text)) return 'operating';
  if (FOCUSED_WORK_RE.test(text)) return 'focused';
  return 'direct';
}

export function resolveHqTurnRoute(message) {
  const responseDepth = classifyHqResponseDepth(message);
  const kind = classifyHqKind(message);
  return {
    kind,
    responseDepth,
    dispatch: Boolean(kind && (responseDepth === 'focused' || responseDepth === 'operating')),
  };
}

