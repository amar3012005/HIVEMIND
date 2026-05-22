/**
 * Google Workspace live-query router.
 *
 * Pattern: HIVEMIND's retrieve() returns memory-backed results. For queries
 * where memory is stale, sparse, or has temporal markers ("today", "this week",
 * "latest"), this router calls workspace-mcp tools LIVE and merges results.
 *
 * Avoids pre-ingesting every Drive file, every Calendar event, every chat
 * message. Pollution-free recall.
 */

import { WorkspaceMcpBridge } from './workspace-mcp-bridge.js';

// Patterns that suggest user wants fresh data, not cached memory
const FRESH_QUERY_PATTERNS = [
  /\b(today|now|latest|recent|this\s+(?:week|month|morning|afternoon))\b/i,
  /\b(yesterday|tomorrow|upcoming)\b/i,
  /\b(currently|right\s+now|at\s+the\s+moment)\b/i,
];

const QUERY_INTENT_PATTERNS = [
  // Calendar intents
  { pattern: /\b(meeting|event|events|schedule|calendar|appointment|availability|booked|busy)\b/i, services: ['google_calendar'] },
  // Drive / Docs intents — match singular AND plural variants
  { pattern: /\b(file|files|document|documents|doc|docs|drive|folder|folders|sharing|attachment|spreadsheet|sheet|sheets|slide|slides|presentation)\b/i, services: ['google_drive', 'google_docs'] },
  // Tasks intents
  { pattern: /\b(task|tasks|todo|todos|to-do|action\s+item|pending)\b/i, services: ['google_tasks'] },
  // Gmail intents — last/recent/unread email, inbox, message, reply, sender
  { pattern: /\b(email|emails|e-mail|gmail|inbox|mail|message\s+from|reply|replied|sender|subject\s+line)\b/i, services: ['gmail'] },
  // Contact intents
  { pattern: /\b(contact|contacts|email\s+address|phone|who\s+is)\b/i, services: ['google_contacts'] },
];

// Drive's query syntax is structured (not natural language).
// Extract keywords from user message, strip intent words, wrap in
// `name contains '<kw>' OR fullText contains '<kw>'`.
const STOP_WORDS = new Set([
  'a','an','the','my','our','your','find','search','show','give','get',
  'me','for','about','from','on','in','at','of','to','with','any','all',
  'document','documents','doc','docs','file','files','drive','google',
  'last','recent','latest','today','now','please','can','could','would',
  'is','are','was','were','have','has','had','do','does','did',
]);
function extractKeywords(query) {
  if (!query) return [];
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w))
    .slice(0, 4); // first 4 most-likely-meaningful terms
}
function buildDriveQuery(q) {
  const kws = extractKeywords(q);
  if (kws.length === 0) {
    return "trashed=false and mimeType!='application/vnd.google-apps.folder'";
  }
  const clauses = kws.map(kw => `(name contains '${kw}' or fullText contains '${kw}')`);
  return `(${clauses.join(' or ')}) and trashed=false`;
}

// Tool names match taylorwilsdon/google_workspace_mcp v3.2.4 surface.
// Verified live against prod sidecar.
const SERVICE_TOOL_MAP = {
  google_calendar: {
    tool: 'get_events',
    argsBuilder: (q) => {
      const now = new Date();
      const past = new Date(now.getTime() - 7 * 86400000);
      const future = new Date(now.getTime() + 30 * 86400000);
      return {
        calendar_id: 'primary',
        time_min: past.toISOString(),
        time_max: future.toISOString(),
        max_results: 10,
      };
    },
  },
  google_drive: {
    tool: 'search_drive_files',
    argsBuilder: (q) => ({ query: buildDriveQuery(q), page_size: 10 }),
  },
  google_docs: {
    tool: 'search_drive_files',
    argsBuilder: (q) => ({
      query: `${buildDriveQuery(q)} and mimeType='application/vnd.google-apps.document'`,
      page_size: 10,
    }),
  },
  google_tasks:    { tool: 'list_tasks',            argsBuilder: () => ({ max_results: 20 }) },
  google_contacts: { tool: 'search_contacts',       argsBuilder: (q) => ({ query: q, page_size: 10 }) },
  google_chat:     { tool: 'list_spaces',           argsBuilder: () => ({ page_size: 20 }) },
  gmail:           { tool: 'search_gmail_messages', argsBuilder: (q) => ({ query: q, page_size: 10 }) },
};

export class LiveQueryRouter {
  constructor({ prisma, decryptToken, refreshOAuthToken, mcpUrl }) {
    this.bridge = new WorkspaceMcpBridge({ prisma, decryptToken, refreshOAuthToken, mcpUrl });
    this.prisma = prisma;
  }

