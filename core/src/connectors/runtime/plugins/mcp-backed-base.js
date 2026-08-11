// Connector Runtime V1 — shared base for MCP-backed / bridge-backed connectors.
//
// notion / github / linear (external MCP) and slack (internal bridge) all
// execute through the ONE existing implementation: MCPIngestionService.
// executeTool(name, operation, scope) — which resolves the endpoint (external
// MCP server or the internal native bridge), runs the call, and returns an
// MCP-shaped result ({content:[{type:'text',...}]}). This base wraps that so
// each provider is its own small script supplying a manifest + tool map.
//
// The MCP executor is injected (defaults to the process singleton
// globalThis.__hivemindMcpIngestionService) so the plugin unit-tests with a fake
// — no external MCP server, no Slack workspace.

import { ConnectorPlugin } from '../connector-plugin.js';
import { makeResult, jsonContent, textContent } from '../contracts.js';
import { NotConnectedError, ReauthRequiredError, classifyError } from '../errors.js';

export class McpBackedPlugin extends ConnectorPlugin {
  /**
   * @param {object} manifest
   * @param {Record<string,string>} toolMap canonical name → provider tool name (the MCP operation.name)
   * @param {object} [deps] { mcpExec: (name, operation, scope) => Promise<{content}>, sourceIdsFor }
   */
  constructor(manifest, toolMap, deps = {}) {
    super(manifest);
    this._map = toolMap;
    this._mcpExec = deps.mcpExec || null; // resolved lazily from globalThis if absent
    this._sourceIdsFor = deps.sourceIdsFor || (() => []);
  }

  _exec() {
    if (this._mcpExec) return this._mcpExec;
    const svc = (typeof globalThis !== 'undefined' && globalThis.__hivemindMcpIngestionService) || null;
    if (svc && typeof svc.executeTool === 'function') return (name, op, scope) => svc.executeTool(name, op, scope);
    throw new NotConnectedError(`${this.id}: MCP ingestion service unavailable`);
  }

  async executeTool(toolName, input, context) {
    const providerTool = this._map[toolName];
    if (!providerTool) throw new NotConnectedError(`${this.id} tool "${toolName}" is not implemented`);
    const scope = { user_id: context.userId, org_id: context.orgId };
    let raw;
    try {
      raw = await this._exec()(this.id, { type: 'tool', name: providerTool, arguments: input || {} }, scope);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not connected|no .* connection|not found/i.test(msg)) throw new NotConnectedError(`${this.manifest.displayName} is not connected for this user`, { provider: this.id });
      if (/\b401\b|unauthor|invalid_grant|expired/i.test(msg)) throw new ReauthRequiredError(`${this.manifest.displayName} requires re-authorization`, { provider: this.id });
      throw classifyError(err);
    }
    // MCPIngestionService returns { content:[{type:'text',text}] } already MCP-shaped.
    if (raw && Array.isArray(raw.content)) {
      return makeResult({ status: 'completed', content: raw.content, metadata: { sourceIds: this._sourceIdsFor(toolName, raw) } });
    }
    // A raw provider object (or text) → wrap.
    return makeResult({
      status: 'completed',
      content: typeof raw === 'string' ? textContent(raw) : jsonContent(raw == null ? {} : raw),
      metadata: { sourceIds: this._sourceIdsFor(toolName, raw || {}) },
    });
  }
}

export function mcpRead(name, description, inputSchema, providerTool, surfaces = ['chat', 'hyperagents', 'tara', 'mcp', 'admin']) {
  return {
    name, title: name, description, inputSchema,
    access: 'read', approval: 'never',
    concurrencySafe: true, idempotent: true, destructive: false, openWorld: true,
    timeoutMs: 15000, maxResultBytes: 32 * 1024,
    allowedSurfaces: surfaces, legacyName: providerTool,
  };
}
export function mcpWrite(name, description, inputSchema, providerTool, { destructive = false } = {}) {
  return {
    name, title: name, description, inputSchema,
    access: 'write', approval: 'required',
    concurrencySafe: false, idempotent: false, destructive, openWorld: true,
    timeoutMs: 15000, maxResultBytes: 8 * 1024,
    allowedSurfaces: ['chat', 'hyperagents', 'mcp', 'admin'], legacyName: providerTool,
  };
}
