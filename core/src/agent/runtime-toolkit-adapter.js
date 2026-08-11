// Connector Runtime V1 — Chat in-process projection (plan §5 "Core Chat").
//
// When CONNECTOR_RUNTIME_CHAT is on, registers connector groups into the chat
// Toolkit backed by the in-process ConnectorRuntime (NO Core→Core HTTP/MCP —
// plan §5). Preserves the frozen chat contracts:
//   - inactive tool groups (createToolGroup active:false)
//   - markGroupExternal on write-bearing groups so the EXISTING draft-approval
//     middleware still gates writes (draft_created card) — the runtime is told
//     approvalOwnedBySurface:true so it does NOT double-gate.
//   - handler returns the raw provider payload; the Toolkit wraps it into the
//     usual ToolResponse ({content:[{type:'text',text}], status, meta:{raw,...}}).
//
// Connector-wise: only connectors the runtime registry knows are taken here;
// the caller registers the rest via the legacy path (no dropped connector).

// chat provider key (Nango/legacy) → runtime connector id.
// NOTE: slack is deliberately EXCLUDED here — chat Slack stays on the native
// SlackBridge path (different connection source: platformIntegration/native
// OAuth, not the nango activeProviders the runtime adapter checks). Folding
// slack in would risk double-registering the 'slack' group / dropping natively-
// connected users. Slack cutover is handled separately (its own canary).
const PROVIDER_TO_CONNECTOR = Object.freeze({
  gmail: 'gmail',
  'google-docs': 'google_docs',
  'google-sheets': 'google_sheets',
});

function unwrapForToolkit(res) {
  // completed → return the raw payload (json data or text) for the Toolkit to wrap.
  if (res && res.status === 'completed') {
    const block = (res.content || [])[0];
    if (block?.type === 'json') return block.data;
    if (block?.type === 'text') return { text: block.text };
    return res.content;
  }
  // approval_required (should not happen — chat middleware owns writes) or an
  // error status → surface a structured error the agent can read/relay.
  const msg = (res?.content || [])[0]?.text || res?.status || 'connector error';
  return { error: msg, status: res?.status || 'failed', ...(res?.approval ? { approval: res.approval } : {}) };
}

/**
 * Register runtime-backed connector groups into the chat toolkit.
 * @returns {string[]} the runtime connector ids handled (caller does legacy for the rest)
 */
export function registerRuntimeConnectorGroups({
  tk, runtime, prisma, userId, orgId, projectId,
  selected, activeProviders, readOnly = false, trace = null,
}) {
  if (!tk || !runtime) return [];
  const handled = [];
  for (const [providerKey, connectorId] of Object.entries(PROVIDER_TO_CONNECTOR)) {
    // must be: selected for this turn, connected for this user, and known to the runtime
    if (selected && !selected.has(providerKey) && !selected.has(connectorId)) continue;
    if (activeProviders && !activeProviders.has(providerKey)) continue;
    if (!runtime.registry.hasConnector(connectorId)) continue;

    const plugin = runtime.registry.getPlugin(connectorId);
    const tools = plugin.manifest.tools.filter((t) => t.allowedSurfaces.includes('chat')
      && (!readOnly || t.access === 'read'));
    if (!tools.length) continue;

    const hasWrite = tools.some((t) => t.access === 'write');
    tk.createToolGroup({
      name: connectorId,
      description: `${plugin.manifest.displayName} live tools via the connector runtime.`,
      active: false,
      notes: `${connectorId}: canonical runtime tools. Activate via reset_equipped_tools when the query needs ${connectorId}.${hasWrite ? ' Write tools go through draft-approval — user must Approve before send.' : ''}`,
    });

    for (const tool of tools) {
      tk.registerToolFunction({
        name: tool.name, // canonical <connector>__<operation>
        description: tool.description,
        parameters: tool.inputSchema,
        groupName: connectorId,
        readOnly: tool.access === 'read',
        external: true, // draft-approval gate applies to write tools in this group
        handler: async (args, ctx) => {
          const res = await runtime.executeTool(tool.name, args, {
            requestId: (ctx && (ctx._trace?.traceId || ctx.traceId)) || (trace && trace.traceId) || 'chat',
            userId, orgId,
            role: (ctx && ctx.role) || 'member',
            surface: 'chat',
            projectIds: projectId ? [projectId] : [],
            connectionId: (ctx && ctx.connectionId) || undefined,
            db: prisma,
            // chat's draft-approval middleware owns write approval — do not double-gate
            approvalOwnedBySurface: true,
          });
          return unwrapForToolkit(res);
        },
      });
    }
    if (hasWrite) tk.markGroupExternal(connectorId);
    handled.push(connectorId);
  }
  return handled;
}