  /**
   * Decide whether a query needs live data and which services to hit.
   * Returns { needsLive, services[], reason }.
   */
  classify(query, memoryResults = []) {
    const hasFreshMarker = FRESH_QUERY_PATTERNS.some(p => p.test(query));
    const lowRecall = memoryResults.length < 3;
    const lowConfidence = memoryResults.length > 0 && memoryResults[0]?.score < 0.6;

    const intentServices = QUERY_INTENT_PATTERNS
      .filter(({ pattern }) => pattern.test(query))
      .flatMap(({ services }) => services);
    const uniqueServices = [...new Set(intentServices)];

    if (!hasFreshMarker && !lowRecall && !lowConfidence && uniqueServices.length === 0) {
      return { needsLive: false, services: [], reason: 'memory sufficient' };
    }

    return {
      needsLive: true,
      services: uniqueServices.length > 0 ? uniqueServices : ['google_drive', 'google_calendar', 'gmail'],
      reason: hasFreshMarker ? 'fresh marker' : lowRecall ? 'low recall' : lowConfidence ? 'low confidence' : 'intent match',
    };
  }

  /**
   * Check which services are actually connected for this user.
   * Skips services the user hasn't granted access to.
   */
  async getConnectedServices(userId, candidates) {
    // First try per-service rows
    const rows = await this.prisma.platformIntegration.findMany({
      where: {
        userId,
        platformType: { in: candidates },
        isActive: true,
        syncStatus: { not: 'revoked' },
      },
      select: { platformType: true },
    });
    const found = rows.map(r => r.platformType);
    if (found.length > 0) return found;

    // Fallback: legacy single-row scheme — check if user has a gmail row
    // with scopes covering the requested service. The OAuth callback didn't
    // always split per-service for older connections.
    const SERVICE_TO_SCOPES = {
      google_calendar: ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar'],
      google_drive:    ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive'],
      google_docs:     ['https://www.googleapis.com/auth/documents.readonly', 'https://www.googleapis.com/auth/documents'],
      google_sheets:   ['https://www.googleapis.com/auth/spreadsheets.readonly', 'https://www.googleapis.com/auth/spreadsheets'],
      google_slides:   ['https://www.googleapis.com/auth/presentations.readonly', 'https://www.googleapis.com/auth/presentations'],
      google_contacts: ['https://www.googleapis.com/auth/contacts.readonly', 'https://www.googleapis.com/auth/contacts'],
      google_chat:     ['https://www.googleapis.com/auth/chat.messages.readonly'],
      google_tasks:    ['https://www.googleapis.com/auth/tasks.readonly', 'https://www.googleapis.com/auth/tasks'],
      gmail:           ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.modify'],
    };

    // Don't filter by isActive here — sync errors can flip it false even
    // when token is still valid. syncStatus != revoked is the truer signal.
    const gmailRow = await this.prisma.platformIntegration.findFirst({
      where: { userId, platformType: 'gmail', syncStatus: { not: 'revoked' } },
      select: { oauthScopes: true },
    });
    if (!gmailRow) return [];
    const scopes = gmailRow.oauthScopes || [];
    return candidates.filter(svc => {
      const requiredScopes = SERVICE_TO_SCOPES[svc] || [];
      return requiredScopes.some(rs => scopes.includes(rs));
    });
  }

  /**
   * Fire live queries in parallel for the given services.
   * Returns flat list of result items with provenance.
   */
  async fetch(userId, query, services) {
    const connected = await this.getConnectedServices(userId, services);
    if (connected.length === 0) return [];

    const results = await Promise.allSettled(
      connected.map(async (service) => {
        const config = SERVICE_TOOL_MAP[service];
        if (!config) {
          console.warn(`[live-query] no config for service ${service}`);
          return { service, items: [] };
        }
        try {
          const args = config.argsBuilder(query);
          const result = await this.bridge.callTool(userId, config.tool, args);
          const items = this._parseToolResult(result, service);
          console.log(`[live-query] ${service}/${config.tool} → ${items.length} items (raw content present: ${!!result?.content})`);
          return { service, tool: config.tool, items };
        } catch (err) {
          console.warn(`[live-query] ${service}/${config.tool} failed: ${err.message}`);
          return { service, items: [], error: err.message };
        }
      })
    );

    return results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => (r.value.items || []).map(item => ({
        ...item,
        _source: r.value.service,
        _tool: r.value.tool,
        _live: true,
      })));
  }

  /**
   * Convert workspace-mcp tool result to a generic item list.
   * Tool results from FastMCP wrap text in content[0].text — usually JSON.
   */
  _parseToolResult(result, service) {
    if (!result?.content?.length) return [];
    const text = result.content[0]?.text || '';

    // Try JSON parse first
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed.results)) return parsed.results;
      if (Array.isArray(parsed.messages)) return parsed.messages;
      if (Array.isArray(parsed.items)) return parsed.items;
      if (Array.isArray(parsed.events)) return parsed.events;
      if (Array.isArray(parsed.files)) return parsed.files;
      return [parsed];
    } catch (_e) {
      // Fall back: return raw text wrapped
      return [{ text, _service: service }];
    }
  }
}

export const LIVE_QUERY_TUNING = { FRESH_QUERY_PATTERNS, QUERY_INTENT_PATTERNS, SERVICE_TOOL_MAP };
