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

const CONNECTOR_GROUPS = ['slack', 'notion', 'github', 'linear'];

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
export async function buildToolkitForUser({ prisma, userId, orgId, hivemindTools = [] }) {
  const tk = new Toolkit();

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

  // 4. Auto-register connector MCP groups when the user has a live
  //    Nango connection for them. Groups stay INACTIVE until the agent
  //    explicitly activates via reset_equipped_tools.
  if (prisma?.nangoConnection) {
    try {
      const connections = await prisma.nangoConnection.findMany({
        where: { userId, status: 'active' },
        select: { providerKey: true },
      });
      const activeProviders = new Set(connections.map(c => c.providerKey));
      const pool = getPool(prisma);

      for (const provider of CONNECTOR_GROUPS) {
        if (!activeProviders.has(provider)) continue;
        tk.createToolGroup({
          name: provider,
          description: `${provider} live tools via MCP (read + write).`,
          active: false,
          notes: `${provider}: live read/write through provider MCP. Activate via reset_equipped_tools when query intent matches ${provider}. Write tools (post/send/schedule) go through draft-approval — user must Approve before send.`,
        });
        try {
          const client = await pool.resolve(userId, provider);
          await tk.registerMcpClient(client, { groupName: provider });
        } catch (err) {
          // MCP server unreachable or app not enabled — keep group empty.
          console.warn(`[toolkit] mcp register ${provider} failed: ${err.message}`);
        }
      }
    } catch (err) {
      console.warn(`[toolkit] connector enumeration failed: ${err.message}`);
    }
  }

  return tk;
}

export { CONNECTOR_GROUPS };
