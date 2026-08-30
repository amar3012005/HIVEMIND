/**
 * Toolkit — AgentScope-inspired tool manager for HIVEMIND.
 *
 * Manages tool functions, tool groups, middleware, and MCP integration.
 * Designed to sit alongside the existing tool-registry.js (which holds
 * static HIVEMIND tools) and complement it with:
 *   - per-user dynamic MCP tool registration (Slack/Notion/GitHub)
 *   - tool groups (inactive by default, activated by intent)
 *   - middleware pipeline (auth, draft-approval, audit, memory tap)
 *
 * No external deps. Pure JS. Compatible with Groq/OpenAI tool-call format.
 *
 * Key concepts (mirrors AgentScope, but JS):
 *   - tool function:  { name, description, parameters (JSON schema), handler(args, ctx), group, readOnly }
 *   - tool group:     { name, description, active, notes, tools[] }
 *   - middleware:     async (kwargs, next) => yields ToolResponse
 *   - meta tool:      reset_equipped_tools — agent flips group active state
 */

const BASIC_GROUP = 'basic';

// Server-generated controls used by the deterministic chat orchestrator.
// Keep this allowlist narrow: arbitrary underscore-prefixed arguments are
// still rejected and these fields are not exposed in the LLM tool schema.
const TRUSTED_INTERNAL_ARGUMENTS = new Set([
  '_explicit_mode',
  '_structured_intent',
  '_include_full_memory_content',
  '_event_range',
  '_source_id',
  '_original_content',
  'semantic_recovery',
  'allow_semantic_source_recovery',
  'reliability_v1',
]);

export class Toolkit {
  constructor({ logger = console } = {}) {
    this.logger = logger;
    /** @type {Map<string, ToolEntry>} */
    this._tools = new Map();
    /** @type {Map<string, ToolGroup>} */
    this._groups = new Map();
    /** @type {Middleware[]} */
    this._middleware = [];
    // The 'basic' group is always active.
    this.createToolGroup({ name: BASIC_GROUP, description: 'Always-active basic tools.', active: true });
  }

  // ── Tool groups ────────────────────────────────────────────────────────

  createToolGroup({ name, description = '', active = false, notes = '' }) {
    if (!name) throw new Error('group name required');
    if (this._groups.has(name)) return; // idempotent
    this._groups.set(name, { name, description, active, notes, tools: new Set() });
  }

  updateToolGroups({ groupNames = [], active }) {
    for (const n of groupNames) {
      const g = this._groups.get(n);
      if (g) g.active = !!active;
    }
  }

  isGroupActive(name) {
    const g = this._groups.get(name);
    return !!(g && g.active);
  }

  getActivatedNotes() {
    return Array.from(this._groups.values())
      .filter(g => g.active && g.notes)
      .map(g => `[${g.name}] ${g.notes}`)
      .join('\n\n');
  }

  // ── Tool registration ─────────────────────────────────────────────────

  registerToolFunction({
    name,
    description,
    parameters,
    handler,
    groupName = BASIC_GROUP,
    readOnly = true,
    concurrencySafe = true,
    external = false,
    presetKwargs = {},
  }) {
    if (!name || typeof handler !== 'function') {
      throw new Error('name + handler required');
    }
    if (!this._groups.has(groupName)) {
      this.createToolGroup({ name: groupName });
    }
    if (this._tools.has(name)) throw new Error(`duplicate tool name '${name}'`);
    const entry = {
      name,
      description: description || '',
      parameters: parameters || { type: 'object', properties: {} },
      handler,
      groupName,
      readOnly,
      concurrencySafe,
      external,
      presetKwargs,
    };
    this._tools.set(name, entry);
    this._groups.get(groupName).tools.add(name);
  }

  removeToolFunction(name) {
    const t = this._tools.get(name);
    if (!t) return;
    this._tools.delete(name);
    const g = this._groups.get(t.groupName);
    if (g) g.tools.delete(name);
  }

  /**
   * Register all tools exposed by an MCP client into a named group.
   * Calls client.listTools(); for each tool, wraps it as a handler that
   * proxies the JSON-RPC call back through the same client.
   */
  async registerMcpClient(mcpClient, { groupName, readOnlyHint }) {
    if (!mcpClient || typeof mcpClient.listTools !== 'function') {
      throw new Error('mcpClient must expose listTools() + callTool()');
    }
    const tools = await mcpClient.listTools();
    for (const t of tools) {
      const isReadOnly = t.annotations?.readOnlyHint === true
        || (readOnlyHint !== undefined ? readOnlyHint : false);
      this.registerToolFunction({
        name: t.name,
        description: t.description || '',
        parameters: t.inputSchema || { type: 'object', properties: {} },
        groupName,
        readOnly: isReadOnly,
        concurrencySafe: t.annotations?.destructiveHint !== true,
        external: true,
        handler: async (args, _ctx) => {
          return mcpClient.callTool(t.name, args);
        },
      });
    }
    return tools.map(t => t.name);
  }

  removeToolsFromGroup(groupName) {
    const g = this._groups.get(groupName);
    if (!g) return 0;
    let n = 0;
    for (const name of Array.from(g.tools)) {
      this._tools.delete(name);
      g.tools.delete(name);
      n++;
    }
    return n;
  }

  // ── Middleware ─────────────────────────────────────────────────────────

  registerMiddleware(fn) {
    if (typeof fn !== 'function') throw new Error('middleware must be a function');
    this._middleware.push(fn);
  }

