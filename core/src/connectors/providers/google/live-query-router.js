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
  { pattern: /\b(meeting|event|schedule|calendar|appointment|availability)\b/i, services: ['google_calendar'] },
  // Drive intents
  { pattern: /\b(file|document|drive|folder|sharing|attachment)\b/i, services: ['google_drive', 'google_docs'] },
  // Tasks intents
  { pattern: /\b(task|todo|to-do|action\s+item|pending)\b/i, services: ['google_tasks'] },
  // Contact intents
  { pattern: /\b(contact|email\s+address|phone|who\s+is)\b/i, services: ['google_contacts'] },
];

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
    argsBuilder: (q) => ({ query: q || 'mimeType!=\'application/vnd.google-apps.folder\'', page_size: 10 }),
  },
  google_docs: {
    tool: 'search_drive_files',
    argsBuilder: (q) => ({
      query: q ? `name contains '${q.replace(/'/g, '')}' and mimeType='application/vnd.google-apps.document'`
                : "mimeType='application/vnd.google-apps.document'",
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
    const rows = await this.prisma.platformIntegration.findMany({
      where: {
        userId,
        platformType: { in: candidates },
        isActive: true,
        syncStatus: { not: 'revoked' },
      },
      select: { platformType: true },
    });
    return rows.map(r => r.platformType);
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
        if (!config) return { service, items: [] };
        try {
          const args = config.argsBuilder(query);
          const result = await this.bridge.callTool(userId, config.tool, args);
          return { service, tool: config.tool, items: this._parseToolResult(result, service) };
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
