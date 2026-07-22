/**
 * Toolkit factory — builds a per-request Toolkit instance with:
 *   - HIVEMIND base tools (from tool-registry.js) registered as 'basic' group
 *   - Connector MCP tools (slack/notion/github/linear) as inactive groups
 *     resolved via McpClientPool when a Nango connection exists for the user
 *   - Middleware: draft-approval (write tools) + memory-tap (read tools)
 *
 * One toolkit per chat turn. Cheap to build (~5ms). Pool/clients reused
 * across turns via McpClientPool cache.
 */

import { Toolkit, registerMetaTool } from './toolkit.js';
import { McpClientPool } from './mcp-client-pool.js';
import { createDraftApprovalMiddleware } from './middleware/draft-approval.js';
import { createMemoryTapMiddleware } from './middleware/memory-tap.js';
import { registerGmailTools } from './connector-toolkits/gmail-tools.js';
import { registerGdocsTools } from './connector-toolkits/gdocs-tools.js';
import { registerGeminiTools } from './connector-toolkits/gemini-tools.js';
import { registerSlackTools } from './connector-toolkits/slack-tools.js';
import { getHivemindToolCatalog, registerHivemindTools } from './connector-toolkits/hivemind-tools.js';

// MCP-backed groups (run via persistent client pool).
// 'slack' moved OUT of this list: Slack OAuth is native (PlatformIntegration
// bot token) — the Nango-backed MCP pool failed token resolution on every
// chat turn for natively-connected users. Slack tools are now registered as
// a native group (registerSlackTools) below.
const MCP_CONNECTOR_GROUPS = ['notion', 'github', 'linear'];

// Nango-REST-backed groups (registered directly via tool functions).
// Each entry: providerKey expected on nangoConnection, register function.
// provider = Nango unique_key (matches _nango_configs.unique_key)
const NANGO_REST_GROUPS = [
  { provider: 'gmail', groupName: 'gmail', register: (tk) => registerGmailTools(tk) },
  { provider: 'google-docs', groupName: 'google-docs', register: (tk) => registerGdocsTools(tk) },
  { provider: 'google-gemini', groupName: 'google-gemini', register: (tk, deps) => registerGeminiTools(tk, deps) },
];

const CONNECTOR_CAPABILITIES = {
  gmail: { description: 'Gmail search, thread reading, sending and labels.', tools: ['gmail_search_threads', 'gmail_read_thread', 'gmail_send_email', 'gmail_label_thread'] },
  'google-docs': { description: 'Google Docs search, reading and document creation.', tools: ['gdocs_search', 'gdocs_read', 'gdocs_create'] },
  'google-gemini': { description: 'Google Gemini connected application capabilities.', tools: ['gemini_generate'] },
  slack: { description: 'Slack search, channels, history, threads and posting.', tools: ['slack_search_messages', 'slack_list_channels', 'slack_channel_history', 'slack_read_thread', 'slack_post_message'] },
  notion: { description: 'Notion workspace read and write tools through MCP.', tools: ['notion MCP tools'] },
  github: { description: 'GitHub repository read and write tools through MCP.', tools: ['GitHub MCP tools'] },
  linear: { description: 'Linear issue and project tools through MCP.', tools: ['Linear MCP tools'] },
};
const CONNECTOR_WRITE_TOOLS = new Set(['gmail_send_email', 'gmail_label_thread', 'gdocs_create', 'slack_post_message']);

const capabilityCache = new Map();
export async function getCapabilityCatalogForUser({ prisma, userId, orgId }) {
  const key = `${userId}:${orgId}`;
  const cached = capabilityCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.catalog;
  const enabled = new Set();
  if (prisma?.nangoConnection) {
    const rows = await prisma.nangoConnection.findMany({
      where: { userId, orgId, status: 'active' }, select: { providerKey: true },
    }).catch(() => []);
    for (const row of rows) enabled.add(row.providerKey);
  }
  if (prisma?.platformIntegration) {
    const slack = await prisma.platformIntegration.findUnique({
      where: { userId_platformType: { userId, platformType: 'slack' } }, select: { isActive: true },
    }).catch(() => null);
    if (slack?.isActive) enabled.add('slack');
  }
  const connectorCatalog = [...enabled].map((name) => CONNECTOR_CAPABILITIES[name] ? ({
    name, description: CONNECTOR_CAPABILITIES[name].description,
    tools: CONNECTOR_CAPABILITIES[name].tools.map((tool) => ({ name: tool, description: `Server-owned ${name} capability`, readOnly: !CONNECTOR_WRITE_TOOLS.has(tool) })),
  }) : null).filter(Boolean);
  const catalog = [...getHivemindToolCatalog(), ...connectorCatalog];
  capabilityCache.set(key, { expiresAt: Date.now() + 30_000, catalog });
  return catalog;
}

/** Singleton pool — one per process. */
let _pool = null;
function getPool(prisma) {
  if (!_pool) _pool = new McpClientPool({ prisma });
  return _pool;
}

/**
 * Build a Toolkit for one chat turn.
 * @param {{ prisma, userId, orgId, hivemindTools? }} args
 *   hivemindTools: array of { name, description, parameters, handler, readOnly }
 *                  for the existing HIVEMIND-internal tools.
 * @returns {Promise<Toolkit>}
 */