  markGroupExternal(groupName) {
    const group = this._groups.get(groupName);
    if (!group) return;
    for (const name of group.tools) {
      const tool = this._tools.get(name);
      if (tool) tool.external = true;
    }
  }

  // ── Schemas + execution ───────────────────────────────────────────────

  /**
   * JSON schemas of currently active tools — OpenAI/Groq function-call format.
   */
  getJsonSchemas({ readOnlyOnly = false } = {}) {
    const out = [];
    for (const t of this._tools.values()) {
      const g = this._groups.get(t.groupName);
      if (!g?.active) continue;
      if (readOnlyOnly && !t.readOnly) continue;
      out.push({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      });
    }
    return out;
  }

  getActiveToolNames(options) {
    return this.getJsonSchemas(options).map(s => s.function.name);
  }

  /** AgentScope-style capability catalog for the intent parser. */
  getToolGroupCatalog({ includeInactive = true } = {}) {
    return Array.from(this._groups.values())
      .filter((group) => includeInactive || group.active)
      .map((group) => ({
        name: group.name,
        description: group.description,
        active: group.active,
        tools: Array.from(group.tools)
          .map((name) => this._tools.get(name))
          .filter(Boolean)
          .map((tool) => ({
            name: tool.name,
            description: tool.description,
            readOnly: tool.readOnly,
            concurrencySafe: tool.concurrencySafe,
            external: tool.external,
          })),
      }))
      .filter((group) => group.tools.length > 0);
  }

  hasTool(name) {
    return this._tools.has(name);
  }

  /**
   * Execute a tool through the middleware chain.
   * Returns a ToolResponse: { content: [{ type: 'text', text }], status, meta }
   */
  async execute(name, args, ctx = {}, { trustedInternalArgs = false } = {}) {
    const tool = this._tools.get(name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `tool '${name}' not found` }],
        status: 'error',
      };
    }
    const g = this._groups.get(tool.groupName);
    if (!g?.active) {
      return {
        content: [{ type: 'text', text: `tool '${name}' is in inactive group '${tool.groupName}'` }],
        status: 'error',
      };
    }

    const supplied = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    const properties = tool.parameters?.properties || {};
    const required = tool.parameters?.required || [];
    const unknown = Object.keys(supplied).filter((key) => {
      if (key === '_approval_token' && ctx?._approvalFlow === true) return false;
      if (trustedInternalArgs && TRUSTED_INTERNAL_ARGUMENTS.has(key)) return false;
      return !(key in properties) && !(key in tool.presetKwargs);
    });
    if (unknown.length) {
      return { content: [{ type: 'text', text: `invalid arguments: unknown field(s) ${unknown.join(', ')}` }], status: 'error', meta: { error: 'invalid_arguments' } };
    }
    const merged = { ...supplied, ...tool.presetKwargs };
    const missing = required.filter((key) => merged[key] === undefined || merged[key] === null || merged[key] === '');
    if (missing.length) {
      return { content: [{ type: 'text', text: `invalid arguments: missing field(s) ${missing.join(', ')}` }], status: 'error', meta: { error: 'invalid_arguments' } };
    }
    const kwargs = { tool_call: { name, input: merged, tool }, args: merged, ctx };

    const baseHandler = async (k) => {
      try {
        const raw = await tool.handler(k.args, k.ctx);
        return {
          content: typeof raw === 'string'
            ? [{ type: 'text', text: raw }]
            : Array.isArray(raw?.content) ? raw.content
            : [{ type: 'text', text: (typeof raw === 'object' ? JSON.stringify(raw) : String(raw)).slice(0, 16000) }],
          status: raw?.status || 'ok',
          meta: { raw, readOnly: tool.readOnly },
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `tool error: ${err.message}` }],
          status: 'error',
          meta: { error: err.message, readOnly: tool.readOnly },
        };
      }
    };

    // Compose middleware in registration order — onion model.
    // pre runs forward, post runs in reverse via the unwound stack.
    let next = baseHandler;
    for (let i = this._middleware.length - 1; i >= 0; i--) {
      const mw = this._middleware[i];
      const innerNext = next;
      next = (k) => mw(k, innerNext);
    }
    return await next(kwargs);
  }

  /**
   * Meta tool: agent activates / deactivates groups itself.
   * Returns the notes for the newly active groups so the agent has guidance.
   */
  resetEquippedTools(groupNames = []) {
    // Deactivate everything EXCEPT basic.
    for (const g of this._groups.values()) {
      if (g.name !== BASIC_GROUP) g.active = false;
    }
    // Activate the requested ones.
    this.updateToolGroups({ groupNames, active: true });
    return {
      activated: groupNames.filter(n => this.isGroupActive(n)),
      tools: this.getActiveToolNames(),
      notes: this.getActivatedNotes(),
    };
  }
}

/** Convenience: registers the meta tool on a Toolkit. */
export function registerMetaTool(toolkit) {
  toolkit.registerToolFunction({
    name: 'reset_equipped_tools',
    description:
      'Activate or deactivate tool groups at runtime. Pass the group_names you want active; all others (except basic) become inactive. Returns the new set of available tools.',
    parameters: {
      type: 'object',
      properties: {
        group_names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Group names to activate, e.g. ["slack", "notion"].',
        },
      },
      required: ['group_names'],
    },
    readOnly: true,
    handler: async (args) => toolkit.resetEquippedTools(args.group_names || []),
  });
}