export async function buildToolkitForUser({ prisma, userId, orgId, hivemindTools = [], persistentMemoryEngine = null, selectedGroups = [] }) {
  const tk = new Toolkit();
  const selected = new Set(selectedGroups);

  // Native HIVEMIND tools use the same AgentScope-style group contract as
  // connectors. Groups remain inactive until selected for this turn.
  registerHivemindTools(tk, { selectedGroups });

  // 1. Register HIVEMIND-internal tools into 'basic' group (always active).
  for (const t of hivemindTools) {
    tk.registerToolFunction({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      handler: t.handler,
      groupName: 'basic',
      readOnly: t.readOnly !== false,
    });
  }

  // 2. Meta tool.
  registerMetaTool(tk);

  // 3. Middleware (order matters — registered first runs outermost).
  tk.registerMiddleware(createDraftApprovalMiddleware({ prisma }));
  tk.registerMiddleware(createMemoryTapMiddleware());

  // 4. Auto-register connector groups when the user has a live Nango
  //    connection for them. Two flavours:
  //      (a) MCP-backed (slack, notion, github, linear) — tools come from
  //          the provider's MCP server via the persistent client pool.
  //      (b) Nango-REST-backed (gmail, google-docs, google-gemini) — tools
  //          registered as plain handler functions that proxy through the
  //          Nango credentials helper.
  //
  //    All groups stay INACTIVE until the agent explicitly activates via
  //    reset_equipped_tools. This keeps the primary system prompt small
  //    and avoids LLM dilemma/hallucination from a tool-flood.
  if (prisma?.nangoConnection) {
    try {
      const connections = await prisma.nangoConnection.findMany({
        where: { userId, orgId, status: 'active' },
        select: { providerKey: true },
      });
      const activeProviders = new Set(connections.map(c => c.providerKey));
      const pool = getPool(prisma);

      // Connector Runtime V1 (plan Phase 8 Chat cutover) — flag-gated, default
      // OFF → the legacy registration below runs UNCHANGED. When on, connectors
      // the runtime knows are registered in-process via the runtime adapter;
      // the rest fall through to the legacy path (per-connector, no drops).
      const _runtimeHandled = new Set();
      if (process.env.CONNECTOR_RUNTIME_CHAT === 'true' && globalThis.__hivemindConnectorRuntime) {
        try {
          const { registerRuntimeConnectorGroups } = await import('./runtime-toolkit-adapter.js');
          const handled = registerRuntimeConnectorGroups({
            tk, runtime: globalThis.__hivemindConnectorRuntime, prisma,
            userId, orgId, projectId: (typeof projectId !== 'undefined' ? projectId : null),
            selected, activeProviders,
          });
          for (const id of handled) _runtimeHandled.add(id);
        } catch (err) {
          console.warn(`[toolkit] runtime connector registration failed: ${err.message}`);
        }
      }
      // legacy provider key → runtime connector id (to skip handled ones)
      const _RT_MAP = { gmail: 'gmail', 'google-docs': 'google_docs', 'google-sheets': 'google_sheets', slack: 'slack' };

      // (a) MCP groups.
      for (const provider of MCP_CONNECTOR_GROUPS) {
        if (_runtimeHandled.has(_RT_MAP[provider] || provider)) continue;
        if (!selected.has(provider)) continue;
        if (!activeProviders.has(provider)) continue;
        tk.createToolGroup({
          name: provider,
          description: `${provider} live tools via MCP (read + write).`,
          active: false,
          notes: `${provider}: live read/write through provider MCP. Activate via reset_equipped_tools when query intent matches ${provider}. Write tools (post/send/schedule) go through draft-approval — user must Approve before send.`,
        });
        try {
          const client = await pool.resolve(userId, orgId, provider);
          await tk.registerMcpClient(client, { groupName: provider });
        } catch (err) {
          // MCP server unreachable or app not enabled — keep group empty.
          console.warn(`[toolkit] mcp register ${provider} failed: ${err.message}`);
        }
      }

      // (b) Nango-REST groups (gmail / google-docs / google-gemini).
      for (const cfg of NANGO_REST_GROUPS) {
        if (_runtimeHandled.has(_RT_MAP[cfg.provider] || cfg.provider)) continue;
        if (!selected.has(cfg.groupName)) continue;
        if (!activeProviders.has(cfg.provider)) continue;
        try {
          cfg.register(tk, { persistentMemoryEngine });
          tk.markGroupExternal(cfg.groupName);
        } catch (err) {
          console.warn(`[toolkit] rest register ${cfg.groupName} failed: ${err.message}`);
        }
      }
    } catch (err) {
      console.warn(`[toolkit] connector enumeration failed: ${err.message}`);
    }
  }

  // 5. Native Slack group — registered whenever the user has Slack connected
  //    through EITHER auth generation: the native OAuth row
  //    (platformIntegration) or a legacy Nango connection. Token resolution
  //    happens lazily per tool call inside SlackBridge/ConnectorStore, so
  //    registration is just two cheap indexed lookups.
  if (selected.has('slack') && prisma?.platformIntegration) {
    try {
      const [nativeRow, nangoRow] = await Promise.all([
        prisma.platformIntegration.findUnique({
          where: { userId_platformType: { userId, platformType: 'slack' } },
          select: { isActive: true },
        }).catch(() => null),
        prisma.nangoConnection?.findFirst({
          where: { userId, orgId, providerKey: 'slack', status: 'active' },
          select: { id: true },
        }).catch(() => null),
      ]);
      if (nativeRow?.isActive || nangoRow) {
        const { ConnectorStore } = await import('../connectors/framework/connector-store.js');
        registerSlackTools(tk, { connectorStore: new ConnectorStore(prisma), userId });
        tk.markGroupExternal('slack');
      }
    } catch (err) {
      console.warn(`[toolkit] slack native register failed: ${err.message}`);
    }
  }

  return tk;
}

export { MCP_CONNECTOR_GROUPS, NANGO_REST_GROUPS };
// Back-compat re-export.
export const CONNECTOR_GROUPS = [...MCP_CONNECTOR_GROUPS, ...NANGO_REST_GROUPS.map(g => g.groupName)];
